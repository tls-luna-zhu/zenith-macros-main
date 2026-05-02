from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Lock
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from flask import Blueprint, Response, current_app, jsonify, make_response, redirect, request, send_file, stream_with_context

from database import db
from models import License, Product, UserEntitlement
from utils.audit import audit_event
from utils.rate_limiter import get_limiter
from utils.discord_roles import grant_customer_role, revoke_customer_role, grant_standalone_role

web_bp = Blueprint('web_compat', __name__)

_dashboard_sessions: dict[str, dict] = {}
_dashboard_resets: dict[str, float] = {}
_pending_auth_tokens: dict[str, dict] = {}
_release_cache: dict[str, object] = {'ts_ms': 0, 'data': None}
# Cache: filename -> (asset_id, fetched_at_ms)
_asset_id_cache: dict[str, tuple[int, int]] = {}
_state_lock = Lock()
_DASHBOARD_SESSION_MAX_TTL_MS = 24 * 60 * 60 * 1000
_PENDING_AUTH_TTL_MS = 3 * 60 * 1000


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _unix_ms() -> int:
    return int(time.time() * 1000)


def _client_ip() -> str:
    forwarded = request.headers.get('X-Forwarded-For', '')
    if forwarded:
        return forwarded.split(',')[0].strip()
    return request.remote_addr or '0.0.0.0'


