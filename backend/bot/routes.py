"""
Legacy Discord bot compatibility endpoints.

These routes preserve the old `/api/bot/*` contract while delegating to the
current license model and auth rules.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import time
from datetime import datetime, timedelta, timezone

from flask import Blueprint, current_app, jsonify, request

from database import db
from models import License, Product, UserEntitlement
from utils.audit import audit_event
from utils.crypto import sha256_hex
from utils.discord_roles import grant_customer_role, revoke_customer_role
from utils.rate_limiter import get_limiter

bot_bp = Blueprint('bot_compat', __name__)

_AUTH_ERR = {'ok': False, 'error': 'Unauthorized'}
_RATE_ERR = {'ok': False, 'error': 'Too many requests'}
_INPUT_ERR = {'ok': False, 'error': 'Invalid request'}

_KEY_RE = re.compile(r'^[A-Z0-9]{16,24}$')
_BOT_SIG_RE = re.compile(r'^[a-f0-9]{64}$')


def _client_ip() -> str:
    forwarded = request.headers.get('X-Forwarded-For', '')
    if forwarded:
        return forwarded.split(',')[0].strip()
    return request.remote_addr or '0.0.0.0'


def _check_rate(action: str, limit: int = 120) -> bool:
    limiter = get_limiter()
    ip = _client_ip()
    global_limit: int = int(current_app.config.get('GLOBAL_RPM', 60))
    if not limiter.check_and_record(f'bot:{action}:{ip}', max(5, int(limit)), 60):
        return False
    if not limiter.check_and_record(f'bot:global:{ip}', global_limit, 60):
        return False
    return True


def _normalize_api_path(path: str) -> str:
    txt = str(path or '').strip()
    if not txt:
        return '/'
    return txt if txt.startswith('/') else f'/{txt}'


def _sha256_hex_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _legacy_bot_signature(secret: str, method: str, api_path: str, ts_raw: str, raw_body: bytes) -> str:
    canonical = '\n'.join([
        str(method or 'GET').upper(),
        _normalize_api_path(api_path),
        str(ts_raw),
        _sha256_hex_bytes(raw_body or b''),
    ])
    return hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()


def _request_auth_token() -> str:
    auth_header = request.headers.get('Authorization', '')
    token = auth_header.replace('Bearer ', '').strip()
    if token:
        return token
    return request.headers.get('X-API-Token', '').strip()


def _verify_legacy_bot_auth(secret: str) -> bool:
    if not secret:
        return False

    # Legacy direct shared secret header.
    legacy_secret = request.headers.get('x-bot-secret', '').strip()
    if legacy_secret and secrets.compare_digest(legacy_secret, secret):
        return True

    # Legacy signed request headers.
    ts_raw = request.headers.get('x-bot-ts', '').strip()
    sig_raw = request.headers.get('x-bot-signature', '').strip().lower()
    if not re.fullmatch(r'^\d{10,16}$', ts_raw):
        return False
    if _BOT_SIG_RE.fullmatch(sig_raw) is None:
        return False

    try:
        ts = int(ts_raw)
    except (TypeError, ValueError):
        return False

    max_skew_ms = int(current_app.config.get('REQUEST_SIG_SKEW_SECONDS', 300)) * 1000
    now_ms = int(time.time() * 1000)
    if abs(now_ms - ts) > max_skew_ms:
        return False

    raw_body = request.get_data(cache=True) or b''
    expected = _legacy_bot_signature(secret, request.method, request.path, ts_raw, raw_body)
    return secrets.compare_digest(expected, sig_raw)


def _authorized() -> bool:
    token_expected = str(current_app.config.get('BOT_API_TOKEN', '')).strip()
    token = _request_auth_token()
    if token and token_expected and secrets.compare_digest(token, token_expected):
        return True

    secret = str(current_app.config.get('BOT_API_SECRET', token_expected)).strip()
    if _verify_legacy_bot_auth(secret):
        return True
    return False


def _require_json() -> tuple[dict | None, tuple | None]:
    max_body: int = int(current_app.config.get('MAX_JSON_BODY_BYTES', 16_384))
    content_len = request.content_length
    if content_len is not None and content_len > max_body:
        return None, (jsonify(_INPUT_ERR), 413)
    if not request.is_json:
        return None, (jsonify(_INPUT_ERR), 400)
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return None, (jsonify(_INPUT_ERR), 400)
    return data, None


def _normalize_license(raw: str) -> str | None:
    cleaned = re.sub(r'[^A-Za-z0-9]', '', str(raw or '')).upper()
    if _KEY_RE.fullmatch(cleaned) is None:
        return None
    return cleaned


def _format_key(normalized: str) -> str:
    return '-'.join(normalized[i:i + 4] for i in range(0, len(normalized), 4))


def _generate_key() -> str:
    alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    return ''.join(secrets.choice(alphabet) for _ in range(20))


def _to_iso(value):
    if not value:
        return None
    dt = value
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def _meta_note(meta: dict) -> str:
    return str(meta.get('notes') or meta.get('note') or '').strip()


def _meta_set_text(meta: dict, key: str, value: str) -> None:
    text = str(value or '').strip()
    if text:
        meta[key] = text
    else:
        meta.pop(key, None)


def _lookup_stripe_for_discord(discord_id: str) -> tuple[str, 'datetime | None']:
    """
    Given a Discord user ID, scan existing licenses to find one that already has a
    stripe_customer ID in its metadata.  If found, query Stripe for the customer's
    most recent active subscription and return its current_period_end as a datetime.

    Returns (stripe_customer_id, expires_at_datetime | None).
    stripe_customer_id is '' when no match is found.
    """
    if not discord_id:
        return '', None

    # LIKE filter is O(n) but avoids a full table scan in Python; limited to 20 rows
    rows = (
        License.query
        .filter(License._metadata.like(f'%"discord_id": "{discord_id}"%'))
        .filter(License.is_revoked.is_(False))
        .order_by(License.created_at.desc())
        .limit(20)
        .all()
    )

    stripe_cid = ''
    for row in rows:
        meta = row.extra_metadata or {}
        if str(meta.get('discord_id', '')).strip() == discord_id:
            cid = str(meta.get('stripe_customer', '')).strip()
            if cid.startswith('cus_'):
                stripe_cid = cid
                break

    if not stripe_cid:
        return '', None

    # Query Stripe for the latest active subscription period end
    try:
        stripe_key = str(current_app.config.get('STRIPE_SECRET_KEY', '')).strip()
        if not stripe_key:
            return stripe_cid, None
        import stripe as _stripe  # lazy import — stripe may not be installed
        _stripe.api_key = stripe_key
        subs = _stripe.Subscription.list(customer=stripe_cid, limit=10, status='all')
        best_end: 'datetime | None' = None
        for sub in subs.auto_paging_iter():
            if sub.status in ('active', 'trialing', 'past_due'):
                end_ts = getattr(sub, 'current_period_end', None)
                if end_ts:
                    end_dt = datetime.fromtimestamp(int(end_ts), tz=timezone.utc)
                    if best_end is None or end_dt > best_end:
                        best_end = end_dt
        return stripe_cid, best_end
    except Exception:
        # Stripe unavailable or key not configured — still carry over the customer ID
        return stripe_cid, None


def _license_payload(item: License) -> dict:
    meta = item.extra_metadata or {}
    note = _meta_note(meta)
    discord_id = str(meta.get('discord_id') or meta.get('discordId') or '').strip()
    return {
        'id': item.id,
        'key': _format_key(item.key),
        'access': item.tier,
        'tier': item.tier,
        'active': not bool(item.is_revoked),
        'expires_at': _to_iso(item.expires_at),
        'hwid': item.hwid_hash or '',
        'activated_at': _to_iso(item.activated_at),
        'created_at': _to_iso(item.created_at),
        'last_validated': _to_iso(item.last_validated),
        'note': note,
        'notes': note,
        'email': str(meta.get('email') or '').strip(),
        'discord_id': discord_id,
        'affiliate_code': str(meta.get('affiliate_code') or '').strip(),
    }


def _find_by_key(raw_key: str) -> License | None:
    normalized = _normalize_license(raw_key)
    if not normalized:
        return None
    return License.query.filter_by(key_hash=sha256_hex(normalized)).first()


def _parse_days(raw, default: int = 30) -> int | None:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    value = max(1, min(value, 3650))
    return value


def _parse_iso_datetime(raw_value) -> datetime | None:
    text = str(raw_value or '').strip()
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text.replace('Z', '+00:00'))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _parse_active(value) -> bool | None:
    if isinstance(value, bool):
        return value
    if value is None:
        return None
    txt = str(value).strip().lower()
    if txt in {'1', 'true', 'yes', 'on', 'enable', 'enabled', 'active'}:
        return True
    if txt in {'0', 'false', 'no', 'off', 'disable', 'disabled', 'inactive'}:
        return False
    return None


@bot_bp.route('/api/bot/keys', methods=['GET'])
def bot_keys():
    ip = _client_ip()
    if not _check_rate('keys', 120):
        audit_event('bot.keys.rate_limited', ip=ip)
        return jsonify(_RATE_ERR), 429
    if not _authorized():
        audit_event('bot.keys.unauthorized', ip=ip)
        return jsonify(_AUTH_ERR), 401

    # Pagination: ?page=1&limit=100&search=TERM&discord_id=ID
    page = max(1, int(request.args.get('page', 1) or 1))
    limit = min(500, max(1, int(request.args.get('limit', 100) or 100)))
    search = str(request.args.get('search', '')).strip()
    discord_filter = str(request.args.get('discord_id', '')).strip()

    query = License.query.order_by(License.id.desc())

    if search:
        search_upper = search.upper().replace('-', '')
        query = query.filter(
            db.or_(
                License.key.ilike(f'%{search_upper}%'),
                License._metadata.ilike(f'%{search}%'),
            )
        )
    if discord_filter and discord_filter.isdigit():
        query = query.filter(License._metadata.ilike(f'%"discord_id": "{discord_filter}"%'))

    total = query.count()
    rows = query.offset((page - 1) * limit).limit(limit).all()
    payload = [_license_payload(item) for item in rows]
    audit_event('bot.keys.ok', ip=ip, count=len(payload), page=page)
    return jsonify({
        'keys': payload,
        'page': page,
        'limit': limit,
        'total': total,
        'pages': max(1, (total + limit - 1) // limit),
        # Legacy compatibility: bot can still iterate the list directly if it expects an array
    }), 200


@bot_bp.route('/api/bot/key-create', methods=['POST'])
def bot_key_create():
    ip = _client_ip()
    if not _check_rate('key_create', 120):
        audit_event('bot.key_create.rate_limited', ip=ip)
        return jsonify(_RATE_ERR), 429
    if not _authorized():
        audit_event('bot.key_create.unauthorized', ip=ip)
        return jsonify(_AUTH_ERR), 401

    data, err = _require_json()
    if err:
        return err

    access = str(data.get('access') or data.get('tier') or 'monthly').strip().lower()
    if access not in {'monthly', 'lifetime'}:
        return jsonify({'ok': False, 'error': 'access must be monthly or lifetime'}), 400

    expires_at = None
    if access == 'monthly':
        expires_at = _parse_iso_datetime(data.get('expiresAt') or data.get('expires_at'))
        if expires_at is None:
            days = _parse_days(data.get('days'), 30) or 30
            expires_at = datetime.now(timezone.utc) + timedelta(days=days)

    normalized = _generate_key()
    while License.query.filter_by(key_hash=sha256_hex(normalized)).first() is not None:
        normalized = _generate_key()

    meta = {}
    _meta_set_text(meta, 'notes', data.get('note') or data.get('notes') or '')
    _meta_set_text(meta, 'email', data.get('email') or '')
    discord_id_val = str(data.get('discordId') or data.get('discord_id') or '').strip()
    _meta_set_text(meta, 'discord_id', discord_id_val)

    # For monthly replacements: inherit stripe_customer and use Stripe subscription
    # period_end as the expiry so the new key stays linked to the user's billing.
    if access == 'monthly' and discord_id_val:
        _stripe_cid, _sub_end = _lookup_stripe_for_discord(discord_id_val)
        if _stripe_cid:
            meta['stripe_customer'] = _stripe_cid
            if _sub_end is not None:
                expires_at = _sub_end  # override default 30-day expiry with real period end

    item = License(
        key=normalized,
        key_hash=sha256_hex(normalized),
        user_enc_key=secrets.token_hex(32),
        user_salt=secrets.token_hex(16),
        tier=access,
        expires_at=expires_at,
        is_revoked=False,
    )
    item.extra_metadata = meta
    db.session.add(item)
    db.session.commit()

    audit_event('bot.key_create.ok', ip=ip, license_id=item.id, tier=item.tier)
    return jsonify({'ok': True, 'key': _format_key(item.key), 'license': _license_payload(item)}), 200


@bot_bp.route('/api/bot/key-update', methods=['POST'])
def bot_key_update():
    ip = _client_ip()
    if not _check_rate('key_update', 120):
        audit_event('bot.key_update.rate_limited', ip=ip)
        return jsonify(_RATE_ERR), 429
    if not _authorized():
        audit_event('bot.key_update.unauthorized', ip=ip)
        return jsonify(_AUTH_ERR), 401

    data, err = _require_json()
    if err:
        return err

    key_raw = data.get('key')
    item = _find_by_key(str(key_raw or ''))
    if item is None:
        return jsonify({'ok': False, 'error': 'Key not found'}), 404

    if 'access' in data or 'tier' in data:
        access = str(data.get('access') or data.get('tier') or '').strip().lower()
        if access not in {'monthly', 'lifetime'}:
            return jsonify({'ok': False, 'error': 'access must be monthly or lifetime'}), 400
        item.tier = access
        if access == 'lifetime':
            item.expires_at = None

    if bool(data.get('clearExpiry', False)):
        item.expires_at = None
    if 'days' in data and data.get('days') is not None:
        days = _parse_days(data.get('days'), None)
        if days is None:
            return jsonify({'ok': False, 'error': 'days must be a positive integer'}), 400
        item.expires_at = datetime.now(timezone.utc) + timedelta(days=days)
        if item.tier != 'lifetime':
            item.tier = 'monthly'

    if 'active' in data:
        active = _parse_active(data.get('active'))
        if active is None:
            return jsonify({'ok': False, 'error': 'active must be true or false'}), 400
        item.is_revoked = not active

    meta = item.extra_metadata or {}
    if 'note' in data or 'notes' in data:
        _meta_set_text(meta, 'notes', data.get('note') if 'note' in data else data.get('notes'))
    if 'email' in data:
        _meta_set_text(meta, 'email', data.get('email'))
    if 'discordId' in data or 'discord_id' in data:
        _meta_set_text(meta, 'discord_id', data.get('discordId') if 'discordId' in data else data.get('discord_id'))
    item.extra_metadata = meta

    item.session_nonce = secrets.token_hex(16)
    db.session.commit()
    audit_event('bot.key_update.ok', ip=ip, license_id=item.id)
    return jsonify({'ok': True, 'license': _license_payload(item)}), 200


@bot_bp.route('/api/bot/key-extend', methods=['POST'])
def bot_key_extend():
    ip = _client_ip()
    if not _check_rate('key_extend', 120):
        audit_event('bot.key_extend.rate_limited', ip=ip)
        return jsonify(_RATE_ERR), 429
    if not _authorized():
        audit_event('bot.key_extend.unauthorized', ip=ip)
        return jsonify(_AUTH_ERR), 401

    data, err = _require_json()
    if err:
        return err

    item = _find_by_key(str(data.get('key') or ''))
    if item is None:
        return jsonify({'ok': False, 'error': 'Key not found'}), 404

    days = _parse_days(data.get('days'), None)
    if days is None:
        return jsonify({'ok': False, 'error': 'days must be a positive integer'}), 400

    now = datetime.now(timezone.utc)
    base = item.expires_at
    if base is None:
        base = now
    elif base.tzinfo is None:
        base = base.replace(tzinfo=timezone.utc)
    if base < now:
        base = now
    item.expires_at = base + timedelta(days=days)
    if item.tier != 'lifetime':
        item.tier = 'monthly'
    item.session_nonce = secrets.token_hex(16)
    db.session.commit()

    audit_event('bot.key_extend.ok', ip=ip, license_id=item.id, days=days)
    return jsonify({'ok': True, 'expiresAt': _to_iso(item.expires_at), 'license': _license_payload(item)}), 200


@bot_bp.route('/api/bot/boost-extend', methods=['POST'])
def bot_boost_extend():
    """Extend a monthly/3-month license by 7 days when a user boosts the Discord server.
    Called once per boost event (max 2 extensions per user, 7 days each = 14 days total).
    Lifetime licenses are ignored. Returns the new expiry and current boost count.
    """
    ip = _client_ip()
    if not _check_rate('boost_extend', 60):
        audit_event('bot.boost_extend.rate_limited', ip=ip)
        return jsonify(_RATE_ERR), 429
    if not _authorized():
        audit_event('bot.boost_extend.unauthorized', ip=ip)
        return jsonify(_AUTH_ERR), 401

    data, err = _require_json()
    if err:
        return err

    discord_id = str(data.get('discord_id') or '').strip()
    if not discord_id:
        return jsonify({'ok': False, 'error': 'discord_id is required'}), 400

    MAX_BOOST_EXTENSIONS = 2
    DAYS_PER_BOOST = 7

    # Find the user's active monthly/3-month license
    licenses = License.query.filter(
        License._metadata.like(f'%"discord_id": "{discord_id}"%')
    ).all()

    item = None
    for lic in licenses:
        if lic.is_revoked:
            continue
        if lic.tier == 'lifetime':
            continue
        # Skip expired-by-more-than-30-days licenses
        if lic.expires_at is not None:
            exp = lic.expires_at
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
            if (datetime.now(timezone.utc) - exp).days > 30:
                continue
        item = lic
        break

    if item is None:
        # Check if they only have lifetime
        for lic in licenses:
            if not lic.is_revoked and lic.tier == 'lifetime':
                return jsonify({
                    'ok': False,
                    'reason': 'lifetime',
                    'error': 'Lifetime licenses do not need time extensions.',
                }), 200
        return jsonify({
            'ok': False,
            'reason': 'no_license',
            'error': 'No active monthly license found for this Discord account.',
        }), 404

    meta = dict(item.extra_metadata or {})
    current_count = int(meta.get('boost_extensions', 0))

    if current_count >= MAX_BOOST_EXTENSIONS:
        return jsonify({
            'ok': False,
            'reason': 'max_reached',
            'error': f'Maximum boost extensions ({MAX_BOOST_EXTENSIONS}) already applied for this account.',
            'boost_count': current_count,
            'expiresAt': _to_iso(item.expires_at),
        }), 200

    # Extend expiry by 7 days from current expiry (or now if expired/not set)
    now = datetime.now(timezone.utc)
    base = item.expires_at
    if base is None:
        base = now
    elif base.tzinfo is None:
        base = base.replace(tzinfo=timezone.utc)
    if base < now:
        base = now

    item.expires_at = base + timedelta(days=DAYS_PER_BOOST)
    meta['boost_extensions'] = current_count + 1
    item.extra_metadata = meta
    item.session_nonce = secrets.token_hex(16)
    db.session.commit()

    new_count = current_count + 1
    audit_event('bot.boost_extend.ok', ip=ip, license_id=item.id,
                discord_id=discord_id, boost_count=new_count, days=DAYS_PER_BOOST)
    return jsonify({
        'ok': True,
        'days_extended': DAYS_PER_BOOST,
        'boost_count': new_count,
        'expiresAt': _to_iso(item.expires_at),
        'license': _license_payload(item),
    }), 200


@bot_bp.route('/api/bot/key-reset-hwid', methods=['POST'])
def bot_key_reset_hwid():
    ip = _client_ip()
    if not _check_rate('key_reset_hwid', 120):
        audit_event('bot.key_reset_hwid.rate_limited', ip=ip)
        return jsonify(_RATE_ERR), 429
    if not _authorized():
        audit_event('bot.key_reset_hwid.unauthorized', ip=ip)
        return jsonify(_AUTH_ERR), 401

    data, err = _require_json()
    if err:
        return err

    item = _find_by_key(str(data.get('key') or ''))
    if item is None:
        return jsonify({'ok': False, 'error': 'Key not found'}), 404

    item.hwid_hash = None
    item.hwid_change_count = 0
    item.activated_at = None
    item.session_nonce = secrets.token_hex(16)
    db.session.commit()
    audit_event('bot.key_reset_hwid.ok', ip=ip, license_id=item.id)
    return jsonify({'ok': True, 'license': _license_payload(item)}), 200


@bot_bp.route('/api/bot/key-toggle', methods=['POST'])
def bot_key_toggle():
    ip = _client_ip()
    if not _check_rate('key_toggle', 120):
        audit_event('bot.key_toggle.rate_limited', ip=ip)
        return jsonify(_RATE_ERR), 429
    if not _authorized():
        audit_event('bot.key_toggle.unauthorized', ip=ip)
        return jsonify(_AUTH_ERR), 401

    data, err = _require_json()
    if err:
        return err

    item = _find_by_key(str(data.get('key') or ''))
    if item is None:
        return jsonify({'ok': False, 'error': 'Key not found'}), 404

    item.is_revoked = not bool(item.is_revoked)
    item.session_nonce = secrets.token_hex(16)
    db.session.commit()
    audit_event('bot.key_toggle.ok', ip=ip, license_id=item.id, active=(not item.is_revoked))
    return jsonify({'ok': True, 'active': (not item.is_revoked), 'license': _license_payload(item)}), 200


@bot_bp.route('/api/bot/key-delete', methods=['POST'])
def bot_key_delete():
    ip = _client_ip()
    if not _check_rate('key_delete', 120):
        audit_event('bot.key_delete.rate_limited', ip=ip)
        return jsonify(_RATE_ERR), 429
    if not _authorized():
        audit_event('bot.key_delete.unauthorized', ip=ip)
        return jsonify(_AUTH_ERR), 401

    data, err = _require_json()
    if err:
        return err

    item = _find_by_key(str(data.get('key') or ''))
    if item is None:
        return jsonify({'ok': False, 'error': 'Key not found'}), 404

    db.session.delete(item)
    db.session.commit()
    audit_event('bot.key_delete.ok', ip=ip)
    return jsonify({'ok': True}), 200


@bot_bp.route('/api/bot/discord/licenses', methods=['GET'])
def bot_discord_licenses():
    """List all licenses linked to a Discord user."""
    ip = _client_ip()
    if not _check_rate('discord_licenses', 120):
        return jsonify(_RATE_ERR), 429
    if not _authorized():
        return jsonify(_AUTH_ERR), 401
    discord_id = str(request.args.get('discord_id', '')).strip()
    if not discord_id.isdigit():
        return jsonify({'ok': False, 'error': 'Invalid discord_id'}), 400
    rows = License.query.all()
    mine = [r for r in rows if str((r.extra_metadata or {}).get('discord_id', '')).strip() == discord_id]
    mine.sort(key=lambda r: (r.created_at or datetime(1970, 1, 1)), reverse=True)
    return jsonify({'ok': True, 'licenses': [_license_payload(r) for r in mine], 'count': len(mine)}), 200


@bot_bp.route('/api/bot/discord/grant', methods=['POST'])
def bot_discord_grant():
    """Create a new license linked to a Discord user."""
    ip = _client_ip()
    if not _check_rate('discord_grant', 60):
        return jsonify(_RATE_ERR), 429
    if not _authorized():
        return jsonify(_AUTH_ERR), 401
    data, err = _require_json()
    if err:
        return err
    discord_id = str(data.get('discord_id', '')).strip()
    plan = str(data.get('plan', 'monthly')).strip().lower()
    if not discord_id.isdigit():
        return jsonify({'ok': False, 'error': 'Invalid discord_id'}), 400
    if plan not in {'monthly', 'lifetime'}:
        return jsonify({'ok': False, 'error': 'plan must be monthly or lifetime'}), 400
    expires_at = None
    if plan == 'monthly':
        expires_at = _parse_iso_datetime(data.get('expiresAt') or data.get('expires_at'))
        if expires_at is None:
            days = _parse_days(data.get('days'), 30) or 30
            expires_at = datetime.now(timezone.utc) + timedelta(days=days)
    normalized = _generate_key()
    while License.query.filter_by(key_hash=sha256_hex(normalized)).first() is not None:
        normalized = _generate_key()
    meta = {'discord_id': discord_id}
    _meta_set_text(meta, 'notes', data.get('note') or data.get('notes') or '')
    _meta_set_text(meta, 'email', data.get('email') or '')
    item = License(
        key=normalized, key_hash=sha256_hex(normalized),
        user_enc_key=secrets.token_hex(32), user_salt=secrets.token_hex(16),
        tier=plan, expires_at=expires_at, is_revoked=False,
    )
    item.extra_metadata = meta
    db.session.add(item)
    db.session.commit()
    audit_event('bot.discord.grant.ok', ip=ip, license_id=item.id, discord_id=discord_id, tier=plan)
    return jsonify({'ok': True, 'key': _format_key(item.key), 'license': _license_payload(item)}), 200


@bot_bp.route('/api/bot/discord/revoke', methods=['POST'])
def bot_discord_revoke():
    """Revoke license(s) for a Discord user (all or a specific key)."""
    ip = _client_ip()
    if not _check_rate('discord_revoke', 60):
        return jsonify(_RATE_ERR), 429
    if not _authorized():
        return jsonify(_AUTH_ERR), 401
    data, err = _require_json()
    if err:
        return err
    discord_id = str(data.get('discord_id', '')).strip()
    target_key = str(data.get('key', '')).strip()
    if not discord_id.isdigit():
        return jsonify({'ok': False, 'error': 'Invalid discord_id'}), 400
    rows = License.query.all()
    changed = 0
    for row in rows:
        if str((row.extra_metadata or {}).get('discord_id', '')).strip() != discord_id:
            continue
        if target_key:
            normalized = _normalize_license(target_key)
            if normalized and row.key_hash != sha256_hex(normalized):
                continue
        row.is_revoked = True
        row.session_nonce = secrets.token_hex(16)
        changed += 1
    if changed:
        db.session.commit()
        revoke_customer_role(discord_id, current_app.config)
    audit_event('bot.discord.revoke.ok', ip=ip, discord_id=discord_id, count=changed)
    return jsonify({'ok': True, 'revoked': changed}), 200


@bot_bp.route('/api/bot/discord/upgrade', methods=['POST'])
def bot_discord_upgrade():
    """Upgrade a Discord user's monthly license to lifetime."""
    ip = _client_ip()
    if not _check_rate('discord_upgrade', 60):
        return jsonify(_RATE_ERR), 429
    if not _authorized():
        return jsonify(_AUTH_ERR), 401
    data, err = _require_json()
    if err:
        return err
    discord_id = str(data.get('discord_id', '')).strip()
    target_key = str(data.get('key', '')).strip()
    if not discord_id.isdigit():
        return jsonify({'ok': False, 'error': 'Invalid discord_id'}), 400
    rows = License.query.all()
    upgraded = []
    for row in rows:
        if str((row.extra_metadata or {}).get('discord_id', '')).strip() != discord_id:
            continue
        if target_key:
            normalized = _normalize_license(target_key)
            if normalized and row.key_hash != sha256_hex(normalized):
                continue
        if row.is_revoked:
            continue
        row.tier = 'lifetime'
        row.expires_at = None
        row.session_nonce = secrets.token_hex(16)
        upgraded.append(_license_payload(row))
    if upgraded:
        db.session.commit()
    audit_event('bot.discord.upgrade.ok', ip=ip, discord_id=discord_id, count=len(upgraded))
    return jsonify({'ok': True, 'upgraded': len(upgraded), 'licenses': upgraded}), 200


@bot_bp.route('/api/bot/discord/reset-hwid', methods=['POST'])
def bot_discord_reset_hwid():
    """Reset HWID for a Discord user's license(s)."""
    ip = _client_ip()
    if not _check_rate('discord_reset_hwid', 60):
        return jsonify(_RATE_ERR), 429
    if not _authorized():
        return jsonify(_AUTH_ERR), 401
    data, err = _require_json()
    if err:
        return err
    discord_id = str(data.get('discord_id', '')).strip()
    target_key = str(data.get('key', '')).strip()
    if not discord_id.isdigit():
        return jsonify({'ok': False, 'error': 'Invalid discord_id'}), 400
    rows = License.query.all()
    changed = 0
    for row in rows:
        if str((row.extra_metadata or {}).get('discord_id', '')).strip() != discord_id:
            continue
        if target_key:
            normalized = _normalize_license(target_key)
            if normalized and row.key_hash != sha256_hex(normalized):
                continue
        row.hwid_hash = None
        row.hwid_change_count = 0
        row.activated_at = None
        row.session_nonce = secrets.token_hex(16)
        changed += 1
    if changed:
        db.session.commit()
    audit_event('bot.discord.reset_hwid.ok', ip=ip, discord_id=discord_id, count=changed)
    return jsonify({'ok': True, 'reset': changed}), 200