def _website_root() -> Path:
    # Support both local repo layout (.../backend/web/routes.py -> repo/website)
    # and container layout (/app/web/routes.py -> /app/website).
    explicit = str(current_app.config.get('WEBSITE_ROOT', '')).strip()
    if explicit:
        root = Path(explicit)
        if root.exists():
            return root

    here = Path(__file__).resolve()
    candidates = [
        here.parents[2] / 'website' / 'public',
        here.parents[1] / 'website' / 'public',
        Path('/app/website/public'),
        here.parents[2] / 'website',
        here.parents[1] / 'website',
        Path('/app/website'),
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


def _safe_web_path(path_text: str) -> Path | None:
    root = _website_root().resolve()
    target = (root / path_text).resolve()
    if not str(target).startswith(str(root)):
        return None
    return target


def _cleanup_state() -> None:
    now = _unix_ms()
    with _state_lock:
        dead_sessions = [sid for sid, row in _dashboard_sessions.items() if int(row.get('expires_at_ms', 0)) <= now]
        for sid in dead_sessions:
            _dashboard_sessions.pop(sid, None)

        dead_pending = [t for t, row in _pending_auth_tokens.items() if int(row.get('exp', 0)) <= now]
        for t in dead_pending:
            _pending_auth_tokens.pop(t, None)

        cooldown_window = 24 * 60 * 60 * 1000
        dead_resets = [rid for rid, ts in _dashboard_resets.items() if int(ts) + cooldown_window <= now]
        for rid in dead_resets:
            _dashboard_resets.pop(rid, None)


def _session_secret() -> str:
    return str(current_app.config.get('DASHBOARD_SESSION_SECRET') or current_app.config.get('SECRET_KEY') or '')


def _session_sig(payload: str) -> str:
    secret = _session_secret()
    return hmac.new(secret.encode('utf-8'), payload.encode('utf-8'), hashlib.sha256).hexdigest()


def _build_session_token(session_id: str, session_row: dict | None = None) -> str:
    if session_row:
        payload_obj = {
            'sid': str(session_id or ''),
            'exp': int(session_row.get('expires_at_ms', 0)),
            'user': session_row.get('user') or {},
            'v': 2,
        }
        packed = json.dumps(payload_obj, separators=(',', ':'), ensure_ascii=False)
        payload = base64.urlsafe_b64encode(packed.encode('utf-8')).decode('ascii').rstrip('=')
    else:
        payload = str(session_id or '')
    return f'{payload}.{_session_sig(payload)}'


def _verify_session_token(token: str) -> str | None:
    raw = str(token or '')
    if '.' not in raw:
        return None
    payload, sig = raw.rsplit('.', 1)
    expected = _session_sig(payload)
    if not hmac.compare_digest(sig, expected):
        return None
    return payload


def _pack_signed_json(payload_obj: dict) -> str:
    packed = json.dumps(payload_obj, separators=(',', ':'), ensure_ascii=False)
    payload = base64.urlsafe_b64encode(packed.encode('utf-8')).decode('ascii').rstrip('=')
    return f'{payload}.{_session_sig(payload)}'


def _unpack_signed_json(token: str) -> dict | None:
    payload = _verify_session_token(token)
    if not payload:
        return None
    try:
        padded = payload + ('=' * ((4 - len(payload) % 4) % 4))
        unpacked = base64.urlsafe_b64decode(padded.encode('ascii')).decode('utf-8')
        data = json.loads(unpacked)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    return data


def _decode_session_payload(token: str) -> dict | None:
    payload = _verify_session_token(token)
    if not payload:
        return None
    try:
        padded = payload + ('=' * ((4 - len(payload) % 4) % 4))
        unpacked = base64.urlsafe_b64decode(padded.encode('ascii')).decode('utf-8')
        data = json.loads(unpacked)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    if int(data.get('v', 0)) != 2:
        return None
    exp = int(data.get('exp', 0))
    user = data.get('user') or {}
    if exp <= 0 or not isinstance(user, dict):
        return None
    return {
        'sid': str(data.get('sid') or ''),
        'expires_at_ms': exp,
        'user': user,
    }


def _set_dashboard_cookie(response, token: str) -> None:
    ttl_ms = min(int(current_app.config.get('DASHBOARD_SESSION_TTL_MS', _DASHBOARD_SESSION_MAX_TTL_MS)), _DASHBOARD_SESSION_MAX_TTL_MS)
    # Always Secure in production — ProxyFix handles X-Forwarded-Proto,
    # but some proxies strip it; force True when SITE_URL is https.
    site_url = str(current_app.config.get('SITE_URL', ''))
    secure_cookie = request.is_secure or site_url.startswith('https')
    response.set_cookie(
        str(current_app.config.get('DASHBOARD_COOKIE_NAME', 'zenith_dash')),
        token,
        max_age=max(60, ttl_ms // 1000),
        httponly=True,
        secure=secure_cookie,
        samesite='Lax',
        path='/',
    )


def _clear_dashboard_cookie(response) -> None:
    site_url = str(current_app.config.get('SITE_URL', ''))
    secure_cookie = request.is_secure or site_url.startswith('https')
    response.set_cookie(
        str(current_app.config.get('DASHBOARD_COOKIE_NAME', 'zenith_dash')),
        '',
        max_age=0,
        httponly=True,
        secure=secure_cookie,
        samesite='Lax',
        path='/',
    )


def _dashboard_session() -> tuple[str, dict] | tuple[None, None]:
    _cleanup_state()
    cookie_name = str(current_app.config.get('DASHBOARD_COOKIE_NAME', 'zenith_dash'))
    raw = request.cookies.get(cookie_name, '')

    # Fallback: Authorization: Bearer <signed-token> (localStorage-based auth).
    # Cloudflare can strip Set-Cookie from responses, so the frontend stores
    # the token in localStorage and sends it as a Bearer header instead.
    if not raw:
        auth_hdr = request.headers.get('Authorization', '')
        if auth_hdr.startswith('Bearer '):
            raw = auth_hdr[7:].strip()

    now = _unix_ms()

    decoded = _decode_session_payload(raw)
    if decoded:
        if int(decoded.get('expires_at_ms', 0)) <= now:
            return None, None
        sid = str(decoded.get('sid') or '')
        row = {
            'expires_at_ms': int(decoded.get('expires_at_ms', 0)),
            'user': decoded.get('user') or {},
        }
        return sid, row

    return None, None


def _dashboard_user_or_401():
    session_id, row = _dashboard_session()
    if not session_id or not row:
        return None, (jsonify({'ok': False, 'error': 'Not authenticated'}), 401)
    return row.get('user') or {}, None


def _safe_next_path(raw: str) -> str:
    text = str(raw or '').strip()
    if not text:
        return '/dashboard.html?auth=ok'
    if not text.startswith('/') or text.startswith('//'):
        return '/dashboard.html?auth=ok'
    lowered = text.lower()
    if lowered.startswith('/auth/discord') or lowered.startswith('/api/auth/discord'):
        return '/dashboard.html?auth=ok'
    return text[:300]


def _build_oauth_state(next_path: str) -> str:
    # [SECURITY HARDENING] Stateless signed OAuth state avoids in-memory
    # callback mismatches across workers while preserving CSRF integrity.
    payload = {
        'v': 1,
        'n': secrets.token_hex(12),
        'next': _safe_next_path(next_path),
        'exp': _unix_ms() + (10 * 60 * 1000),
    }
    return _pack_signed_json(payload)


def _read_oauth_state(raw_state: str) -> dict | None:
    payload = _unpack_signed_json(raw_state)
    if not payload:
        return None
    if int(payload.get('v', 0)) != 1:
        return None
    exp = int(payload.get('exp', 0))
    if exp <= _unix_ms():
        return None
    nonce = str(payload.get('n') or '').strip()
    if len(nonce) < 8:
        return None
    return {'next': _safe_next_path(payload.get('next', '/dashboard.html?auth=ok'))}


def _discord_oauth_ready() -> bool:
    return bool(
        str(current_app.config.get('DISCORD_OAUTH_CLIENT_ID', '')).strip()
        and str(current_app.config.get('DISCORD_OAUTH_CLIENT_SECRET', '')).strip()
        and _session_secret()
    )


def _json_from_url(req: Request) -> dict:
    with urlopen(req, timeout=12) as resp:  # nosec B310: fixed allow-listed HTTPS endpoint.
        body = resp.read().decode('utf-8', errors='replace')
    return json.loads(body or '{}')


_DISCORD_UA = 'Mozilla/5.0 (compatible; ZenithMacros/1.2; +https://zenithmacros.store)'


def _exchange_discord_code(code: str) -> dict | None:
    body = urlencode({
        'client_id': str(current_app.config.get('DISCORD_OAUTH_CLIENT_ID', '')).strip(),
        'client_secret': str(current_app.config.get('DISCORD_OAUTH_CLIENT_SECRET', '')).strip(),
        'grant_type': 'authorization_code',
        'code': code,
        'redirect_uri': str(current_app.config.get('DISCORD_OAUTH_REDIRECT_URI', '')).strip(),
    }).encode('utf-8')
    req = Request(
        'https://discord.com/api/oauth2/token',
        data=body,
        headers={
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            'User-Agent': _DISCORD_UA,
        },
        method='POST',
    )
    try:
        return _json_from_url(req)
    except HTTPError as exc:
        try:
            payload = (exc.read() or b'').decode('utf-8', errors='replace')
            data = json.loads(payload or '{}')
            if isinstance(data, dict):
                return data
        except Exception:
            pass
        return {'error': f'http_{int(exc.code)}'}
    except Exception as exc:
        try:
            audit_event('web.oauth.token.exception', ip=_client_ip(), error=str(exc)[:180])
        except Exception:
            pass
        return {
            'error': 'exception',
            'error_description': str(exc)[:180],
        }


def _fetch_discord_user(access_token: str) -> dict | None:
    req = Request(
        'https://discord.com/api/users/@me',
        headers={
            'Authorization': f'Bearer {access_token}',
            'Accept': 'application/json',
            'User-Agent': _DISCORD_UA,
        },
        method='GET',
    )
    try:
        return _json_from_url(req)
    except Exception:
        return None


def _mask_key(license_key: str) -> str:
    text = str(license_key or '').strip()
    if len(text) <= 8:
        return text
    return f'{text[:4]}-****-****-{text[-4:]}'


def _is_expired(item: License) -> bool:
    if item.expires_at is None:
        return False
    exp = item.expires_at
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    return _utc_now() > exp


def _license_status(item: License) -> str:
    if bool(item.is_revoked):
        return 'inactive'
    if _is_expired(item):
        return 'expired'
    if item.hwid_hash:
        return 'used'
    return 'active'


def _license_plan(item: License) -> str:
    tier = str(item.tier or 'monthly').strip().lower()
    return tier if tier in {'monthly', 'lifetime'} else 'monthly'


def _license_expires_iso(item: License) -> str | None:
    if item.expires_at is None:
        return None
    exp = item.expires_at
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    return exp.isoformat()


def _license_created_iso(item: License) -> str | None:
    if item.created_at is None:
        return None
    dt = item.created_at
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def _licenses_for_user(user: dict) -> list[License]:
    uid = str(user.get('id') or '').strip()
    email = str(user.get('email') or '').strip().lower()
    if not uid and not email:
        return []

    rows = License.query.order_by(License.id.desc()).limit(5000).all()
    matched: list[License] = []
    for item in rows:
        meta = item.extra_metadata or {}
        linked_id = str(meta.get('discord_id') or meta.get('discordId') or '').strip()
        linked_email = str(meta.get('email') or '').strip().lower()
        if uid and linked_id and linked_id == uid:
            matched.append(item)
            continue
        if email and linked_email and linked_email == email:
            matched.append(item)
            continue
    return matched


def _choose_summary_license(rows: list[License]) -> License | None:
    active = [row for row in rows if (not row.is_revoked) and (not _is_expired(row))]
    return active[0] if active else (rows[0] if rows else None)


def _release_repo() -> str:
    return str(current_app.config.get('GITHUB_RELEASE_REPO', '')).strip()


def _github_release_ready() -> bool:
    return bool(_release_repo() and str(current_app.config.get('GITHUB_TOKEN', '')).strip())


def _resolve_standalone_asset_id(download_ref: str) -> tuple[int, str] | tuple[None, None]:
    """
    Given a download_ref URL like:
      https://github.com/owner/repo/releases/download/vX.Y.Z/ZenithStunSlam.exe
    Return (asset_id, filename) by querying the LATEST GitHub release for that filename.
    Always uses the latest release so no version bump is needed in download_refs.
    Results are cached for 5 minutes.
    """
    import re as _re
    m = _re.search(r'/releases/download/[^/]+/([^/?#]+)$', download_ref)
    if not m:
        # Fallback: treat the ref as a bare filename
        filename = download_ref.rsplit('/', 1)[-1]
        if not filename:
            return None, None
    else:
        filename = m.group(1)

    now = _unix_ms()
    cached = _asset_id_cache.get(filename)
    if cached and (now - cached[1]) < 300_000:
        return cached[0], filename

    repo = _release_repo()
    if not repo:
        return None, None
    try:
        # First check the latest release — ideal path for the main EXE.
        req = _github_api_request(
            f'https://api.github.com/repos/{repo}/releases/latest'
        )
        payload = _json_from_url(req)
        for asset in payload.get('assets') or []:
            if asset.get('name', '').lower() == filename.lower():
                asset_id = int(asset.get('id') or 0)
                if asset_id:
                    _asset_id_cache[filename] = (asset_id, now)
                    return asset_id, filename

        # Standalone EXEs may live in an older release (not always re-published
        # with every main-app release).  Search the 10 most recent releases so
        # users always get a working download even when the file isn't in the
        # latest release tag.
        req2 = _github_api_request(
            f'https://api.github.com/repos/{repo}/releases?per_page=10'
        )
        releases = _json_from_url(req2)
        for release in (releases or []):
            for asset in release.get('assets') or []:
                if asset.get('name', '').lower() == filename.lower():
                    asset_id = int(asset.get('id') or 0)
                    if asset_id:
                        _asset_id_cache[filename] = (asset_id, now)
                        return asset_id, filename
    except Exception:
        pass
    return None, None


def _release_asset_preferred_name() -> str:
    return str(current_app.config.get('RELEASE_ASSET_NAME', '')).strip().lower()


def _github_api_request(url: str, *, accept: str = 'application/vnd.github+json'):
    token = str(current_app.config.get('GITHUB_TOKEN', '')).strip()
    headers = {
        'Accept': accept,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'zenithmacros-release-broker',
    }
    if token:
        headers['Authorization'] = f'Bearer {token}'
    return Request(url, headers=headers, method='GET')


def _pick_release_asset(assets: list[dict]) -> dict | None:
    if not assets:
        return None
    preferred_name = _release_asset_preferred_name()
    if preferred_name:
        for asset in assets:
            if str(asset.get('name') or '').strip().lower() == preferred_name:
                return asset

    # Prefer the portable exe over installers/setup exes
    for asset in assets:
        name = str(asset.get('name') or '').strip().lower()
        if 'portable' in name and name.endswith('.exe'):
            return asset

    for suffix in ('.exe', '.zip', '.msi'):
        for asset in assets:
            name = str(asset.get('name') or '').strip().lower()
            # Skip setup/installer exes — only use them as last resort
            if name.endswith(suffix) and not any(x in name for x in ('setup', 'install', 'nsis')):
                return asset

    # Last resort: any exe
    for asset in assets:
        name = str(asset.get('name') or '').strip().lower()
        if name.endswith('.exe'):
            return asset

    return assets[0]


def _latest_release_data() -> dict | None:
    if not _github_release_ready():
        return None

    now = _unix_ms()
    cached = _release_cache.get('data')
    cache_ts = int(_release_cache.get('ts_ms') or 0)
    if cached and (now - cache_ts) < 30_000:
        return cached  # type: ignore[return-value]

    repo = _release_repo()
    req = _github_api_request(f'https://api.github.com/repos/{repo}/releases/latest')
    try:
        payload = _json_from_url(req)
    except Exception:
        return None

    assets = payload.get('assets') or []
    if not isinstance(assets, list):
        return None
    asset = _pick_release_asset(assets)
    if not asset:
        return None

    data = {
        'version': str(payload.get('tag_name') or payload.get('name') or '').strip(),
        'publishedAt': str(payload.get('published_at') or '').strip(),
        'releaseName': str(payload.get('name') or '').strip(),
        'releaseNotes': str(payload.get('body') or '').strip()[:2000],
        'assetId': int(asset.get('id') or 0),
        'assetName': str(asset.get('name') or '').strip(),
        'assetSize': int(asset.get('size') or 0),
    }
    if not data['assetId'] or not data['assetName']:
        return None

    _release_cache['ts_ms'] = now
    _release_cache['data'] = data
    return data


def _build_download_link(asset_id: int, asset_name: str) -> str:
    ttl = int(current_app.config.get('DOWNLOAD_URL_TTL_SECONDS', 900))
    exp = _unix_ms() + (max(60, ttl) * 1000)
    token = _pack_signed_json({
        'v': 1,
        'asset_id': int(asset_id),
        'asset_name': str(asset_name),
        'exp': int(exp),
    })
    return f'/api/client/download?token={quote(token, safe="")}'


def _bot_api_authorized() -> bool:
    bearer = request.headers.get('Authorization', '').replace('Bearer ', '').strip()
    alt = request.headers.get('X-API-Token', '').strip()
    legacy = request.headers.get('x-bot-secret', '').strip()
    expected = str(current_app.config.get('BOT_API_TOKEN', '')).strip()
    secret = str(current_app.config.get('BOT_API_SECRET', expected)).strip()
    for value in (bearer, alt, legacy):
        if value and expected and hmac.compare_digest(value, expected):
            return True
        if value and secret and hmac.compare_digest(value, secret):
            return True
    return False


def _rate_limit(name: str, limit: int) -> bool:
    limiter = get_limiter()
    ip = _client_ip()
    if not limiter.check_and_record(f'web:{name}:{ip}', max(5, int(limit)), 60):
        return False
    return limiter.check_and_record(f'web:global:{ip}', int(current_app.config.get('GLOBAL_RPM', 60)), 60)


@web_bp.route('/auth/discord/start', methods=['GET'])
@web_bp.route('/api/auth/discord/start', methods=['GET'])
def discord_start():
    if not _rate_limit('discord_start', 90):
        return jsonify({'ok': False, 'error': 'Too many requests'}), 429
    next_path = _safe_next_path(request.args.get('next', ''))
    # [SECURITY HARDENING] If an authenticated dashboard session already
    # exists, avoid unnecessary OAuth loops and bounce straight to target.
    existing_sid, existing_row = _dashboard_session()
    if existing_sid and existing_row:
        return redirect(next_path, code=302)

    if not _discord_oauth_ready():
        return make_response('Discord OAuth is not configured yet.', 503)

    state = _build_oauth_state(next_path)

    query = urlencode({
        'client_id': str(current_app.config.get('DISCORD_OAUTH_CLIENT_ID', '')).strip(),
        'response_type': 'code',
        'redirect_uri': str(current_app.config.get('DISCORD_OAUTH_REDIRECT_URI', '')).strip(),
        'scope': 'identify email',
        'prompt': 'consent',
        'state': state,
    })
    audit_event('web.oauth.start', ip=_client_ip())
    return redirect(f'https://discord.com/api/oauth2/authorize?{query}', code=302)


@web_bp.route('/auth/discord/callback', methods=['GET'])
@web_bp.route('/api/auth/discord/callback', methods=['GET'])
def discord_callback():
    if not _rate_limit('discord_callback', 90):
        return redirect('/?auth=failed&reason=rate_limit', code=302)
    if not _discord_oauth_ready():
        return redirect('/?auth=failed&reason=oauth_not_configured', code=302)

    err_name = str(request.args.get('error') or '').strip().lower()
    if err_name:
        if err_name == 'access_denied':
            return redirect('/?auth=declined', code=302)
        return redirect('/?auth=failed', code=302)

    code = str(request.args.get('code') or '').strip()
    state = str(request.args.get('state') or '').strip()
    if not code or not state:
        return redirect('/?auth=failed&reason=missing_code_or_state', code=302)

    state_row = _read_oauth_state(state)
    if not state_row:
        return redirect('/?auth=failed&reason=invalid_or_expired_state', code=302)

    token_json = _exchange_discord_code(code)
    access_token = str((token_json or {}).get('access_token') or '').strip()
    if not access_token:
        token_err = str((token_json or {}).get('error') or '').strip().lower()
        token_desc = str((token_json or {}).get('error_description') or '').strip().lower()
        try:
            audit_event(
                'web.oauth.token.failed',
                ip=_client_ip(),
                token_error=token_err[:80] if token_err else '',
                token_desc=token_desc[:120] if token_desc else '',
            )
        except Exception:
            pass
        if token_err:
            reason = f'token_exchange_failed_{token_err}'
        elif token_desc:
            reason = f'token_exchange_failed_{token_desc.replace(" ", "_")[:80]}'
        else:
            reason = 'token_exchange_failed'
        reason = ''.join(ch for ch in reason if ch.isalnum() or ch in {'_', '-'})
        return redirect(f'/?auth=failed&reason={reason}', code=302)

    user_json = _fetch_discord_user(access_token) or {}
    user_id = str(user_json.get('id') or '').strip()
    if not user_id:
        return redirect('/?auth=failed&reason=user_fetch_failed', code=302)

    avatar_hash = str(user_json.get('avatar') or '').strip()
    if avatar_hash:
        avatar_url = f'https://cdn.discordapp.com/avatars/{user_id}/{avatar_hash}.png?size=256'
    else:
        try:
            avatar_index = int(user_id) % 5
        except ValueError:
            avatar_index = 0
        avatar_url = f'https://cdn.discordapp.com/embed/avatars/{avatar_index}.png'

    ttl_ms = min(int(current_app.config.get('DASHBOARD_SESSION_TTL_MS', _DASHBOARD_SESSION_MAX_TTL_MS)), _DASHBOARD_SESSION_MAX_TTL_MS)
    session_id = secrets.token_hex(32)
    session_data = {
        'expires_at_ms': _unix_ms() + ttl_ms,
        'user': {
            'id': user_id,
            'username': str(user_json.get('username') or 'Unknown'),
            'globalName': str(user_json.get('global_name') or ''),
            'email': str(user_json.get('email') or '').strip().lower(),
            'avatarUrl': avatar_url,
        },
    }
    # Directly write the session token into localStorage via an HTML response.
    # All redirect + cookie approaches fail here because Cloudflare strips
    # Set-Cookie headers from redirects, and query-parameter tokens can be
    # dropped by intermediate caches.  Serving a plain HTML page that injects
    # the token through JavaScript is the only approach that is 100% reliable
    # regardless of proxy / CDN configuration.
    cookie_token = _build_session_token(session_id, session_data)
    token_js = json.dumps(cookie_token)   # safe JSON string literal for inline <script>
    next_path = _safe_next_path(state_row.get('next', '/dashboard.html'))
    next_js = json.dumps(next_path)

    html = (
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Signing in\u2026</title>'
        '<style>*{margin:0;padding:0;box-sizing:border-box}'
        'body{background:#0a0a0b;color:#ccc;display:flex;align-items:center;'
        'justify-content:center;min-height:100vh;font-family:system-ui}'
        '.w{text-align:center}.s{width:42px;height:42px;border:3px solid #222;'
        'border-top-color:#7c3aed;border-radius:50%;animation:sp .8s linear infinite;'
        'margin:0 auto 14px}@keyframes sp{to{transform:rotate(360deg)}}'
        'p{font-size:14px;opacity:.7}</style></head>'
        '<body><div class="w"><div class="s"></div><p>Signing you in\u2026</p></div>'
        '<script>(function(){'
        f'try{{localStorage.setItem("zdash_tok",{token_js});}}catch(e){{}}'
        f'window.location.replace({next_js});'
        '})();</script></body></html>'
    )
    resp = make_response(html, 200)
    resp.headers['Content-Type'] = 'text/html; charset=utf-8'
    resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate'
    resp.headers['Pragma'] = 'no-cache'
    # Also set cookie as belt-and-suspenders fallback for browsers that block localStorage.
    _set_dashboard_cookie(resp, cookie_token)
    audit_event('web.oauth.callback.ok', ip=_client_ip())
    return resp


@web_bp.route('/api/auth/activate', methods=['GET'])
def auth_activate():
    raw_token = str(request.args.get('t') or '').strip()
    if not raw_token:
        return jsonify({'ok': False, 'error': 'Missing token'}), 400

    _cleanup_state()
    with _state_lock:
        pending = _pending_auth_tokens.pop(raw_token, None)

    if not pending or int(pending.get('exp', 0)) <= _unix_ms():
        return jsonify({'ok': False, 'error': 'Invalid or expired token. Please log in again.'}), 401

    session_id = str(pending['session_id'])
    session_data = dict(pending['session_data'])

    user = session_data.get('user', {})
    cookie_token = _build_session_token(session_id, session_data)
    response = jsonify({'ok': True, 'user': user, 'token': cookie_token})
    _set_dashboard_cookie(response, cookie_token)
    return response


@web_bp.route('/api/dashboard/logout', methods=['POST'])
def dashboard_logout():
    response = jsonify({'ok': True})
    _clear_dashboard_cookie(response)
    return response, 200


@web_bp.route('/api/dashboard/me', methods=['GET'])
def dashboard_me():
    user, err = _dashboard_user_or_401()
    if err:
        return err
    rows = _licenses_for_user(user)
    active = _choose_summary_license(rows)
    summary = None
    if active is not None and not active.is_revoked and not _is_expired(active):
        plan = _license_plan(active)

        # Check Stripe for cancel_at_period_end so the UI can show "Cancels On" + Renew button
        subscription_canceled = False
        cancel_at_iso = None
        if plan == 'monthly':
            stripe_key = str(current_app.config.get('STRIPE_SECRET_KEY', '')).strip()
            customer_id = str((active.extra_metadata or {}).get('stripe_customer', '')).strip()
            if stripe_key and customer_id.startswith('cus_'):
                try:
                    import stripe as _stripe
                    _stripe.api_key = stripe_key
                    subs = _stripe.Subscription.list(customer=customer_id, limit=5, status='all')
                    for sub in (subs.data or []):
                        if sub.status in ('active', 'past_due', 'trialing'):
                            if sub.cancel_at_period_end:
                                subscription_canceled = True
                                if sub.cancel_at:
                                    cancel_at_iso = datetime.fromtimestamp(
                                        int(sub.cancel_at), tz=timezone.utc
                                    ).isoformat()
                            break
                except Exception:
                    pass

        summary = {
            'plan': plan,
            'status': _license_status(active),
            'keyMasked': _mask_key(active.key),
            'keyFull': active.key,
            'hwid': active.hwid_hash or '',
            'expiresAt': _license_expires_iso(active),
            'nextBillingDate': _license_expires_iso(active) if plan == 'monthly' else None,
            'subscriptionCanceled': subscription_canceled,
            'cancelAt': cancel_at_iso,
        }
    return jsonify({'ok': True, 'user': user, 'summary': summary}), 200


@web_bp.route('/api/dashboard/licenses', methods=['GET'])
def dashboard_licenses():
    user, err = _dashboard_user_or_401()
    if err:
        return err
    rows = _licenses_for_user(user)
    items = [{
        'id': row.id,
        'keyMasked': _mask_key(row.key),
        'keyFull': row.key,
        'plan': _license_plan(row),
        'active': (not row.is_revoked),
        'status': _license_status(row),
        'hwid': row.hwid_hash or '',
        'expiresAt': _license_expires_iso(row),
        'createdAt': _license_created_iso(row),
        'note': str((row.extra_metadata or {}).get('notes') or ''),
    } for row in rows]
    return jsonify({'ok': True, 'items': items}), 200


@web_bp.route('/api/dashboard/reset-hwid', methods=['POST'])
def dashboard_reset_hwid():
    user, err = _dashboard_user_or_401()
    if err:
        return err
    if not request.is_json:
        return jsonify({'ok': False, 'error': 'Invalid request'}), 400
    data = request.get_json(silent=True) or {}
    key = str(data.get('key') or '').strip()
    cleaned = ''.join(ch for ch in key if ch.isalnum()).upper()
    if len(cleaned) < 8 or len(cleaned) > 32:
        return jsonify({'ok': False, 'error': 'Invalid key'}), 400

    rows = _licenses_for_user(user)
    target = next((row for row in rows if row.key == cleaned), None)
    if target is None:
        return jsonify({'ok': False, 'error': 'Not allowed for this account'}), 403

    reset_id = f'{user.get("id", "")}:{cleaned}'
    now = _unix_ms()
    with _state_lock:
        last_reset = int(_dashboard_resets.get(reset_id, 0))
    if now - last_reset < (24 * 60 * 60 * 1000):
        return jsonify({'ok': False, 'error': 'Reset cooldown: 24h'}), 429

    target.hwid_hash = None
    target.hwid_change_count = 0
    target.activated_at = None
    target.session_nonce = secrets.token_hex(16)
    db.session.commit()
    with _state_lock:
        _dashboard_resets[reset_id] = now
    audit_event('web.dashboard.reset_hwid.ok', ip=_client_ip(), license_id=target.id)
    return jsonify({'ok': True}), 200


@web_bp.route('/api/dashboard/cancel-subscription', methods=['POST'])
def dashboard_cancel_subscription():
    user, err = _dashboard_user_or_401()
    if err:
        return err
    discord_id = str((user or {}).get('id', '')).strip()

    stripe_key = str(current_app.config.get('STRIPE_SECRET_KEY', '')).strip()
    if not stripe_key:
        return jsonify({'ok': False, 'error': 'Not configured'}), 503

    # Find Stripe customer ID from their license metadata
    customer_id = ''
    if discord_id:
        licenses = License.query.filter(
            License._metadata.like(f'%"discord_id": "{discord_id}"%')
        ).all()
        for lic in licenses:
            cid = str((lic.extra_metadata or {}).get('stripe_customer', '')).strip()
            if cid.startswith('cus_'):
                customer_id = cid
                break

    site_url = str(current_app.config.get('SITE_URL', 'https://zenithmacros.store')).rstrip('/')

    try:
        import stripe as _stripe
        _stripe.api_key = stripe_key
        if customer_id:
            portal = _stripe.billing_portal.Session.create(
                customer=customer_id,
                return_url=f'{site_url}/dashboard',
            )
            return jsonify({'ok': True, 'url': portal.url}), 200
        else:
            # No customer ID on file — fall back to static portal URL or support
            fallback = str(current_app.config.get('STRIPE_BILLING_PORTAL_URL', '')).strip()
            if fallback:
                return jsonify({'ok': True, 'url': fallback}), 200
            return jsonify({
                'ok': False,
                'error': 'No billing record found for your account. Contact support.',
            }), 404
    except Exception as exc:
        return jsonify({'ok': False, 'error': str(exc)}), 500


@web_bp.route('/api/dashboard/renew-subscription', methods=['POST'])
def dashboard_renew_subscription():
    """Re-activate a subscription that has cancel_at_period_end=True."""
    user, err = _dashboard_user_or_401()
    if err:
        return err
    discord_id = str((user or {}).get('id', '')).strip()

    stripe_key = str(current_app.config.get('STRIPE_SECRET_KEY', '')).strip()
    if not stripe_key:
        return jsonify({'ok': False, 'error': 'Not configured'}), 503

    # Find the Stripe customer ID from license metadata
    customer_id = ''
    if discord_id:
        licenses = License.query.filter(
            License._metadata.like(f'%"discord_id": "{discord_id}"%')
        ).all()
        for lic in licenses:
            cid = str((lic.extra_metadata or {}).get('stripe_customer', '')).strip()
            if cid.startswith('cus_'):
                customer_id = cid
                break

    if not customer_id:
        return jsonify({'ok': False, 'error': 'No billing record found for your account. Contact support.'}), 404

    try:
        import stripe as _stripe
        _stripe.api_key = stripe_key

        # Find the active subscription that is set to cancel
        subs = _stripe.Subscription.list(customer=customer_id, limit=5, status='all')
        sub_id = None
        for sub in (subs.data or []):
            if sub.status in ('active', 'past_due', 'trialing') and sub.cancel_at_period_end:
                sub_id = sub.id
                break

        if not sub_id:
            return jsonify({'ok': False, 'error': 'No canceled subscription found to renew.'}), 404

        # Re-activate: clear cancel_at_period_end
        _stripe.Subscription.modify(sub_id, cancel_at_period_end=False)
        return jsonify({'ok': True}), 200
    except Exception as exc:
        return jsonify({'ok': False, 'error': str(exc)}), 500


# ---------------------------------------------------------------------------
# Individual / Standalone Macros — product catalog + entitlements
# ---------------------------------------------------------------------------

@web_bp.route('/api/products', methods=['GET'])
def list_products():
    """Public: list all active standalone products."""
    products = Product.query.filter_by(is_active=True).order_by(Product.sort_order).all()
    return jsonify({'ok': True, 'items': [p.to_dict() for p in products]}), 200


@web_bp.route('/api/standalone/download/<product_id>', methods=['GET'])
def standalone_download(product_id: str):
    """
    Return a direct download URL for a standalone product the user owns.
    Requires dashboard session (Discord OAuth cookie).
    """
    user, err = _dashboard_user_or_401()
    if err:
        return err
    discord_id = str(user.get('id', '')).strip()

    product = Product.query.get(product_id)
    if not product or not product.is_active:
        return jsonify({'ok': False, 'error': 'Unknown product'}), 404
    if not product.download_ref:
        return jsonify({'ok': False, 'error': 'No download available yet'}), 404

    # Check entitlement — find all licenses for this discord_id
    licenses = License.query.filter(
        License._metadata.like(f'%"discord_id": "{discord_id}"%')
    ).all()
    key_hashes = [lic.key_hash for lic in licenses if lic.is_active()]

    granted = False
    if key_hashes:
        granted = UserEntitlement.query.filter(
            UserEntitlement.license_key_hash.in_(key_hashes),
            UserEntitlement.product_id == product_id,
        ).first() is not None

    if not granted:
        return jsonify({'ok': False, 'error': 'Not entitled'}), 403

    audit_event('web.standalone.download', product_id=product_id, discord_id=discord_id)

    # Proxy through our backend (repo is private — direct GitHub URLs 404 without auth)
    asset_id, filename = _resolve_standalone_asset_id(product.download_ref)
    if asset_id:
        site = str(current_app.config.get('SITE_URL', '')).strip().rstrip('/')
        path = _build_download_link(asset_id, filename)
        url = f'{site}{path}' if site else path
    else:
        # Fallback: return raw URL (works if repo ever becomes public)
        url = product.download_ref

    return jsonify({'ok': True, 'url': url}), 200


@web_bp.route('/api/dashboard/entitlements', methods=['GET'])
def dashboard_entitlements():
    """Return the standalone product entitlements for the logged-in user."""
    user, err = _dashboard_user_or_401()
    if err:
        return err
    discord_id = str(user.get('id', '')).strip()
    if not discord_id:
        return jsonify({'ok': True, 'items': []}), 200

    # Find all licenses for this discord_id and collect their entitlements
    licenses = License.query.filter(
        License._metadata.like(f'%"discord_id": "{discord_id}"%')
    ).all()
    key_hashes = [lic.key_hash for lic in licenses if lic.is_active()]

    items = []
    if key_hashes:
        rows = UserEntitlement.query.filter(
            UserEntitlement.license_key_hash.in_(key_hashes)
        ).all()
        items = [
            {'product_id': r.product_id, 'granted_at': r.granted_at.isoformat()}
            for r in rows
        ]
    return jsonify({'ok': True, 'items': items}), 200


@web_bp.route('/api/checkout-standalone', methods=['POST'])
def checkout_standalone():
    """Create a Stripe embedded checkout session for one or more standalone products."""
    user, err = _dashboard_user_or_401()
    if err:
        return err

    data = request.get_json(silent=True) or {}

    # Accept product_ids (array) or product_id (single string, possibly comma-separated)
    raw_ids = data.get('product_ids') or []
    if not raw_ids:
        single = str(data.get('product_id') or '').strip()
        raw_ids = [s.strip() for s in single.split(',') if s.strip()]
    if not raw_ids:
        return jsonify({'ok': False, 'error': 'product_id required'}), 400

    discord_id = str(user.get('id', '')).strip()

    # Validate all products
    products = []
    for pid in raw_ids:
        p = Product.query.get(pid)
        if not p or not p.is_active:
            return jsonify({'ok': False, 'error': f'Product not found: {pid}'}), 404
        if not p.stripe_price_id:
            return jsonify({'ok': False, 'error': f'{p.name} is not yet available for purchase'}), 503
        products.append(p)

    stripe_key = str(current_app.config.get('STRIPE_SECRET_KEY', '')).strip()
    if not stripe_key:
        return jsonify({'ok': False, 'error': 'Checkout not configured'}), 503

    # Check if all are already owned
    existing_lic = License.query.filter(
        License._metadata.like(f'%"discord_id": "{discord_id}"%')
    ).first()
    if existing_lic and len(products) == 1:
        already = UserEntitlement.query.filter_by(
            license_key_hash=existing_lic.key_hash,
            product_id=products[0].id,
        ).first()
        if already:
            return jsonify({'ok': False, 'error': 'You already own this product'}), 409

    try:
        import stripe as _stripe
        _stripe.api_key = stripe_key
        site = str(current_app.config.get('SITE_URL', 'https://zenithmacros.store')).rstrip('/')
        product_ids_str = ','.join(p.id for p in products)
        meta = {
            'discord_id':       str(user.get('id', '')),
            'discord_username': str(user.get('username', '')),
            'product_ids':      product_ids_str,
            # keep product_id for single-product backward compat
            'product_id':       products[0].id if len(products) == 1 else '',
            'type':             'standalone',
        }
        line_items = [{'price': p.stripe_price_id, 'quantity': 1} for p in products]
        session = _stripe.checkout.Session.create(
            ui_mode='embedded_page',
            mode='payment',
            line_items=line_items,
            return_url=f'{site}/dashboard.html?payment=success&product={product_ids_str}',
            metadata=meta,
            payment_intent_data={'metadata': {**meta}},
        )
        audit_event('web.checkout.standalone', ip=_client_ip(), product_ids=product_ids_str)
        return jsonify({'ok': True, 'client_secret': session.client_secret}), 200
    except Exception as exc:
        return jsonify({'ok': False, 'error': f'Checkout failed: {str(exc)[:200]}'}), 500


def _fulfill_standalone(stripe_ref: str, discord_id: str, product_id: str,
                        charged_cents: int, user_email: str = '') -> None:
    """Grant a standalone product entitlement after successful payment."""
    # Idempotency check
    if UserEntitlement.query.filter_by(stripe_ref=stripe_ref).first():
        return

    product = Product.query.get(product_id)
    if not product:
        audit_event('web.standalone.unknown_product', product_id=product_id, stripe_ref=stripe_ref)
        return

    # Find the user's active license by discord_id
    lic = License.query.filter(
        License._metadata.like(f'%"discord_id": "{discord_id}"%')
    ).filter_by(is_revoked=False).order_by(License.id.desc()).first()

    if not lic:
        # No license found — create a standalone-only license for this user.
        normalized = _generate_license_key()
        while License.query.filter_by(key_hash=_sha256_hex(normalized)).first() is not None:
            normalized = _generate_license_key()
        meta = {
            'discord_id': discord_id,
            'plan': 'standalone',
            'stripe_ref': stripe_ref,
            'charged_cents': charged_cents,
        }
        if user_email:
            meta['user_email'] = user_email
        lic = License(
            key=normalized,
            key_hash=_sha256_hex(normalized),
            user_enc_key=secrets.token_hex(32),
            user_salt=secrets.token_hex(16),
            tier='standalone',
            is_revoked=False,
            expires_at=None,
        )
        lic.extra_metadata = meta
        db.session.add(lic)
        db.session.flush()
        audit_event('web.standalone.created_license', discord_id=discord_id,
                    product_id=product_id, license_id=lic.id)

    # Check not already granted
    if UserEntitlement.query.filter_by(
        license_key_hash=lic.key_hash, product_id=product_id
    ).first():
        return

    ent = UserEntitlement(
        license_key_hash=lic.key_hash,
        product_id=product_id,
        stripe_ref=stripe_ref,
        charged_cents=charged_cents,
    )
    db.session.add(ent)

    # If this is a bundle, grant each included product too
    bundle_pids = [x.strip() for x in (product.bundle_items or '').split(',') if x.strip()]
    for bpid in bundle_pids:
        if not UserEntitlement.query.filter_by(
            license_key_hash=lic.key_hash, product_id=bpid
        ).first():
            db.session.add(UserEntitlement(
                license_key_hash=lic.key_hash,
                product_id=bpid,
                stripe_ref=f'{stripe_ref}:bundle:{bpid}',
                charged_cents=0,
            ))

    db.session.commit()
    audit_event('web.standalone.fulfilled', product_id=product_id,
                discord_id=discord_id, license_id=lic.id)

    # Grant Individual Macros Discord role (DISCORD_STANDALONE_ROLE_ID)
    grant_standalone_role(discord_id, current_app.config)

    # Sale notification — reuse shared helper
    _post_sale_notification(
        discord_id=discord_id,
        plan=f'standalone:{product.name}',
        charged_cents=charged_cents,
        license_key=lic.key if hasattr(lic, 'key') else '',
        user_email=user_email,
        stripe_ref=stripe_ref,
        product_name=product.name,
    )
    _send_purchase_dm(discord_id, f'standalone:{product.name}', product_name=product.name)


## Old /api/pricing removed — superseded by pricing_info() below with full plan metadata


@web_bp.route('/api/create-checkout', methods=['GET'])
def create_checkout():
    user, err = _dashboard_user_or_401()
    if err:
        next_url = quote('/api/create-checkout?' + request.query_string.decode('utf-8', errors='ignore'), safe='')
        return redirect(f'/auth/discord/start?next={next_url}', code=302)

    plan = str(request.args.get('plan') or 'monthly').strip().lower()
    if plan not in {'monthly', '3month', 'lifetime'}:
        return jsonify({'ok': False, 'error': 'Invalid plan'}), 400

    ref = str(request.args.get('ref') or '').strip()[:64]

    stripe_key = str(current_app.config.get('STRIPE_SECRET_KEY', '')).strip()
    if not stripe_key:
        return jsonify({'ok': False, 'error': 'Checkout is not configured yet'}), 503

    if plan == 'monthly':
        price_id = str(current_app.config.get('STRIPE_PRICE_MONTHLY', '')).strip()
        mode = 'subscription'
    elif plan == '3month':
        price_id = str(current_app.config.get('STRIPE_PRICE_3MONTH', '')).strip()
        mode = 'payment'
    else:
        price_id = str(current_app.config.get('STRIPE_PRICE_LIFETIME', '')).strip()
        mode = 'payment'

    if not price_id:
        return jsonify({'ok': False, 'error': 'Checkout is not configured yet'}), 503

    try:
        import stripe as _stripe
        _stripe.api_key = stripe_key
        site = str(current_app.config.get('SITE_URL', 'https://zenithmacros.store')).rstrip('/')
        meta = {
            'discord_id': str(user.get('id', '')),
            'discord_username': str(user.get('username', '')),
            'plan': plan,
        }
        if ref:
            meta['affiliate_code'] = ref
        session = _stripe.checkout.Session.create(
            mode=mode,
            line_items=[{'price': price_id, 'quantity': 1}],
            success_url=f'{site}/dashboard.html?payment=success',
            cancel_url=f'{site}/#pricing',
            allow_promotion_codes=True,
            metadata=meta,
            **(
                {'subscription_data': {'metadata': {**meta}}}
                if mode == 'subscription' else
                {'payment_intent_data': {'metadata': {**meta}}}
            ),
        )
        audit_event('web.checkout.redirect', ip=_client_ip(), plan=plan)
        return redirect(session.url, code=302)
    except Exception as exc:
        return jsonify({'ok': False, 'error': f'Checkout failed: {str(exc)[:200]}'}), 500


@web_bp.route('/api/stripe-config', methods=['GET'])
def stripe_config():
    pk = str(current_app.config.get('STRIPE_PUBLISHABLE_KEY', '')).strip()
    if not pk:
        return jsonify({'ok': False, 'error': 'Not configured'}), 404
    return jsonify({'ok': True, 'publishable_key': pk}), 200


@web_bp.route('/api/pricing', methods=['GET'])
def pricing_info():
    """Single source of truth for plan pricing, served to the frontend."""
    plans = {
        'monthly': {
            'name': 'Monthly Access',
            'desc': 'Full access to all macros. Cancel anytime.',
            'price': f'${int(current_app.config.get("MONTHLY_PRICE_DISPLAY", 5))}',
            'amount': int(current_app.config.get('MONTHLY_PRICE_DISPLAY', 5)) * 100,
            'period': '/mo',
        },
        '3month': {
            'name': '3-Month Access',
            'desc': 'Full access for 3 months — one payment.',
            'price': f'${int(current_app.config.get("PRICE_3MONTH_DISPLAY", 10))}',
            'amount': int(current_app.config.get('PRICE_3MONTH_DISPLAY', 10)) * 100,
            'period': '/ 3 months',
        },
        'lifetime': {
            'name': 'Lifetime Access',
            'desc': 'One-time payment — full access, forever.',
            'price': f'${int(current_app.config.get("LIFETIME_STANDARD_PRICE", 25))}',
            'amount': int(current_app.config.get('LIFETIME_STANDARD_PRICE', 25)) * 100,
            'period': 'one-time',
        },
    }
    portal_url = str(current_app.config.get('STRIPE_BILLING_PORTAL_URL', '')).strip() or None
    return jsonify({'ok': True, 'plans': plans, 'portal_url': portal_url}), 200


@web_bp.route('/api/checkout-session', methods=['POST'])
def checkout_session():
    user, err = _dashboard_user_or_401()
    if err:
        return err

    data = request.get_json(silent=True) or {}
    plan = str(data.get('plan') or 'monthly').strip().lower()
    if plan not in {'monthly', '3month', 'lifetime'}:
        return jsonify({'ok': False, 'error': 'Invalid plan'}), 400

    ref      = str(data.get('ref') or '').strip()[:64]
    promo_id = str(data.get('promo_id') or '').strip()[:128]

    stripe_key = str(current_app.config.get('STRIPE_SECRET_KEY', '')).strip()
    if not stripe_key:
        return jsonify({'ok': False, 'error': 'Checkout is not configured'}), 503

    if plan == 'monthly':
        price_id = str(current_app.config.get('STRIPE_PRICE_MONTHLY', '')).strip()
        mode = 'subscription'
    elif plan == '3month':
        price_id = str(current_app.config.get('STRIPE_PRICE_3MONTH', '')).strip()
        mode = 'payment'
    else:
        price_id = str(current_app.config.get('STRIPE_PRICE_LIFETIME', '')).strip()
        mode = 'payment'

    if not price_id:
        return jsonify({'ok': False, 'error': 'Checkout is not configured'}), 503

    try:
        import stripe as _stripe
        _stripe.api_key = stripe_key
        site = str(current_app.config.get('SITE_URL', 'https://zenithmacros.store')).rstrip('/')
        meta = {
            'discord_id': str(user.get('id', '')),
            'discord_username': str(user.get('username', '')),
            'plan': plan,
        }
        if ref:
            meta['affiliate_code'] = ref
        if promo_id:
            meta['stripe_promo_id'] = promo_id

        extra = {}
        if promo_id:
            extra['discounts'] = [{'promotion_code': promo_id}]
        else:
            extra['allow_promotion_codes'] = True

        session = _stripe.checkout.Session.create(
            ui_mode='embedded_page',
            mode=mode,
            line_items=[{'price': price_id, 'quantity': 1}],
            return_url=f'{site}/dashboard.html?payment=success&session_id={{CHECKOUT_SESSION_ID}}',
            metadata=meta,
            **(
                {'subscription_data': {'metadata': {**meta}}}
                if mode == 'subscription' else
                {'payment_intent_data': {'metadata': {**meta}}}
            ),
            **extra,
        )
        audit_event('web.checkout.embedded', ip=_client_ip(), plan=plan)
        return jsonify({'ok': True, 'client_secret': session.client_secret}), 200
    except Exception as exc:
        return jsonify({'ok': False, 'error': f'Checkout failed: {str(exc)[:200]}'}), 500


@web_bp.route('/api/validate-code', methods=['POST'])
def validate_code():
    data = request.get_json(silent=True) or {}
    code      = str(data.get('code') or '').strip()
    code_type = str(data.get('type') or '').lower()

    if not code:
        return jsonify({'ok': False, 'error': 'No code provided'}), 400

    if code_type == 'referral':
        found = False
        owner_discord_id = None
        try:
            # Use indexed affiliate_code column for O(1) lookup
            lic = License.query.filter(License.affiliate_code == code.lower()).first()
            if lic:
                found = True
                owner_discord_id = str((lic.extra_metadata or {}).get('discord_id', '')).strip()
        except Exception:
            pass
        if found:
            # Block the affiliate owner from using their own code
            try:
                _sess_sid, sess = _dashboard_session()
            except Exception:
                sess = None
            if sess and owner_discord_id and str(sess.get('discord_id', '')).strip() == owner_discord_id:
                return jsonify({'ok': False, 'error': "You can't use your own referral code."}), 200
            return jsonify({'ok': True, 'type': 'referral', 'code': code.lower()}), 200
        return jsonify({'ok': False, 'error': 'Referral code not found'}), 200

    if code_type == 'coupon':
        stripe_key = str(current_app.config.get('STRIPE_SECRET_KEY', '')).strip()
        if not stripe_key:
            return jsonify({'ok': False, 'error': 'Not configured'}), 503
        try:
            import stripe as _stripe
            _stripe.api_key = stripe_key
            promos = _stripe.PromotionCode.list(code=code, active=True, limit=1)
            if not promos.data:
                return jsonify({'ok': False, 'error': 'Coupon not found or expired'}), 200
            promo  = promos.data[0]
            # stripe-python v3+: .coupon attribute moved to .promotion.coupon (an ID)
            try:
                coupon = promo.coupon
            except AttributeError:
                promo_dict = promo.to_dict() if hasattr(promo, 'to_dict') else {}
                coupon_id = (promo_dict.get('promotion') or {}).get('coupon') or ''
                coupon = _stripe.Coupon.retrieve(coupon_id) if coupon_id else None
            if coupon and getattr(coupon, 'percent_off', None):
                disc = {'type': 'percent', 'percent': float(coupon.percent_off)}
            elif coupon and getattr(coupon, 'amount_off', None):
                disc = {'type': 'amount', 'amount_off': int(coupon.amount_off), 'currency': getattr(coupon, 'currency', 'usd')}
            else:
                disc = {}
            return jsonify({'ok': True, 'type': 'stripe_coupon', 'code': code, 'promo_id': promo.id, 'discount': disc}), 200
        except Exception as exc:
            return jsonify({'ok': False, 'error': str(exc)[:200]}), 500

    return jsonify({'ok': False, 'error': 'Invalid type'}), 400


@web_bp.route('/api/payment-intent', methods=['POST'])
def create_payment_intent():
    user, err = _dashboard_user_or_401()
    if err:
        return err

    data      = request.get_json(silent=True) or {}
    plan      = str(data.get('plan') or 'lifetime').strip().lower()
    ref       = str(data.get('ref') or '').strip()[:64]
    promo_id  = str(data.get('promo_id') or '').strip()[:128]

    if plan != 'lifetime':
        return jsonify({'ok': False, 'error': 'Use /api/create-checkout for monthly'}), 400

    stripe_key = str(current_app.config.get('STRIPE_SECRET_KEY', '')).strip()
    if not stripe_key:
        return jsonify({'ok': False, 'error': 'Not configured'}), 503

    discord_id = str(user.get('id', ''))
    username   = str(user.get('username', ''))
    meta = {'discord_id': discord_id, 'discord_username': username, 'plan': plan}
    if ref:
        meta['referral_code'] = ref
    if promo_id:
        meta['stripe_promo_id'] = promo_id

    try:
        import stripe as _stripe
        _stripe.api_key = stripe_key
        amount = 2500  # $25.00 in cents

        # Apply Stripe promo discount to the PaymentIntent amount
        if promo_id:
            try:
                promo  = _stripe.PromotionCode.retrieve(promo_id)
                coupon = promo.coupon
                if coupon.percent_off:
                    amount = max(50, int(amount * (1 - coupon.percent_off / 100)))
                elif coupon.amount_off:
                    amount = max(50, amount - int(coupon.amount_off))
            except Exception:
                pass

        pi = _stripe.PaymentIntent.create(
            amount=amount,
            currency='usd',
            metadata=meta,
        )
        audit_event('web.payment_intent.lifetime', ip=_client_ip())
        return jsonify({'ok': True, 'client_secret': pi.client_secret, 'type': 'payment_intent', 'amount': amount}), 200

    except Exception as exc:
        return jsonify({'ok': False, 'error': f'Failed: {str(exc)[:200]}'}), 500


@web_bp.route('/api/resend-license-email', methods=['POST'])
def resend_license_email():
    user, err = _dashboard_user_or_401()
    if err:
        return err
    _ = user
    return jsonify({
        'ok': False,
        'error': 'License resend is not configured in this migration baseline yet.',
    }), 501


@web_bp.route('/api/releases', methods=['GET'])
def releases():
    if not _github_release_ready():
        return jsonify({'ok': False, 'note': 'no_repo_configured'}), 200

    repo = _release_repo()
    req = _github_api_request(f'https://api.github.com/repos/{repo}/releases?per_page=8')
    try:
        payload = _json_from_url(req)
    except Exception:
        return jsonify({'ok': False, 'error': 'Could not load releases'}), 503

    if not isinstance(payload, list):
        return jsonify({'ok': False, 'error': 'Invalid release response'}), 503

    releases_payload = []
    for rel in payload:
        rel_assets = rel.get('assets') or []
        assets_out = []
        for asset in rel_assets:
            asset_id = int(asset.get('id') or 0)
            asset_name = str(asset.get('name') or '').strip()
            if not asset_id or not asset_name:
                continue
            assets_out.append({
                'name': asset_name,
                'size': int(asset.get('size') or 0),
                'url': _build_download_link(asset_id, asset_name),
            })
        releases_payload.append({
            'tag': str(rel.get('tag_name') or '').strip(),
            'name': str(rel.get('name') or '').strip(),
            'draft': bool(rel.get('draft')),
            'prerelease': bool(rel.get('prerelease')),
            'published_at': str(rel.get('published_at') or '').strip(),
            'body': str(rel.get('body') or ''),
            'assets': assets_out,
        })

    return jsonify({'ok': True, 'releases': releases_payload}), 200


@web_bp.route('/api/dashboard/download-latest', methods=['GET'])
def dashboard_download_latest():
    user, err = _dashboard_user_or_401()
    if err:
        return err

    # Block standalone-only accounts from downloading the main client
    discord_id = str(user.get('id', '')).strip()
    if discord_id:
        lic = License.query.filter(
            License._metadata.like(f'%"discord_id": "{discord_id}"%')
        ).filter_by(is_revoked=False).order_by(License.id.desc()).first()
        if lic and lic.tier == 'standalone':
            return jsonify({
                'ok': False,
                'error': 'standalone_only',
                'message': 'Your key is for standalone macros only. Purchase a subscription to access the full client.',
            }), 403

    release = _latest_release_data()
    if not release:
        return jsonify({'ok': False, 'error': 'Latest release is not configured yet'}), 503

    url = _build_download_link(int(release['assetId']), str(release['assetName']))
    return jsonify({
        'ok': True,
        'version': release['version'],
        'releaseName': release.get('releaseName', ''),
        'releaseNotes': release.get('releaseNotes', ''),
        'publishedAt': release['publishedAt'],
        'assetName': release['assetName'],
        'size': release['assetSize'],
        'url': url,
    }), 200


@web_bp.route('/api/bot/download-link', methods=['GET'])
def bot_download_link():
    if not _bot_api_authorized():
        return jsonify({'ok': False, 'error': 'Unauthorized'}), 401

    # Optional: if caller passes discord_id, verify the user is not standalone-only
    discord_id = request.args.get('discord_id', '').strip()
    if discord_id:
        lic = License.query.filter(
            License._metadata.like(f'%"discord_id": "{discord_id}"%')
        ).filter_by(is_revoked=False).order_by(License.id.desc()).first()
        if lic and lic.tier == 'standalone':
            return jsonify({'ok': False, 'error': 'standalone_only'}), 403

    release = _latest_release_data()
    if not release:
        return jsonify({'ok': False, 'error': 'Latest release is not configured yet'}), 503

    site = str(current_app.config.get('SITE_URL', '')).strip().rstrip('/')
    path = _build_download_link(int(release['assetId']), str(release['assetName']))
    url = f'{site}{path}' if site else path
    return jsonify({
        'ok': True,
        'version': release['version'],
        'assetName': release['assetName'],
        'url': url,
    }), 200


@web_bp.route('/api/client/download', methods=['GET'])
def client_download():
    token = str(request.args.get('token') or '').strip()
    payload = _unpack_signed_json(token)
    if not payload:
        return jsonify({'ok': False, 'error': 'Invalid download token'}), 401

    exp = int(payload.get('exp') or 0)
    asset_id = int(payload.get('asset_id') or 0)
    asset_name = str(payload.get('asset_name') or '').strip()
    if exp <= _unix_ms() or asset_id <= 0 or not asset_name:
        return jsonify({'ok': False, 'error': 'Download token expired'}), 401

    repo = _release_repo()
    if not repo:
        return jsonify({'ok': False, 'error': 'Release repository is not configured'}), 503

    req = _github_api_request(
        f'https://api.github.com/repos/{repo}/releases/assets/{asset_id}',
        accept='application/octet-stream',
    )
    try:
        upstream = urlopen(req, timeout=45)  # nosec B310
    except Exception:
        return jsonify({'ok': False, 'error': 'Could not fetch release asset'}), 503

    content_type = upstream.headers.get('Content-Type', 'application/octet-stream')

    def _iter_chunks():
        with upstream:
            while True:
                chunk = upstream.read(64 * 1024)
                if not chunk:
                    break
                yield chunk

    response = Response(stream_with_context(_iter_chunks()), mimetype=content_type)
    response.headers['Content-Disposition'] = f'attachment; filename="{asset_name}"'
    response.headers['Cache-Control'] = 'no-store'
    return response


# ──────────────────────────────────────────────────────────────────────────────
# EXE Builder helpers
# ──────────────────────────────────────────────────────────────────────────────

# Preset disguise icon colours (solid rounded-rect, generated by Pillow)
_ICON_PRESETS: dict[str, dict] = {
    'spotify': {'bg': (30, 215, 96),   'fg': (255, 255, 255), 'logo_file': 'spotify.png'},
    'discord': {'bg': (88, 101, 242),  'fg': (255, 255, 255), 'logo_file': 'discord.webp'},
    'chrome':  {'bg': (255, 255, 255), 'fg': (66, 133, 244),  'logo_file': 'chrome.png'},
    'steam':   {'bg': (27, 40, 56),    'fg': (199, 213, 224), 'logo_file': 'steam.png'},
    'obs':     {'bg': (50, 50, 50),    'fg': (255, 255, 255), 'logo_file': 'obs.png'},
}

import struct as _struct
import io as _io

# In-memory cache for logo bytes: key → bytes
_logo_fetch_cache: dict[str, bytes] = {}

import os as _os

def _fetch_logo_png(logo_file: str) -> bytes | None:
    """Fetch a brand logo, trying local filesystem first then the live website CDN."""
    if not logo_file:
        return None
    cached = _logo_fetch_cache.get(logo_file)
    if cached is not None:
        return cached

    data: bytes | None = None

    # 1. Try local filesystem (works in dev and when Docker COPY lands correctly)
    try:
        this = _os.path.dirname(__file__)
        for up in (1, 2, 3):
            p = _os.path.normpath(_os.path.join(this, *(['..'] * up), 'logos', logo_file))
            if _os.path.exists(p):
                with open(p, 'rb') as fh:
                    data = fh.read()
                break
            p2 = _os.path.normpath(_os.path.join(this, *(['..'] * up), 'website', 'public', 'logos', logo_file))
            if _os.path.exists(p2):
                with open(p2, 'rb') as fh:
                    data = fh.read()
                break
    except Exception:
        pass

    # 2. Fall back to fetching from the live website (always works on Fly.io)
    if not data:
        try:
            from urllib.request import Request as _Req, urlopen as _urlopen
            site = str(current_app.config.get('SITE_URL', 'https://zenithmacros.store')).rstrip('/')
            url = f'{site}/logos/{logo_file}'
            req = _Req(url, headers={'User-Agent': 'zenithmacros-icon-gen/1.0'})
            with _urlopen(req, timeout=8) as resp:
                data = resp.read()
        except Exception:
            pass

    if data:
        _logo_fetch_cache[logo_file] = data
    return data or None


def _make_icon_pil(bg: tuple[int, int, int], size: int, logo_file: str = ''):
    """Return a PIL RGBA Image: transparent background with centred logo (no coloured rect)."""
    try:
        from PIL import Image
        img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        if logo_file:
            logo_bytes = _fetch_logo_png(logo_file)
            if logo_bytes:
                try:
                    logo = Image.open(_io.BytesIO(logo_bytes)).convert('RGBA')
                    max_dim = int(size * 0.95)
                    logo.thumbnail((max_dim, max_dim), Image.LANCZOS)
                    ox = (size - logo.width) // 2
                    oy = (size - logo.height) // 2
                    img.paste(logo, (ox, oy), logo)
                except Exception:
                    pass
        return img
    except Exception:
        return None


def _make_bmp_icon_data(bg: tuple[int, int, int], size: int, logo_file: str = '') -> bytes:
    """Generate a BMP RT_ICON resource (BITMAPINFOHEADER + BGRA pixels + AND mask)."""
    r, g, b = bg
    try:
        pil_img = _make_icon_pil(bg, size, logo_file)
        if pil_img is not None:
            pil_img = pil_img.convert('RGBA')
            pixels = list(pil_img.getdata())
            # BMP pixel data is stored bottom-up
            rows_bgra = []
            for row_i in range(size - 1, -1, -1):
                for col_i in range(size):
                    px = pixels[row_i * size + col_i]
                    rows_bgra.extend([px[2], px[1], px[0], px[3]])  # BGRA
            xor_mask = bytes(rows_bgra)
        else:
            row = bytes([b, g, r, 255]) * size
            xor_mask = row * size
    except Exception:
        row = bytes([b, g, r, 255]) * size
        xor_mask = row * size

    header = _struct.pack(
        '<IIIHHIIIIII',
        40, size, size * 2, 1, 32, 0,
        size * size * 4, 0, 0, 0, 0,
    )
    row_stride = (size + 31) // 32 * 4
    and_mask = b'\x00' * (row_stride * size)
    return header + xor_mask + and_mask


def _make_png_for_slot(bg: tuple[int, int, int], size: int, logo_file: str, max_bytes: int) -> bytes:
    """Return a 32-bit RGBA PNG of exactly `size`×`size` px that fits within `max_bytes`.

    Windows icon PNG slots require exactly 32-bit RGBA PNGs.

    Strategy (applied in order until a result fits):
    1. Full-quality RGBA with rounded-rect transparency.
    2. Quantised to progressively fewer unique colours, *flattened onto the solid
       brand background* so all pixels are fully opaque.  Removing the alpha
       channel's anti-aliased corner data is the key: those ~thousands of unique
       alpha values prevent DEFLATE from compressing large PNGs below slot size.
       A 256×256 RGBA image with only 8 unique opaque RGBA tuples compresses to
       ≈100-500 bytes — well within any slot.
    3. Tiny solid-colour RGBA PNG as absolute last resort (slot too small even
       for a flat 8×8 image with the logo).
    """
    try:
        from PIL import Image, ImageDraw

        img = _make_icon_pil(bg, size, logo_file)
        if img is None:
            img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
            ImageDraw.Draw(img).rounded_rectangle(
                [0, 0, size - 1, size - 1], radius=max(4, size // 7), fill=(*bg, 255)
            )

        # ── 1. Full-quality RGBA (includes transparent rounded corners) ──
        buf = _io.BytesIO()
        img.save(buf, format='PNG', optimize=True, compress_level=9)
        data = buf.getvalue()
        if data and len(data) <= max_bytes:
            return data

        # ── 2. Binary alpha + progressively fewer RGB colours ──
        # Thresholding alpha to 0/255 removes anti-aliased edge entropy, which is
        # the main reason transparent PNGs don't compress small enough for tight slots.
        # Then quantising the RGB channels further shrinks DEFLATE output while keeping
        # colour type 6 (32-bit RGBA) as required by Windows.
        a_ch = img.split()[3]
        a_binary = a_ch.point(lambda x: 255 if x > 128 else 0)
        rgb = Image.merge('RGB', img.split()[:3])

        for n_colors in (128, 64, 32, 16, 8, 4, 2):
            try:
                q_rgb = rgb.quantize(colors=n_colors,
                                     method=Image.Quantize.FASTOCTREE).convert('RGB')
                q_rgba = q_rgb.convert('RGBA')
                q_rgba.putalpha(a_binary)  # restore binary transparency
                buf = _io.BytesIO()
                q_rgba.save(buf, format='PNG', optimize=True, compress_level=9)
                data = buf.getvalue()
                if data and len(data) <= max_bytes:
                    return data
            except Exception:
                continue

        # ── 3. Absolute last resort: tiny solid-colour square ──
        r, g, b = bg
        for tiny in (8, 4, 2, 1):
            tiny_img = Image.new('RGBA', (tiny, tiny), (r, g, b, 255))
            buf = _io.BytesIO()
            tiny_img.save(buf, format='PNG', optimize=True, compress_level=9)
            data = buf.getvalue()
            if data and len(data) <= max_bytes:
                return data

        return b''
    except Exception:
        return b''


def _patch_version_block(block: bytearray, strings: dict[str, str]) -> None:
    """Patch key→value pairs inside a VS_VERSION_INFO binary blob (in-place).

    Keys and values are stored as null-terminated UTF-16LE strings.  We search
    for each key, then overwrite the value that follows it in-place.  If the
    new value is shorter we zero-pad the remainder.  If it is longer we
    truncate to fit so we never change the resource block size (which would
    corrupt the PE).
    """
    for key, new_val in strings.items():
        key_utf16 = key.encode('utf-16-le') + b'\x00\x00'
        search_buf = bytes(block)
        pos = search_buf.find(key_utf16)
        if pos == -1:
            continue

        # Value starts after the key, aligned to a 4-byte boundary
        val_start = pos + len(key_utf16)
        rem = val_start % 4
        if rem:
            val_start += 4 - rem

        if val_start >= len(block):
            continue

        # Find end of existing value (UTF-16LE null terminator \x00\x00)
        val_end = val_start
        while val_end + 1 < len(block):
            if block[val_end] == 0 and block[val_end + 1] == 0:
                val_end += 2
                break
            val_end += 2

        existing_space = val_end - val_start
        if existing_space < 2:
            continue

        new_utf16 = new_val.encode('utf-16-le') + b'\x00\x00'
        if len(new_utf16) <= existing_space:
            block[val_start:val_start + len(new_utf16)] = new_utf16
            block[val_start + len(new_utf16):val_end] = b'\x00' * (existing_space - len(new_utf16))
        else:
            # Truncate — keep as many characters as fit, always keep null terminator
            max_chars = (existing_space // 2) - 1
            truncated = new_val[:max_chars].encode('utf-16-le') + b'\x00\x00'
            block[val_start:val_end] = truncated[:existing_space]


def _patch_exe_version_strings(exe_bytes: bytes, strings: dict[str, str]) -> bytes:
    """Locate the RT_VERSION resource in a PE file and patch string fields inside it."""
    try:
        import pefile as _pefile  # lazy import — may not be installed in dev
        pe = _pefile.PE(data=exe_bytes, fast_load=True)
        pe.parse_data_directories(directories=[
            _pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_RESOURCE']
        ])
        if not hasattr(pe, 'DIRECTORY_ENTRY_RESOURCE'):
            return exe_bytes

        result = bytearray(exe_bytes)
        for res_type in pe.DIRECTORY_ENTRY_RESOURCE.entries:
            if res_type.id != _pefile.RESOURCE_TYPE['RT_VERSION']:
                continue
            for res_id in res_type.directory.entries:
                for res_lang in res_id.directory.entries:
                    rva = res_lang.data.struct.OffsetToData
                    size = res_lang.data.struct.Size
                    offset = pe.get_offset_from_rva(rva)
                    block = bytearray(exe_bytes[offset:offset + size])
                    _patch_version_block(block, strings)
                    result[offset:offset + size] = block
                    return bytes(result)  # Only one RT_VERSION per EXE

        return bytes(result)
    except Exception:
        return exe_bytes


def _sanitize_pe_binary(exe_bytes: bytes, preset: str, version_str: str = '1.0.0.0') -> bytes:
    """Strip and replace PE metadata that fingerprints the binary origin.

    Safe operations only — code sections (.text etc.) are never modified:
      1. Zero the Rich header  (compiler/linker stamp)
      2. Strip the debug data-directory entry  (removes PDB pointer)
      3. Overwrite CodeView RSDS PDB path strings
      4. Replace RT_MANIFEST with a clean preset-appropriate XML
      5. Recalculate the PE optional-header checksum
    """
    _DISPLAY = {
        'spotify': 'Spotify', 'discord': 'Discord',
        'chrome': 'Google Chrome', 'steam': 'Steam', 'obs': 'OBS Studio',
    }
    _ARCH = {
        'spotify': 'Spotify', 'discord': 'Discord',
        'chrome': 'GoogleChrome', 'steam': 'Steam', 'obs': 'OBSStudio',
    }
    display  = _DISPLAY.get(preset, 'Spotify')
    arch_name = _ARCH.get(preset, 'Spotify')

    # Ensure version is in W.X.Y.Z form for the manifest assemblyIdentity
    parts = (version_str or '1.0.0.0').split('.')
    while len(parts) < 4:
        parts.append('0')
    manifest_ver = '.'.join(parts[:4])

    try:
        import pefile as _pefile

        result = bytearray(exe_bytes)

        # ── 1. Zero Rich header (compiler/linker fingerprint) ──────────────────
        try:
            pe_off = _struct.unpack_from('<I', exe_bytes, 0x3C)[0]
            if 0x80 < pe_off < len(exe_bytes):
                area = exe_bytes[0x80:pe_off]
                rp = area.rfind(b'Rich')
                if rp != -1:
                    end = 0x80 + rp + 8   # "Rich" (4) + XOR key (4)
                    result[0x80:end] = b'\x00' * (end - 0x80)
        except Exception:
            pass

        pe = _pefile.PE(data=exe_bytes, fast_load=True)
        pe.parse_data_directories(directories=[
            _pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_DEBUG'],
            _pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_RESOURCE'],
        ])

        # ── 2. Zero debug data-directory entry (removes PDB file reference) ────
        try:
            for entry in pe.OPTIONAL_HEADER.DATA_DIRECTORY:
                if entry.name == 'IMAGE_DIRECTORY_ENTRY_DEBUG':
                    fo = entry.get_file_offset()
                    result[fo:fo + 8] = b'\x00' * 8   # VirtualAddress + Size → 0
                    break
        except Exception:
            pass

        # ── 3. Overwrite CodeView RSDS PDB path strings ─────────────────────────
        # RSDS record: 4-byte sig + 16-byte GUID + 4-byte age + null-term path
        try:
            src = bytes(result)
            idx = 0
            while True:
                idx = src.find(b'RSDS', idx)
                if idx == -1:
                    break
                ps = idx + 4 + 16 + 4       # skip sig + GUID + age
                pe_end = ps
                while pe_end < len(src) and src[pe_end] != 0:
                    pe_end += 1
                old_len = pe_end - ps
                if old_len > 4:
                    fake = f'C:\\Windows\\System32\\{arch_name}.pdb'.encode('ascii')
                    fake = fake[:old_len].ljust(old_len, b'\x00')
                    result[ps:pe_end] = fake
                idx = pe_end + 1
                src = bytes(result)
        except Exception:
            pass

        # ── 4. Replace RT_MANIFEST with a clean preset manifest ─────────────────
        _MANIFEST = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
            '<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">\r\n'
            f'  <assemblyIdentity type="win32" name="{arch_name}"'
            f' version="{manifest_ver}" processorArchitecture="amd64"/>\r\n'
            '  <application>\r\n'
            '    <windowsSettings>\r\n'
            '      <dpiAwareness'
            ' xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">'
            'PerMonitorV2, PerMonitor</dpiAwareness>\r\n'
            '      <dpiAware'
            ' xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">'
            'True</dpiAware>\r\n'
            '    </windowsSettings>\r\n'
            '  </application>\r\n'
            '  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">\r\n'
            '    <security>\r\n'
            '      <requestedPrivileges>\r\n'
            '        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>\r\n'
            '      </requestedPrivileges>\r\n'
            '    </security>\r\n'
            '  </trustInfo>\r\n'
            '</assembly>'
        ).encode('utf-8')
        try:
            if hasattr(pe, 'DIRECTORY_ENTRY_RESOURCE'):
                for res_type in pe.DIRECTORY_ENTRY_RESOURCE.entries:
                    if res_type.id != 24:   # RT_MANIFEST
                        continue
                    for res_id in res_type.directory.entries:
                        for res_lang in res_id.directory.entries:
                            off = pe.get_offset_from_rva(res_lang.data.struct.OffsetToData)
                            sz  = res_lang.data.struct.Size
                            if len(_MANIFEST) <= sz:
                                result[off:off + len(_MANIFEST)] = _MANIFEST
                                result[off + len(_MANIFEST):off + sz] = b'\x00' * (sz - len(_MANIFEST))
        except Exception:
            pass

        # ── 5. Recalculate PE optional-header checksum ──────────────────────────
        try:
            pe_tmp = _pefile.PE(data=bytes(result), fast_load=True)
            new_cs  = pe_tmp.generate_checksum()
            opt_off = pe_tmp.OPTIONAL_HEADER.get_file_offset()
            # CheckSum is at offset 64 from the start of the optional header
            # for both PE32 (32-bit) and PE32+ (64-bit).
            _struct.pack_into('<I', result, opt_off + 64, new_cs)
        except Exception:
            pass

        return bytes(result)
    except Exception:
        return exe_bytes


def _replace_pe_icons(exe_bytes: bytes, preset: str) -> bytes:
    """Replace RT_ICON resources in a PE file with brand-logo icons.

    Key correctness requirement: the PNG written into each RT_ICON slot must be
    at the EXACT pixel dimensions that RT_GROUP_ICON declares for that slot.
    Windows reads RT_GROUP_ICON to decide which RT_ICON to use for a given
    display size, then reads the actual PNG from that slot.  If the PNG
    dimensions don't match what RT_GROUP_ICON says, Windows may silently ignore
    the slot and show a blank or default icon.

    To fit large brand logos into the original (small) slot bytes we quantise
    the RGBA image to fewer unique colour values before PNG compression, which
    dramatically shrinks the DEFLATE output while keeping the PNG colour type as
    32-bit RGBA (the only type Windows accepts for icon PNGs).
    """
    cfg = _ICON_PRESETS.get(preset)
    if not cfg:
        return exe_bytes
    bg = cfg['bg']
    logo_file = cfg.get('logo_file', '')
    try:
        import pefile as _pefile
        pe = _pefile.PE(data=exe_bytes, fast_load=True)
        pe.parse_data_directories(directories=[
            _pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_RESOURCE']
        ])
        if not hasattr(pe, 'DIRECTORY_ENTRY_RESOURCE'):
            return exe_bytes

        # ── Step 1: read RT_GROUP_ICON to learn which RT_ICON ID maps to which size ──
        # GRPICONDIRENTRY layout (14 bytes):
        #   BYTE bWidth, BYTE bHeight, BYTE bColorCount, BYTE bReserved,
        #   WORD wPlanes, WORD wBitCount, DWORD dwBytesInRes, WORD nId
        icon_id_to_size: dict[int, int] = {}  # icon_id → pixel dimension (square)
        for res_type in pe.DIRECTORY_ENTRY_RESOURCE.entries:
            if res_type.id != _pefile.RESOURCE_TYPE['RT_GROUP_ICON']:
                continue
            for res_id in res_type.directory.entries:
                for res_lang in res_id.directory.entries:
                    off = pe.get_offset_from_rva(res_lang.data.struct.OffsetToData)
                    grp = exe_bytes[off:off + res_lang.data.struct.Size]
                    count = _struct.unpack_from('<H', grp, 4)[0]
                    for i in range(count):
                        e = 6 + i * 14
                        bW = grp[e]       # 0 means 256
                        n_id = _struct.unpack_from('<H', grp, e + 12)[0]
                        icon_id_to_size[n_id] = bW if bW > 0 else 256

        # ── Step 2: patch each RT_ICON slot at the correct dimensions ──
        result = bytearray(exe_bytes)
        for res_type in pe.DIRECTORY_ENTRY_RESOURCE.entries:
            if res_type.id != _pefile.RESOURCE_TYPE['RT_ICON']:
                continue
            for res_id in res_type.directory.entries:
                icon_id = res_id.id  # matches nId in RT_GROUP_ICON
                px = icon_id_to_size.get(icon_id, 0)
                for res_lang in res_id.directory.entries:
                    rva = res_lang.data.struct.OffsetToData
                    orig_size = res_lang.data.struct.Size
                    file_off = pe.get_offset_from_rva(rva)
                    probe = bytes(exe_bytes[file_off:file_off + 8])

                    if probe[:4] == b'\x89PNG':
                        if px > 0:
                            # Generate PNG at exactly the right dimensions, quantised
                            # to reduce file size so it fits within orig_size bytes.
                            new_data = _make_png_for_slot(bg, px, logo_file, orig_size)
                        else:
                            new_data = b''
                    elif len(probe) >= 8:
                        # BMP slot
                        icon_w = abs(_struct.unpack('<i', probe[4:8])[0])
                        if icon_w <= 0 or icon_w > 512:
                            continue
                        new_data = _make_bmp_icon_data(bg, icon_w, logo_file)
                    else:
                        continue

                    if new_data and len(new_data) <= orig_size:
                        result[file_off:file_off + len(new_data)] = new_data
                        result[file_off + len(new_data):file_off + orig_size] = (
                            b'\x00' * (orig_size - len(new_data))
                        )

        return bytes(result)
    except Exception:
        return exe_bytes


def _fetch_release_binary_full() -> bytes | None:
    """Download the latest release EXE into memory so we can patch it."""
    release = _latest_release_data()
    if not release:
        return None
    asset_id = release.get('assetId')
    repo = _release_repo()
    if not repo or not asset_id:
        return None

    import urllib.request as _ureq2
    import urllib.error as _uerr2

    class _StopRedirect(_ureq2.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
            return None

    req = _github_api_request(
        f'https://api.github.com/repos/{repo}/releases/assets/{asset_id}',
        accept='application/octet-stream',
    )
    s3_url = ''
    try:
        opener = _ureq2.build_opener(_StopRedirect)
        opener.open(req, timeout=15)
    except _uerr2.HTTPError as _e:
        if _e.code in (301, 302, 303, 307, 308):
            s3_url = _e.headers.get('Location', '')
    except Exception:
        pass

    if not s3_url:
        return None
    try:
        with _ureq2.urlopen(s3_url, timeout=120) as resp:  # nosec B310
            return resp.read()
    except Exception:
        return None


@web_bp.route('/api/dashboard/build-exe', methods=['POST'])
def dashboard_build_exe():
    """Build and return a metadata-patched EXE customised for the requesting user."""
    user, err = _dashboard_user_or_401()
    if err:
        return err

    ip = _client_ip()
    limiter = get_limiter()
    if not limiter.check_and_record(f'web:build_exe:{ip}', 4, 60):
        return jsonify({'ok': False, 'error': 'Too many build requests — please wait a minute.'}), 429

    data = request.get_json(silent=True) or {}
    import re as _re

    # Sanitise inputs
    preset = str(data.get('preset') or '').strip().lower()
    file_name = (_re.sub(r'[^A-Za-z0-9._\- ]', '', str(data.get('fileName') or 'App'))[:60].strip() or 'App')
    display_name = str(data.get('displayName') or file_name)[:64].strip()
    company = str(data.get('company') or '')[:64].strip()
    version_str = (_re.sub(r'[^0-9.]', '', str(data.get('version') or '1.0.0.0'))[:20] or '1.0.0.0')
    description = str(data.get('description') or '')[:128].strip()

    # Fetch the base release binary
    exe_bytes = _fetch_release_binary_full()
    if not exe_bytes:
        return jsonify({'ok': False, 'error': 'Could not fetch release — try again shortly.'}), 503

    # Patch version resource strings
    patch_strings: dict[str, str] = {
        'FileDescription': description or display_name,
        'ProductName': display_name,
        'InternalName': file_name,
        'OriginalFilename': f'{file_name}.exe',
        'CompanyName': company,
        'ProductVersion': version_str,
        'FileVersion': version_str,
    }
    if company:
        patch_strings['LegalCopyright'] = f'Copyright \u00a9 {company}'

    patched = _patch_exe_version_strings(exe_bytes, patch_strings)

    # Optionally patch icons (graceful fallback if pefile/Pillow unavailable)
    if preset in _ICON_PRESETS:
        patched = _replace_pe_icons(patched, preset)

    # Patch the ZNTH_PRESET marker so the app knows its disguise preset at runtime.
    if preset:
        marker = b'ZNTH_PRESET:'
        payload = preset.encode('ascii', errors='replace')[:12].ljust(12, b'\x00')
        idx = patched.find(marker)
        if idx != -1:
            patched = bytearray(patched)
            patched[idx + len(marker):idx + len(marker) + 12] = payload
            patched = bytes(patched)

    # Strip compiler fingerprints, replace manifest, recalculate checksum
    if preset in _ICON_PRESETS:
        patched = _sanitize_pe_binary(patched, preset, version_str)

    safe_fname = _re.sub(r'[^A-Za-z0-9._\-]', '_', file_name)
    response = make_response(patched)
    response.headers['Content-Type'] = 'application/octet-stream'
    response.headers['Content-Disposition'] = f'attachment; filename="{safe_fname}.exe"'
    response.headers['Content-Length'] = str(len(patched))
    response.headers['Cache-Control'] = 'no-store'
    audit_event('web.build_exe.ok', ip=ip, user=str(user.get('id', '')), preset=preset,
                file_name=safe_fname, size=len(patched))
    return response


@web_bp.route('/api/client/latest', methods=['GET'])
def client_latest():
    release = _latest_release_data()
    if not release:
        return jsonify({'ok': False, 'error': 'Latest release is not configured yet'}), 503
    return jsonify({
        'ok': True,
        'version': release['version'],
        'publishedAt': release['publishedAt'],
        'assetName': release['assetName'],
        'size': release['assetSize'],
    }), 200


@web_bp.route('/api/affiliate/me', methods=['GET'])
def affiliate_me():
    user, err = _dashboard_user_or_401()
    if err:
        return err
    uid = str(user.get('id') or '').strip()
    rows = _licenses_for_user(user)
    if not rows:
        return jsonify({'ok': False, 'error': 'no_affiliate'}), 200
    active = _choose_summary_license(rows)
    if not active:
        return jsonify({'ok': False, 'error': 'no_affiliate'}), 200
    meta = active.extra_metadata or {}
    aff_code = str(meta.get('affiliate_code') or '').strip()
    if not aff_code:
        return jsonify({'ok': False, 'error': 'no_affiliate'}), 200
    site = str(current_app.config.get('SITE_URL', 'https://zenithmacros.store')).rstrip('/')

    # Compute stats from licenses that used this affiliate code
    all_lics = License.query.all()
    referred = [
        l for l in all_lics
        if str((l.extra_metadata or {}).get('affiliate_code', '')).strip().lower() == aff_code.lower()
        and str((l.extra_metadata or {}).get('discord_id', '')).strip() != uid
    ]
    total_sales = len(referred)
    gross_cents = sum(int((l.extra_metadata or {}).get('charged_cents', 0)) for l in referred)
    commission_rate = float(meta.get('aff_commission_rate', 0.20))
    commission_cents = int(gross_cents * commission_rate)
    paid_out_cents = int(meta.get('aff_paid_out_cents', 0))
    available_cents = max(0, commission_cents - paid_out_cents)

    recent = []
    for l in sorted(referred, key=lambda x: str(x.created_at or ''), reverse=True)[:10]:
        lm = l.extra_metadata or {}
        recent.append({
            'plan': _license_plan(l),
            'charged_cents': int(lm.get('charged_cents', 0)),
            'created_at': _license_created_iso(l),
        })

    # Build 14-day chart data
    from collections import defaultdict
    today = datetime.now(timezone.utc).date()
    day_buckets: dict[str, int] = defaultdict(int)
    for l in referred:
        try:
            iso = str(l.created_at or '')
            if iso:
                d = datetime.fromisoformat(iso.replace('Z', '+00:00')).date()
                if (today - d).days < 14:
                    day_buckets[d.isoformat()] += int((l.extra_metadata or {}).get('charged_cents', 0))
        except Exception:
            pass
    chart = []
    for i in range(13, -1, -1):
        d = (today - timedelta(days=i)).isoformat()
        gross = day_buckets.get(d, 0)
        chart.append({'date': d, 'commission_cents': int(gross * commission_rate)})

    return jsonify({
        'ok': True,
        'code': aff_code,
        'total_sales': total_sales,
        'gross_revenue_cents': gross_cents,
        'total_commission_cents': commission_cents,
        'available_cents': available_cents,
        'pending_cashouts_cents': 0,
        'referral_link_query': f'{site}/?ref={aff_code}',
        'referral_link_path': f'{site}/r/{aff_code}',
        'chart': chart,
        'recent_sales': recent,
    }), 200


@web_bp.route('/api/affiliate/create', methods=['POST'])
def affiliate_create():
    user, err = _dashboard_user_or_401()
    if err:
        return err
    rows = _licenses_for_user(user)
    if not rows:
        return jsonify({'ok': False, 'error': 'No license found. Purchase a plan to access the affiliate program.'}), 403
    active = _choose_summary_license(rows)
    if not active:
        return jsonify({'ok': False, 'error': 'No active license found.'}), 403
    meta = dict(active.extra_metadata or {})
    if meta.get('affiliate_code'):
        return jsonify({'ok': True, 'code': meta['affiliate_code']}), 200
    code = 'zen' + secrets.token_hex(3)  # 6 random hex chars → e.g. zena3f9c2
    # ensure uniqueness via indexed column
    while License.query.filter(License.affiliate_code == code).first():
        code = 'zen' + secrets.token_hex(3)
    meta['affiliate_code'] = code
    active.extra_metadata = meta
    active.affiliate_code = code
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({'ok': False, 'error': 'Database error. Please try again.'}), 500
    return jsonify({'ok': True, 'code': code}), 200


@web_bp.route('/api/affiliate/cashout', methods=['POST'])
def affiliate_cashout():
    user, err = _dashboard_user_or_401()
    if err:
        return err
    return jsonify({
        'ok': False,
        'error': 'Cashout requests must be submitted via a Discord support ticket. Join our server and open a ticket.',
    }), 200


@web_bp.route('/api/dashboard/claim-legacy', methods=['POST'])
def dashboard_claim_legacy():
    user, err = _dashboard_user_or_401()
    if err:
        return err
    if not request.is_json:
        return jsonify({'ok': False, 'error': 'Invalid request'}), 400
    body = request.get_json(silent=True) or {}
    raw_key = str(body.get('key') or '').strip().upper().replace('-', '')
    if len(raw_key) < 6:
        return jsonify({'ok': False, 'error': 'Please enter a valid license key.'}), 400
    uid = str(user.get('id') or '').strip()
    all_rows = License.query.order_by(License.id.desc()).limit(5000).all()
    for lic in all_rows:
        norm_key = str(lic.key or '').strip().upper().replace('-', '')
        if norm_key == raw_key:
            meta = dict(lic.extra_metadata or {})
            existing_owner = str(meta.get('discord_id') or meta.get('discordId') or '').strip()
            if existing_owner and existing_owner != uid:
                return jsonify({'ok': False, 'error': 'This key is already linked to another account.'}), 409
            meta['discord_id'] = uid
            meta['claimed_via'] = 'dashboard'
            lic.extra_metadata = meta
            try:
                db.session.commit()
                return jsonify({'ok': True, 'message': 'Key successfully linked to your account.'}), 200
            except Exception:
                db.session.rollback()
                return jsonify({'ok': False, 'error': 'Database error. Please try again.'}), 500
    return jsonify({'ok': False, 'error': 'Key not found. Check the key and try again, or contact support.'}), 404


@web_bp.route('/api/debug/session', methods=['GET'])
def debug_session():
    cookie_name = str(current_app.config.get('DASHBOARD_COOKIE_NAME', 'zenith_dash'))
    raw = request.cookies.get(cookie_name, '')
    decoded = _decode_session_payload(raw) if raw else None
    return jsonify({
        'cookie_name': cookie_name,
        'cookie_present': bool(raw),
        'cookie_len': len(raw),
        'all_cookies': list(request.cookies.keys()),
        'decode_ok': decoded is not None,
        'user': (decoded.get('user', {}).get('id', 'no_id') if decoded else None),
        'is_secure': request.is_secure,
        'scheme': request.scheme,
        'secret_len': len(_session_secret()),
    })


@web_bp.route('/healthz', methods=['GET'])
def healthz():
    try:
        db.session.execute(db.text('SELECT 1'))
        resp = {
            'ok': True,
            'uptimeSec': int(time.time()),
            'timestamp': _utc_now().isoformat(),
        }
        return jsonify(resp), 200
    except Exception as exc:
        return jsonify({'ok': False, 'error': str(exc)}), 503


@web_bp.route('/', methods=['GET'])
def web_index():
    # Allow Discord OAuth redirect URIs that point to "/" by forwarding
    # callback params into the canonical callback handler.
    if request.args.get('code') or request.args.get('state') or request.args.get('error'):
        query = request.query_string.decode('utf-8', errors='ignore')
        target = '/auth/discord/callback'
        if query:
            target = f'{target}?{query}'
        return redirect(target, code=302)

    target = _safe_web_path('index.html')
    if target is None or not target.exists():
        return make_response('Website not found', 404)
    return send_file(target)


@web_bp.route('/<path:asset_path>', methods=['GET'])
def web_assets(asset_path: str):
    normalized = str(asset_path or '').strip().replace('\\', '/')
    if not normalized:
        return make_response('Not found', 404)

    lowered = normalized.lower()
    if lowered in {'index', 'index.html'}:
        qs = request.query_string.decode('utf-8', errors='ignore')
        target_url = ('/' + ('#' + qs.lstrip('#')) if qs.startswith('#') else ('/?'+qs if qs else '/'))
        return redirect(target_url, code=301)

    if lowered.startswith('api/') or lowered.startswith('v1/') or lowered.startswith('auth/'):
        return make_response('Not found', 404)

    # Keep dashboard route renderable even without a session to avoid auth loops.
    # API endpoints remain protected and dashboard.js already shows login state.

    target = _safe_web_path(normalized)
    if target is None or (not target.exists()) or target.is_dir():
        return make_response('Not found', 404)
    resp = make_response(send_file(target))
    if normalized.endswith('.js') or normalized.endswith('.css') or normalized.endswith('.html'):
        resp.headers['Cache-Control'] = 'no-cache, must-revalidate'
    return resp


# ---------------------------------------------------------------------------
# Stripe webhook — fulfills purchases by creating a License in the DB
# ---------------------------------------------------------------------------

def _sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def _generate_license_key() -> str:
    """Generate a 20-char key using the same alphabet as the bot.
    Avoids ambiguous characters (0/O, 1/I/l)."""
    alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    return ''.join(secrets.choice(alphabet) for _ in range(20))


def _send_license_email(lic: License, user_email: str = '') -> None:
    """Send license key delivery email via SMTP if configured."""
    import smtplib
    import ssl
    from email.mime.text import MIMEText
    from email.mime.multipart import MIMEMultipart

    smtp_host = str(current_app.config.get('SMTP_HOST', '')).strip()
    smtp_port = int(current_app.config.get('SMTP_PORT', 587) or 587)
    smtp_user = str(current_app.config.get('SMTP_USER', '')).strip()
    smtp_pass = str(current_app.config.get('SMTP_PASS', '')).strip()
    email_from = str(current_app.config.get('EMAIL_FROM', smtp_user)).strip()

    meta = lic.extra_metadata or {}
    to_email = user_email or str(meta.get('email', '')).strip()
    if not smtp_host or not smtp_user or not smtp_pass or not to_email:
        return

    plan = _license_plan(lic)
    key_display = str(lic.key or '')
    # Format key nicely as XXXX-XXXX-XXXX-XXXX-XXXX (groups of 4)
    if len(key_display) >= 8:
        key_display = '-'.join(key_display[i:i+4] for i in range(0, len(key_display), 4))

    subject = 'Your Zenith Macros License Key'
    body = f"""Hi there,

Thank you for your purchase of Zenith Macros ({plan} plan)!

Your license key is:

  {key_display}

You can also view and manage your key at any time on your dashboard:
  https://zenithmacros.store/dashboard.html

To activate, paste your key into the Zenith Macros client when prompted.

If you have any issues, join our Discord server for support.

— The Zenith Macros Team
"""
    try:
        msg = MIMEMultipart('alternative')
        msg['Subject'] = subject
        msg['From'] = email_from
        msg['To'] = to_email
        msg.attach(MIMEText(body, 'plain'))

        ctx = ssl.create_default_context()
        with smtplib.SMTP(smtp_host, smtp_port) as server:
            server.ehlo()
            server.starttls(context=ctx)
            server.login(smtp_user, smtp_pass)
            server.sendmail(email_from, [to_email], msg.as_string())
    except Exception as exc:
        audit_event('web.email.failed', error=str(exc)[:200])


def _send_cancellation_email(to_email: str, plan: str = 'monthly') -> None:
    """Send a subscription cancellation confirmation email."""
    import smtplib, ssl
    from email.mime.text import MIMEText
    from email.mime.multipart import MIMEMultipart

    smtp_host  = str(current_app.config.get('SMTP_HOST', '')).strip()
    smtp_port  = int(current_app.config.get('SMTP_PORT', 587) or 587)
    smtp_user  = str(current_app.config.get('SMTP_USER', '')).strip()
    smtp_pass  = str(current_app.config.get('SMTP_PASS', '')).strip()
    email_from = str(current_app.config.get('EMAIL_FROM', smtp_user)).strip()

    if not smtp_host or not smtp_user or not smtp_pass or not to_email:
        return

    subject = 'Your Zenith Macros subscription has been cancelled'
    body = f"""Hi there,

We're confirming that your Zenith Macros {plan} subscription has been cancelled.

You'll keep access until the end of your current billing period.

If you cancelled by mistake or want to resubscribe, you can do so anytime at:
  https://zenithmacros.store/#pricing

If you have any questions or feedback, feel free to reach out on our Discord.

— The Zenith Macros Team
"""
    try:
        msg = MIMEMultipart('alternative')
        msg['Subject'] = subject
        msg['From']    = email_from
        msg['To']      = to_email
        msg.attach(MIMEText(body, 'plain'))
        ctx = ssl.create_default_context()
        with smtplib.SMTP(smtp_host, smtp_port) as server:
            server.ehlo()
            server.starttls(context=ctx)
            server.login(smtp_user, smtp_pass)
            server.sendmail(email_from, [to_email], msg.as_string())
        audit_event('web.email.cancellation_sent', email=to_email[:6] + '***')
    except Exception as exc:
        audit_event('web.email.failed', error=str(exc)[:200])


def _send_referrer_dm(affiliate_code: str, buyer_discord_id: str, plan: str) -> None:
    """DM the affiliate code owner when someone uses their referral code."""
    import sys as _sys
    bot_token = str(current_app.config.get('DISCORD_BOT_TOKEN', '')).strip()
    if not bot_token or not affiliate_code:
        return

    # Look up who owns this affiliate code
    try:
        owner_lic = License.query.filter(
            License.affiliate_code == affiliate_code.lower()
        ).first()
        if not owner_lic:
            return
        owner_meta   = owner_lic.extra_metadata or {}
        owner_discord = str(owner_meta.get('discord_id', '')).strip()
        if not owner_discord:
            return
        # Never DM the buyer themselves (shouldn't happen — validated at checkout — but be safe)
        if owner_discord == buyer_discord_id:
            return
    except Exception as exc:
        print(f'[referrer_dm] lookup failed code={affiliate_code} error={exc}', file=_sys.stderr)
        return

    if plan == 'lifetime':
        plan_label = 'Lifetime license'
    elif plan == '3month':
        plan_label = '3-Month subscription'
    else:
        plan_label = 'Monthly subscription'

    embed = {
        'title': '🎉 Someone Used Your Referral Code!',
        'color': 0x22c55e,
        'description': (
            f'Great news — someone just purchased a **{plan_label}** using your referral code **`{affiliate_code}`**! 🔥\n\n'
            'Your commission has been tracked and will be added to your affiliate balance.\n\n'
            '**Check your stats anytime:**\n'
            '> Log into **https://zenithmacros.store/dashboard** and open the **Affiliate** tab\n\n'
            '**Keep sharing your link to earn more:**\n'
            f'> `zenithmacros.store/?ref={affiliate_code}`\n\n'
            '💜 Thank you for supporting Zenith Macros!'
        ),
        'footer': {'text': 'Zenith Macros Affiliate Program'},
    }

    try:
        from urllib.request import Request as _Req, urlopen as _open
        dm_body = json.dumps({'recipient_id': owner_discord}).encode()
        dm_req  = _Req(
            'https://discord.com/api/v10/users/@me/channels',
            data=dm_body,
            headers={'Authorization': f'Bot {bot_token}', 'Content-Type': 'application/json'},
            method='POST',
        )
        with _open(dm_req, timeout=8) as resp:
            dm_channel = json.loads(resp.read())
        channel_id = dm_channel.get('id', '')
        if not channel_id:
            return
        msg_body = json.dumps({'embeds': [embed]}).encode()
        msg_req  = _Req(
            f'https://discord.com/api/v10/channels/{channel_id}/messages',
            data=msg_body,
            headers={'Authorization': f'Bot {bot_token}', 'Content-Type': 'application/json'},
            method='POST',
        )
        with _open(msg_req, timeout=8) as _:
            pass
    except Exception as exc:
        print(f'[referrer_dm] send failed owner={owner_discord} code={affiliate_code} error={exc}', file=_sys.stderr)


def _send_purchase_dm(discord_id: str, plan: str, product_name: str | None = None) -> None:
    """DM the buyer via Discord bot token with a thank-you and onboarding message."""
    import sys as _sys
    bot_token = str(current_app.config.get('DISCORD_BOT_TOKEN', '')).strip()
    if not bot_token or not discord_id:
        return

    is_standalone = plan.startswith('standalone:')
    if is_standalone:
        item_label = product_name or plan.removeprefix('standalone:')
        purchase_line = f'your **{item_label}** individual macro'
    elif plan == 'lifetime':
        purchase_line = 'your **Lifetime** Zenith Macros license'
    elif plan == '3month':
        purchase_line = 'your **3-Month** Zenith Macros subscription'
    else:
        purchase_line = 'your **Monthly** Zenith Macros subscription'

    embed = {
        'title': '🎉 Thanks for Your Purchase!',
        'color': 0x8b5cf6,
        'description': (
            f'Thank you for purchasing {purchase_line}! We really appreciate your support. 💜\n\n'
            '**Here\'s how to get started:**\n'
            '1. Head to **https://zenithmacros.store/** and log in with your Discord account\n'
            '2. Click **Dashboard** — your license key will be right there\n'
            '3. On the left sidebar, click **Downloads** to grab the latest version\n\n'
            '📺 **Need help? Watch our setup videos:**\n'
            '> https://www.youtube.com/watch?v=dS28782lZn4\n'
            '> https://www.youtube.com/watch?v=FRY-vCEq9iU&t=48s\n\n'
            '**Have questions or suggestions?**\n'
            '• Open a **support ticket** in our Discord server for help\n'
            '• Drop ideas in the **#suggestions** channel — we\'d love your feedback!\n\n'
            '⭐ **Enjoying Zenith Macros?** Use `/rating` in our Discord server to leave a review — it means the world to us!'
        ),
        'footer': {'text': 'Zenith Macros • Thank you for your support!'},
    }

    try:
        from urllib.request import Request as _Req, urlopen as _open
        # Step 1: create DM channel
        dm_body = json.dumps({'recipient_id': discord_id}).encode()
        dm_req = _Req(
            'https://discord.com/api/v10/users/@me/channels',
            data=dm_body,
            headers={
                'Authorization': f'Bot {bot_token}',
                'Content-Type': 'application/json',
            },
            method='POST',
        )
        with _open(dm_req, timeout=8) as resp:
            dm_channel = json.loads(resp.read())
        channel_id = dm_channel.get('id', '')
        if not channel_id:
            return
        # Step 2: send message
        msg_body = json.dumps({'embeds': [embed]}).encode()
        msg_req = _Req(
            f'https://discord.com/api/v10/channels/{channel_id}/messages',
            data=msg_body,
            headers={
                'Authorization': f'Bot {bot_token}',
                'Content-Type': 'application/json',
            },
            method='POST',
        )
        with _open(msg_req, timeout=8) as _:
            pass
    except Exception as exc:
        print(f'[purchase_dm] failed discord_id={discord_id} error={exc}', file=_sys.stderr)


def _post_sale_notification(discord_id: str, plan: str, charged_cents: int,
                            license_key: str = '', user_email: str = '',
                            stripe_ref: str = '', affiliate_code: str | None = None,
                            product_name: str | None = None) -> None:
    """Post a sale notification via Discord webhook URL or bot channel message."""
    import sys as _sys
    from datetime import datetime, timezone as _tz

    amount = f'${charged_cents / 100:.2f}'
    is_standalone = plan.startswith('standalone:')

    if is_standalone:
        plan_label = product_name or plan.removeprefix('standalone:')
        plan_color = 0x22c55e   # green for individual macros
        title = f'🎉 Individual Macro Sale — {plan_label}'
        footer_text = 'Zenith Macros • Individual Macros'
    else:
        plan_label = 'Lifetime Access' if plan == 'lifetime' else 'Monthly Access'
        plan_color = 0x7c3aed if plan == 'lifetime' else 0x6366f1
        title = '🎉 New Sale — Zenith Macros'
        footer_text = 'Zenith Macros • Purchase System'

    key_display = license_key
    if len(key_display) >= 8:
        key_display = '-'.join(key_display[i:i+4] for i in range(0, len(key_display), 4))

    fields = [
        {'name': '👤 Buyer', 'value': f'<@{discord_id}>', 'inline': True},
        {'name': '📦 ' + ('Product' if is_standalone else 'Plan'), 'value': plan_label, 'inline': True},
        {'name': '💰 Amount', 'value': amount, 'inline': True},
    ]
    if user_email:
        fields.append({'name': '📧 Email', 'value': user_email, 'inline': True})
    if key_display:
        fields.append({'name': '🔑 License Key', 'value': f'`{key_display}`', 'inline': False})
    if affiliate_code:
        fields.append({'name': '🔗 Referral', 'value': f'`{affiliate_code}`', 'inline': True})
    if stripe_ref:
        short_ref = stripe_ref[:24] + '…' if len(stripe_ref) > 24 else stripe_ref
        fields.append({'name': '🧾 Stripe Ref', 'value': f'`{short_ref}`', 'inline': True})

    embed = {
        'title': title,
        'color': plan_color,
        'fields': fields,
        'footer': {'text': footer_text},
        'timestamp': datetime.now(_tz.utc).isoformat(),
    }
    body = json.dumps({'embeds': [embed]}).encode()

    # Prefer DISCORD_ORDER_WEBHOOK (webhook URL) if set
    webhook_url = str(current_app.config.get('DISCORD_ORDER_WEBHOOK', '')).strip()
    if webhook_url:
        try:
            req = Request(webhook_url, data=body, headers={
                'Content-Type': 'application/json',
                'User-Agent': 'DiscordBot (https://zenithmacros.store, 1.0)',
            }, method='POST')
            with urlopen(req, timeout=8) as resp:
                resp.read()
            return
        except Exception as exc:
            print(f'[sale_notification] webhook failed discord_id={discord_id} error={exc}', file=_sys.stderr)
        return

    # Fall back to bot API + channel ID
    bot_token = str(current_app.config.get('DISCORD_BOT_TOKEN', '')).strip()
    channel_id = str(current_app.config.get('DISCORD_SALE_CHANNEL_ID', '')).strip()
    if not bot_token or not channel_id:
        print(f'[sale_notification] no webhook URL and no bot_token/channel_id configured', file=_sys.stderr)
        return
    try:
        req = Request(
            f'https://discord.com/api/v10/channels/{channel_id}/messages',
            data=body,
            headers={
                'Authorization': f'Bot {bot_token}',
                'Content-Type': 'application/json',
            },
            method='POST',
        )
        with urlopen(req, timeout=8) as resp:
            resp.read()
    except Exception as exc:
        print(f'[sale_notification] bot API failed discord_id={discord_id} channel={channel_id} error={exc}', file=_sys.stderr)


def _fulfill_purchase(stripe_ref: str, discord_id: str, plan: str, charged_cents: int,
                      affiliate_code: str | None, coupon_code: str | None,
                      user_email: str = '', stripe_customer: str = '') -> None:
    existing = License.query.filter(
        License._metadata.like(f'%"stripe_ref": "{stripe_ref}"%')
    ).first()
    if existing:
        return

    normalized = _generate_license_key()
    while License.query.filter_by(key_hash=_sha256_hex(normalized)).first() is not None:
        normalized = _generate_license_key()

    if plan == 'monthly':
        expires_at = datetime.now(timezone.utc) + timedelta(days=30)
    elif plan == '3month':
        expires_at = datetime.now(timezone.utc) + timedelta(days=90)
    else:
        expires_at = None

    meta: dict = {
        'discord_id': discord_id,
        'plan': plan,
        'stripe_ref': stripe_ref,
        'charged_cents': charged_cents,
    }
    if affiliate_code:
        meta['affiliate_code'] = affiliate_code
    if coupon_code:
        meta['coupon_code'] = coupon_code
    if user_email:
        meta['user_email'] = user_email
    if stripe_customer:
        meta['stripe_customer'] = stripe_customer

    lic = License(
        key=normalized,
        key_hash=_sha256_hex(normalized),
        user_enc_key=secrets.token_hex(32),
        user_salt=secrets.token_hex(16),
        hwid_change_count=0,
        tier=plan,
        is_revoked=False,
        expires_at=expires_at,
    )
    lic.extra_metadata = meta
    db.session.add(lic)
    db.session.commit()
    audit_event('web.stripe.fulfilled', license_id=lic.id, plan=plan, discord_id=discord_id)
    _send_license_email(lic, user_email=user_email)
    _post_sale_notification(discord_id, plan, charged_cents,
                            license_key=str(lic.key or ''),
                            user_email=user_email,
                            stripe_ref=stripe_ref,
                            affiliate_code=affiliate_code)
    _send_purchase_dm(discord_id, plan)
    if affiliate_code:
        _send_referrer_dm(affiliate_code, discord_id, plan)
    grant_customer_role(discord_id, current_app.config)


@web_bp.route('/api/stripe/webhook', methods=['POST'])
def stripe_webhook():
    webhook_secret = str(current_app.config.get('STRIPE_WEBHOOK_SECRET', '')).strip()
    if not webhook_secret:
        return jsonify({'ok': False, 'error': 'Webhook not configured'}), 501

    payload = request.get_data()
    sig = request.headers.get('Stripe-Signature', '')

    try:
        import stripe as _stripe
        event = _stripe.Webhook.construct_event(payload, sig, webhook_secret)
    except Exception:
        return jsonify({'ok': False}), 400

    # stripe-python v5+ returns StripeObjects that lack .get(); convert to plain dict
    try:
        event_dict = event.to_dict()
    except Exception:
        event_dict = dict(event)

    et = event_dict.get('type', '')
    obj = (event_dict.get('data') or {}).get('object') or {}
    meta = dict(obj.get('metadata') or {})

    discord_id = str(meta.get('discord_id', '')).strip()
    plan = str(meta.get('plan', 'monthly')).strip().lower()
    if plan not in {'monthly', '3month', 'lifetime'}:
        plan = 'monthly'
    affiliate_code = meta.get('affiliate_code') or None
    coupon_code = meta.get('coupon_code') or None

    if et == 'checkout.session.completed' and discord_id:
        stripe_ref = str(obj.get('payment_intent') or obj.get('id') or '')
        charged_cents = int(obj.get('amount_total') or 0)
        customer_details = obj.get('customer_details') or {}
        user_email = str(
            customer_details.get('email') or obj.get('customer_email') or ''
        ).strip()
        stripe_customer = str(obj.get('customer') or '').strip()

        if meta.get('type') == 'standalone':
            # Support multi-product cart (product_ids) and single product (product_id)
            pids_raw = str(meta.get('product_ids') or meta.get('product_id') or '').strip()
            pids = [p.strip() for p in pids_raw.split(',') if p.strip()]
            # Distribute the total charge evenly across products so the sale
            # notification shows the real price instead of $0.00
            per_product_cents = (charged_cents // len(pids)) if pids else 0
            for pid in pids:
                _fulfill_standalone(stripe_ref + f':{pid}', discord_id, pid, per_product_cents, user_email)
        else:
            _fulfill_purchase(stripe_ref, discord_id, plan, charged_cents, affiliate_code, coupon_code, user_email, stripe_customer=stripe_customer)

    elif et == 'payment_intent.succeeded' and discord_id:
        stripe_ref = str(obj.get('id') or '')
        charged_cents = int(obj.get('amount_received') or obj.get('amount') or 0)
        _fulfill_purchase(stripe_ref, discord_id, plan, charged_cents, affiliate_code, coupon_code)

    elif et == 'customer.subscription.deleted':
        # Subscription fully cancelled — send confirmation email
        customer_id = str(obj.get('customer') or '').strip()
        cancel_plan  = str((obj.get('metadata') or {}).get('plan', 'monthly')).strip() or 'monthly'
        user_email   = ''

        # Try to get email from Stripe customer object
        if customer_id:
            try:
                import stripe as _stripe
                stripe_key = str(current_app.config.get('STRIPE_SECRET_KEY', '')).strip()
                _stripe.api_key = stripe_key
                customer = _stripe.Customer.retrieve(customer_id)
                user_email = str(getattr(customer, 'email', '') or '').strip()
            except Exception:
                pass

        # Fall back: look up email in license metadata
        if not user_email and customer_id:
            lic = License.query.filter(
                License._metadata.like(f'%"stripe_customer": "{customer_id}"%')
            ).first()
            if lic:
                user_email = str((lic.extra_metadata or {}).get('email', '')).strip()

        if user_email:
            with current_app.app_context():
                _send_cancellation_email(user_email, cancel_plan)

        audit_event('web.subscription.cancelled', customer=customer_id, email=user_email[:6] + '***' if user_email else '')

    return jsonify({'ok': True})


@web_bp.route('/api/admin/test-discord', methods=['POST'])
def test_discord():
    """Admin endpoint to test Discord role grant and webhook notification."""
    data = request.get_json(silent=True) or {}
    # Accept either dashboard session OR admin token for quick testing
    token = str(data.get('token') or request.headers.get('X-Admin-Token') or '').strip()
    expected = str(current_app.config.get('BOT_API_TOKEN', '') or current_app.config.get('ADMIN_SECRET', '')).strip()
    if not token or not expected or token != expected:
        user, err = _dashboard_user_or_401()
        if err:
            return err
        discord_id = str(data.get('discord_id') or user.get('id') or '').strip()
    else:
        discord_id = str(data.get('discord_id') or '').strip()
    if not discord_id:
        return jsonify({'ok': False, 'error': 'No discord_id'}), 400
    if not discord_id:
        return jsonify({'ok': False, 'error': 'No discord_id'}), 400

    results = {}

    # Test role grant
    bot_token = str(current_app.config.get('DISCORD_BOT_TOKEN', '')).strip()
    guild_id = str(current_app.config.get('DISCORD_GUILD_ID', '')).strip()
    role_id = str(current_app.config.get('DISCORD_CUSTOMER_ROLE_ID', '')).strip()
    results['role_config'] = {
        'has_bot_token': bool(bot_token),
        'guild_id': guild_id,
        'role_id': role_id,
    }
    if bot_token and guild_id and role_id:
        url = f'https://discord.com/api/v10/guilds/{guild_id}/members/{discord_id}/roles/{role_id}'
        try:
            from urllib.request import Request as _Req, urlopen as _open
            from urllib.error import HTTPError as _HTTPError
            req = _Req(url, data=b'', headers={
                'Authorization': f'Bot {bot_token}',
                'Content-Type': 'application/json',
            }, method='PUT')
            with _open(req, timeout=8) as resp:
                results['role_grant'] = {'ok': True, 'status': resp.status}
        except _HTTPError as exc:
            body = exc.read(512).decode(errors='replace')
            results['role_grant'] = {'ok': False, 'status': exc.code, 'body': body}
        except Exception as exc:
            results['role_grant'] = {'ok': False, 'error': str(exc)}

    # Test webhook notification
    webhook_url = str(current_app.config.get('DISCORD_ORDER_WEBHOOK', '')).strip()
    results['webhook_config'] = {'has_webhook_url': bool(webhook_url)}
    if webhook_url:
        try:
            body = json.dumps({'content': f'🔧 Test notification for <@{discord_id}>'}).encode()
            from urllib.request import Request as _Req, urlopen as _open
            req = _Req(webhook_url, data=body, headers={'Content-Type': 'application/json', 'User-Agent': 'DiscordBot (https://zenithmacros.store, 1.0)'}, method='POST')
            with _open(req, timeout=8) as resp:
                results['webhook'] = {'ok': True, 'status': resp.status}
        except Exception as exc:
            results['webhook'] = {'ok': False, 'error': str(exc)}

    return jsonify({'ok': True, 'results': results})


@web_bp.route('/api/admin/lookup-license', methods=['POST'])
def admin_lookup_license():
    """Admin endpoint: look up a license by email or stripe_ref and optionally resend it."""
    data = request.get_json(silent=True) or {}
    token = str(data.get('token') or request.headers.get('X-Admin-Token') or '').strip()
    expected = str(current_app.config.get('BOT_API_TOKEN', '') or current_app.config.get('ADMIN_SECRET', '')).strip()
    authed = token and expected and token == expected
    if not authed:
        user, err = _dashboard_user_or_401()
        if err:
            return err

    email = str(data.get('email', '')).strip().lower()
    stripe_ref = str(data.get('stripe_ref', '')).strip()
    resend = bool(data.get('resend', False))

    licenses = []
    if email:
        all_lics = License.query.all()
        for l in all_lics:
            meta = l.extra_metadata or {}
            lic_email = str(meta.get('email', '')).strip().lower()
            # Also check user_email stored in metadata
            lic_user_email = str(meta.get('user_email', '')).strip().lower()
            if email in (lic_email, lic_user_email):
                licenses.append(l)
    elif stripe_ref:
        licenses = License.query.filter(
            License._metadata.like(f'%"{stripe_ref}"%')
        ).all()

    if not licenses:
        return jsonify({'ok': False, 'error': 'No license found', 'email': email, 'stripe_ref': stripe_ref}), 404

    results = []
    for lic in licenses:
        meta = lic.extra_metadata or {}
        entry = {
            'id': lic.id,
            'key': str(lic.key or ''),
            'tier': lic.tier,
            'is_revoked': lic.is_revoked,
            'expires_at': lic.expires_at.isoformat() if lic.expires_at else None,
            'discord_id': meta.get('discord_id', ''),
            'stripe_ref': meta.get('stripe_ref', ''),
            'plan': meta.get('plan', ''),
        }
        if resend and email:
            try:
                _send_license_email(lic, user_email=email)
                entry['resent'] = True
            except Exception as exc:
                entry['resent'] = False
                entry['resend_error'] = str(exc)[:200]
        results.append(entry)

    return jsonify({'ok': True, 'licenses': results})


# ---------------------------------------------------------------------------
# Admin: product catalog + entitlement management
# ---------------------------------------------------------------------------

def _require_admin_token():
    """Returns None if authed, or a Response if not."""
    data = request.get_json(silent=True) or {}
    token = str(data.get('token') or request.headers.get('X-Admin-Token') or '').strip()
    expected = str(current_app.config.get('BOT_API_TOKEN', '') or
                   current_app.config.get('ADMIN_SECRET', '')).strip()
    if token and expected and token == expected:
        return None, data
    user, err = _dashboard_user_or_401()
    if err:
        return err, data
    return None, data


@web_bp.route('/api/admin/products', methods=['GET'])
def admin_list_products():
    err, _ = _require_admin_token()
    if err:
        return err
    products = Product.query.order_by(Product.sort_order).all()
    return jsonify({'ok': True, 'items': [
        {**p.to_dict(), 'stripe_price_id': p.stripe_price_id, 'download_ref': p.download_ref}
        for p in products
    ]}), 200


@web_bp.route('/api/admin/products', methods=['POST'])
def admin_create_product():
    err, data = _require_admin_token()
    if err:
        return err
    pid = str(data.get('id') or '').strip()
    name = str(data.get('name') or '').strip()
    if not pid or not name:
        return jsonify({'ok': False, 'error': 'id and name required'}), 400
    if Product.query.get(pid):
        return jsonify({'ok': False, 'error': 'Product already exists'}), 409
    p = Product(
        id=pid,
        name=name,
        description=str(data.get('description') or ''),
        price_cents=int(data.get('price_cents') or 500),
        stripe_price_id=str(data.get('stripe_price_id') or '') or None,
        badge=str(data.get('badge') or '') or None,
        sort_order=int(data.get('sort_order') or 0),
        download_ref=str(data.get('download_ref') or '') or None,
    )
    db.session.add(p)
    db.session.commit()
    return jsonify({'ok': True, 'product': p.to_dict()}), 201


@web_bp.route('/api/admin/products/<product_id>', methods=['PATCH'])
def admin_update_product(product_id):
    err, data = _require_admin_token()
    if err:
        return err
    p = Product.query.get(product_id)
    if not p:
        return jsonify({'ok': False, 'error': 'Not found'}), 404
    for field in ('name', 'description', 'price_cents', 'stripe_price_id',
                  'is_active', 'sort_order', 'download_ref', 'badge', 'bundle_items'):
        if field in data:
            setattr(p, field, data[field])
    db.session.commit()
    return jsonify({'ok': True, 'product': p.to_dict()}), 200


@web_bp.route('/api/admin/entitlements/grant', methods=['POST'])
def admin_grant_entitlement():
    """Manually grant a standalone product entitlement by license key."""
    err, data = _require_admin_token()
    if err:
        return err
    raw_key = str(data.get('license_key') or '').strip()
    product_id = str(data.get('product_id') or '').strip()
    if not raw_key or not product_id:
        return jsonify({'ok': False, 'error': 'license_key and product_id required'}), 400

    from auth.routes import _lookup_license_by_key
    lic = _lookup_license_by_key(raw_key)
    if not lic:
        return jsonify({'ok': False, 'error': 'License not found'}), 404

    product = Product.query.get(product_id)
    if not product:
        return jsonify({'ok': False, 'error': 'Product not found'}), 404

    existing = UserEntitlement.query.filter_by(
        license_key_hash=lic.key_hash, product_id=product_id
    ).first()
    if existing:
        return jsonify({'ok': True, 'message': 'Already granted', 'granted_at': existing.granted_at.isoformat()}), 200

    ent = UserEntitlement(
        license_key_hash=lic.key_hash,
        product_id=product_id,
        charged_cents=0,
    )
    db.session.add(ent)
    db.session.commit()
    audit_event('admin.entitlement.grant', product_id=product_id, license_id=lic.id)
    return jsonify({'ok': True, 'message': 'Entitlement granted'}), 201


@web_bp.route('/api/admin/entitlements/revoke', methods=['POST'])
def admin_revoke_entitlement():
    err, data = _require_admin_token()
    if err:
        return err
    raw_key = str(data.get('license_key') or '').strip()
    product_id = str(data.get('product_id') or '').strip()
    if not raw_key or not product_id:
        return jsonify({'ok': False, 'error': 'license_key and product_id required'}), 400

    from auth.routes import _lookup_license_by_key
    lic = _lookup_license_by_key(raw_key)
    if not lic:
        return jsonify({'ok': False, 'error': 'License not found'}), 404

    ent = UserEntitlement.query.filter_by(
        license_key_hash=lic.key_hash, product_id=product_id
    ).first()
    if not ent:
        return jsonify({'ok': False, 'error': 'Entitlement not found'}), 404

    db.session.delete(ent)
    db.session.commit()
    audit_event('admin.entitlement.revoke', product_id=product_id, license_id=lic.id)
    return jsonify({'ok': True, 'message': 'Entitlement revoked'}), 200


# ── Tauri auto-updater endpoint ──────────────────────────────────────────────

# Cache: (version, url, signature, notes, fetched_at_ms)
_updater_cache: dict = {}
_UPDATER_CACHE_TTL_MS = 60_000  # 60 seconds


def _fetch_updater_data() -> dict | None:
    """
    Query the latest GitHub release to get updater metadata.
    Looks for a .nsis.zip asset and its matching .sig file.
    Falls back to Fly secrets (TAURI_UPDATE_*) if GitHub is unavailable or not configured.
    Results are cached for 60 seconds.
    """
    import os as _os

    now = _unix_ms()
    cached = _updater_cache.get('data')
    if cached and (now - int(_updater_cache.get('ts_ms') or 0)) < _UPDATER_CACHE_TTL_MS:
        return cached  # type: ignore[return-value]

    # Try GitHub first (dynamic — no Fly secrets needed after each release)
    if _github_release_ready():
        try:
            repo = _release_repo()
            req = _github_api_request(f'https://api.github.com/repos/{repo}/releases/latest')
            payload = _json_from_url(req)
            assets = payload.get('assets') or []
            version = str(payload.get('tag_name') or '').strip()
            notes = str(payload.get('body') or '').strip()[:2000]

            # Find the .nsis.zip update bundle and its .sig
            zip_asset = next(
                (a for a in assets if str(a.get('name', '')).lower().endswith('.nsis.zip')),
                None
            )
            sig_asset = next(
                (a for a in assets if str(a.get('name', '')).lower().endswith('.nsis.zip.sig')),
                None
            )

            if zip_asset and sig_asset and version:
                # Fetch signature content (it's a small text file)
                sig_req = _github_api_request(
                    sig_asset.get('url', ''),
                    accept='application/octet-stream',
                )
                sig_content = urlopen(sig_req, timeout=10).read().decode('utf-8').strip()  # type: ignore[arg-type]

                # Resolve the zip download URL.
                # For private repos the direct github.com/releases/download/ URL requires
                # authentication, so the Tauri updater (which sends no auth headers) gets a
                # 404. Instead we ask the GitHub API for the asset with
                # Accept: application/octet-stream — GitHub responds with a 302 redirect to
                # a temporary S3 presigned URL that is publicly accessible (~5 min TTL).
                import urllib.request as _ureq
                import urllib.error as _uerr

                class _NoRedirect(_ureq.HTTPRedirectHandler):
                    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
                        return None

                zip_url = ''
                try:
                    _zip_req = _github_api_request(
                        zip_asset.get('url', ''),
                        accept='application/octet-stream',
                    )
                    _opener = _ureq.build_opener(_NoRedirect)
                    _opener.open(_zip_req, timeout=10)
                except _uerr.HTTPError as _redir_err:
                    if _redir_err.code in (301, 302, 303, 307, 308):
                        zip_url = _redir_err.headers.get('Location', '')
                except Exception:
                    pass

                # Fallback to direct URL if redirect capture failed
                if not zip_url:
                    zip_name = str(zip_asset.get('name', ''))
                    zip_url = f'https://github.com/{repo}/releases/download/{version}/{zip_name}'

                data = {
                    'version': version,
                    'url': zip_url,
                    'signature': sig_content,
                    'notes': notes or f'Update to {version}',
                }
                _updater_cache['data'] = data
                _updater_cache['ts_ms'] = now
                return data
        except Exception:
            pass  # Fall through to env-var fallback

    # Fallback: read from Fly secrets / environment (legacy path)
    latest = str(current_app.config.get('TAURI_UPDATE_VERSION') or _os.environ.get('TAURI_UPDATE_VERSION', '')).strip()
    url = str(current_app.config.get('TAURI_UPDATE_URL') or _os.environ.get('TAURI_UPDATE_URL', '')).strip()
    sig = str(current_app.config.get('TAURI_UPDATE_SIGNATURE') or _os.environ.get('TAURI_UPDATE_SIGNATURE', '')).strip()
    notes_env = str(current_app.config.get('TAURI_UPDATE_NOTES') or _os.environ.get('TAURI_UPDATE_NOTES', '')).strip()

    if latest and url:
        data = {
            'version': latest,
            'url': url,
            'signature': sig,
            'notes': notes_env or f'Update to {latest}',
        }
        _updater_cache['data'] = data
        _updater_cache['ts_ms'] = now
        return data

    return None


@web_bp.route('/api/updater/<target>/<arch>/<current_version>', methods=['GET'])
def tauri_updater(target: str, arch: str, current_version: str):
    """Tauri v2 updater endpoint. Returns 204 if up-to-date, or JSON manifest if update available.

    Reads update metadata dynamically from the latest GitHub release (looks for
    .nsis.zip and .nsis.zip.sig assets). Falls back to TAURI_UPDATE_* Fly secrets
    if GitHub is not configured or unavailable.
    """
    update = _fetch_updater_data()
    if not update:
        return '', 204

    # Proper semver compare — string comparison breaks on e.g. "1.2.9" vs "1.2.10"
    def _parse_ver(v: str):
        parts = v.lstrip('v').split('.')
        try:
            return tuple(int(x) for x in parts[:3])
        except ValueError:
            return (0, 0, 0)

    cv = _parse_ver(current_version)
    lv = _parse_ver(str(update.get('version', '')))
    if lv == (0, 0, 0) or cv >= lv:
        return '', 204

    body: dict = {
        'version': update['version'],
        'url': update['url'],
        'signature': update['signature'],
        'notes': update.get('notes', f"Update to {update['version']}"),
        'pub_date': update.get('pub_date', ''),
    }
    return jsonify(body), 200