@bot_bp.route('/api/bot/discord/claim', methods=['POST'])
def bot_discord_claim():
    """Link an unlinked legacy key to a Discord user."""
    ip = _client_ip()
    if not _check_rate('discord_claim', 60):
        return jsonify(_RATE_ERR), 429
    if not _authorized():
        return jsonify(_AUTH_ERR), 401
    data, err = _require_json()
    if err:
        return err
    discord_id = str(data.get('discord_id', '')).strip()
    raw_key    = str(data.get('key', '')).strip()
    if not discord_id.isdigit():
        return jsonify({'ok': False, 'error': 'bad_discord_id'}), 400
    normalized = _normalize_license(raw_key)
    if not normalized:
        return jsonify({'ok': False, 'error': 'not_found'}), 404
    # Check user doesn't already have an active license
    all_rows = License.query.all()
    existing = next((r for r in all_rows if str((r.extra_metadata or {}).get('discord_id', '')).strip() == discord_id and not r.is_revoked), None)
    if existing:
        return jsonify({'ok': False, 'error': 'already_linked', 'existing_key': _format_key(existing.key), 'existing_plan': existing.tier}), 400
    # Find the unlinked license
    item = License.query.filter_by(key_hash=sha256_hex(normalized)).first()
    if item is None:
        return jsonify({'ok': False, 'error': 'not_found'}), 404
    meta = item.extra_metadata or {}
    if meta.get('discord_id') and str(meta['discord_id']).strip() != discord_id:
        return jsonify({'ok': False, 'error': 'not_found'}), 404
    meta['discord_id'] = discord_id
    item.extra_metadata = meta
    db.session.commit()
    audit_event('bot.discord.claim.ok', ip=ip, license_id=item.id, discord_id=discord_id)
    return jsonify({'ok': True, 'key': _format_key(item.key), 'plan': item.tier, 'status': 'active' if not item.is_revoked else 'revoked'}), 200


@bot_bp.route('/api/bot/discord/set-affiliate', methods=['POST'])
def bot_discord_set_affiliate():
    """Set the affiliate_code on a Discord user's active license."""
    ip = _client_ip()
    if not _check_rate('discord_set_affiliate', 60):
        return jsonify(_RATE_ERR), 429
    if not _authorized():
        return jsonify(_AUTH_ERR), 401
    data, err = _require_json()
    if err:
        return err
    discord_id = str(data.get('discord_id', '')).strip()
    new_code   = str(data.get('affiliate_code', '')).strip().lower()
    if not discord_id.isdigit():
        return jsonify({'ok': False, 'error': 'Invalid discord_id'}), 400
    import re as _re
    if new_code and not _re.fullmatch(r'[a-z0-9]{4,32}', new_code):
        return jsonify({'ok': False, 'error': 'Code must be 4-32 lowercase alphanumeric characters'}), 400
    rows = License.query.all()
    updated = []
    for row in rows:
        if str((row.extra_metadata or {}).get('discord_id', '')).strip() != discord_id:
            continue
        if row.is_revoked:
            continue
        meta = row.extra_metadata or {}
        if new_code:
            meta['affiliate_code'] = new_code
            row.affiliate_code = new_code
        else:
            meta.pop('affiliate_code', None)
            row.affiliate_code = None
        row.extra_metadata = meta
        updated.append(_license_payload(row))
    if updated:
        db.session.commit()
    audit_event('bot.discord.set_affiliate.ok', ip=ip, discord_id=discord_id, code=new_code)
    return jsonify({'ok': True, 'updated': len(updated), 'licenses': updated}), 200


@bot_bp.route('/api/claim-discord-role', methods=['POST'])
def claim_discord_role():
    ip = _client_ip()
    if not _check_rate('claim_discord_role', 90):
        return jsonify(_RATE_ERR), 429

    data, err = _require_json()
    if err:
        return err

    key = _normalize_license(data.get('key'))
    discord_id = str(data.get('discordId') or '').strip()
    if key is None or not discord_id.isdigit():
        return jsonify({'ok': False, 'reason': 'Invalid key or Discord ID'}), 400

    item = License.query.filter_by(key_hash=sha256_hex(key)).first()
    if item is None or not item.is_active():
        return jsonify({'ok': False, 'reason': 'Invalid or inactive key'}), 400

    meta = item.extra_metadata or {}
    linked = str(meta.get('discord_id') or '').strip()
    if linked and linked != discord_id:
        return jsonify({'ok': False, 'reason': 'Key is already linked to another Discord account'}), 400

    meta['discord_id'] = discord_id
    item.extra_metadata = meta
    db.session.commit()
    audit_event('bot.claim_discord_role.ok', ip=ip, license_id=item.id)
    return jsonify({'ok': True, 'tier': item.tier or 'monthly'}), 200


@bot_bp.route('/api/bot/entitlement/grant', methods=['POST'])
def bot_entitlement_grant():
    """
    Grant a standalone macro entitlement to a Discord user.
    If the user has no license, a standalone-only one is created.
    Body: {discord_id, product_id, note?}
    """
    ip = _client_ip()
    if not _check_rate('entitlement_grant', 60):
        return jsonify(_RATE_ERR), 429
    if not _authorized():
        return jsonify(_AUTH_ERR), 401
    data, err = _require_json()
    if err:
        return err

    discord_id = str(data.get('discord_id', '')).strip()
    product_id  = str(data.get('product_id', '')).strip()
    if not discord_id.isdigit() or not product_id:
        return jsonify({'ok': False, 'error': 'discord_id and product_id required'}), 400

    product = Product.query.get(product_id)
    if not product or not product.is_active:
        return jsonify({'ok': False, 'error': f'Unknown product: {product_id}'}), 404

    # Find existing license for this discord_id
    lic = License.query.filter(
        License._metadata.like(f'%"discord_id": "{discord_id}"%')
    ).filter_by(is_revoked=False).order_by(License.id.desc()).first()

    created_key = None
    if not lic:
        # Create a standalone-only license
        normalized = _generate_key()
        while License.query.filter_by(key_hash=sha256_hex(normalized)).first() is not None:
            normalized = _generate_key()
        meta = {'discord_id': discord_id, 'plan': 'standalone'}
        note = str(data.get('note') or '').strip()
        if note:
            meta['notes'] = note
        lic = License(
            key=normalized, key_hash=sha256_hex(normalized),
            user_enc_key=secrets.token_hex(32), user_salt=secrets.token_hex(16),
            tier='standalone', is_revoked=False, expires_at=None,
        )
        lic.extra_metadata = meta
        db.session.add(lic)
        db.session.flush()
        created_key = _format_key(lic.key)
        audit_event('bot.entitlement.created_license', ip=ip, discord_id=discord_id, license_id=lic.id)

    # Grant entitlement (idempotent)
    existing = UserEntitlement.query.filter_by(
        license_key_hash=lic.key_hash, product_id=product_id
    ).first()
    if not existing:
        db.session.add(UserEntitlement(
            license_key_hash=lic.key_hash,
            product_id=product_id,
            stripe_ref=f'bot:grant:{discord_id}:{product_id}:{int(time.time())}',
            charged_cents=0,
        ))

    # If it's a bundle, also grant included items
    bundle_pids = [x.strip() for x in (product.bundle_items or '').split(',') if x.strip()]
    for bpid in bundle_pids:
        if not UserEntitlement.query.filter_by(
            license_key_hash=lic.key_hash, product_id=bpid
        ).first():
            db.session.add(UserEntitlement(
                license_key_hash=lic.key_hash,
                product_id=bpid,
                stripe_ref=f'bot:grant:{discord_id}:{bpid}:{int(time.time())}',
                charged_cents=0,
            ))

    db.session.commit()
    audit_event('bot.entitlement.grant.ok', ip=ip, discord_id=discord_id, product_id=product_id)

    result = {
        'ok': True,
        'product_id': product_id,
        'product_name': product.name,
        'discord_id': discord_id,
        'license_key': created_key or _format_key(lic.key),
        'new_license': created_key is not None,
    }
    if bundle_pids:
        result['bundle_items_granted'] = bundle_pids
    return jsonify(result), 200

