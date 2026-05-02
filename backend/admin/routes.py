import re
import secrets
import time
import hmac
import hashlib
from threading import Lock
from datetime import datetime, timedelta, timezone

from flask import Blueprint, current_app, jsonify, request

from database import db
from models import License
from utils.audit import audit_event
from utils.crypto import sha256_hex
from utils.rate_limiter import get_limiter
from utils.discord_roles import grant_customer_role, revoke_customer_role

admin_bp = Blueprint('admin', __name__)
_RATE_ERR = {'ok': False, 'error': 'Too many requests'}
_NONCE_RE = re.compile(r'^[A-Za-z0-9._:-]{8,128}$')
_SIG_REPLAY_CACHE: dict[str, float] = {}
_SIG_REPLAY_LOCK = Lock()
_SIG_CLEANUP_EVERY = 200
_sig_counter = 0


def _normalize_license(raw: str) -> str:
    cleaned = re.sub(r'[^A-Za-z0-9]', '', str(raw or '')).upper()
    if len(cleaned) != 20:
        raise ValueError('invalid license length')
    return cleaned


def _format_key(normalized: str) -> str:
    return '-'.join(normalized[i:i + 4] for i in range(0, len(normalized), 4))


def _generate_key() -> str:
    alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    return ''.join(secrets.choice(alphabet) for _ in range(20))


def _auth_failed():
    return jsonify({'ok': False, 'error': 'Unauthorized'}), 401


def _client_ip() -> str:
    forwarded = request.headers.get('X-Forwarded-For', '')
    if forwarded:
        return forwarded.split(',')[0].strip()
    return request.remote_addr or '0.0.0.0'


def _parse_int(value, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, parsed))


def _check_rate(action: str, limit: int) -> bool:
    limiter = get_limiter()
    ip = _client_ip()
    return limiter.check_and_record(f'admin:{action}:{ip}', limit, 60)


def _ensure_json_body():
    max_body: int = int(current_app.config.get('MAX_JSON_BODY_BYTES', 16_384))
    content_len = request.content_length
    if content_len is not None and content_len > max_body:
        return None, (jsonify({'ok': False, 'error': 'Invalid request'}), 413)
    if not request.is_json:
        return None, (jsonify({'ok': False, 'error': 'Invalid request'}), 400)
    data = request.get_json(silent=True) or {}
    return data, None


def _require_token(expected: str):
    auth_header = request.headers.get('Authorization', '')
    token = auth_header.replace('Bearer ', '').strip()
    if not token:
        token = request.headers.get('X-API-Token', '').strip()
    if not token or not expected or not secrets.compare_digest(token, expected):
        return False
    if not _verify_optional_signature(expected):
        return False
    return True


def _replay_key(path: str, method: str, ts: str, nonce: str, signature: str) -> str:
    # [SECURITY HARDENING] Keep replay keys compact and avoid storing raw path.
    material = f'{path}|{method}|{ts}|{nonce}|{signature}'
    return hashlib.sha256(material.encode()).hexdigest()[:32]


def _remember_nonce_once(path: str, method: str, ts: str, nonce: str, signature: str, window_s: int) -> bool:
    """Return False if signature+nonce replay is detected, otherwise remember it."""
    global _sig_counter
    now = time.time()
    key = _replay_key(path, method, ts, nonce, signature)

    with _SIG_REPLAY_LOCK:
        _sig_counter += 1
        if _sig_counter % _SIG_CLEANUP_EVERY == 0:
            cutoff = now - max(60, window_s)
            dead = [k for k, seen_at in _SIG_REPLAY_CACHE.items() if seen_at < cutoff]
            for dead_key in dead:
                _SIG_REPLAY_CACHE.pop(dead_key, None)

        if key in _SIG_REPLAY_CACHE:
            return False
        _SIG_REPLAY_CACHE[key] = now
        return True


def _verify_optional_signature(shared_token: str) -> bool:
    # [SECURITY HARDENING] Backward-compatible signed-request verification.
    signature = request.headers.get('X-Zenith-Signature', '').strip().lower()
    timestamp = request.headers.get('X-Zenith-Timestamp', '').strip()
    nonce = request.headers.get('X-Zenith-Nonce', '').strip()

    if not signature and not timestamp:
        return True
    if not signature or not timestamp:
        return False
    if len(signature) != 64 or not all(ch in '0123456789abcdef' for ch in signature):
        return False
    if not timestamp.isdigit():
        return False
    if nonce and _NONCE_RE.fullmatch(nonce) is None:
        return False

    now = int(time.time())
    ts = int(timestamp)
    max_skew = int(current_app.config.get('REQUEST_SIG_SKEW_SECONDS', 300))
    if abs(now - ts) > max_skew:
        return False

    body = request.get_data(cache=True) or b''
    body_hash = hashlib.sha256(body).hexdigest()
    message = f'{timestamp}.{request.method.upper()}.{request.path}.{body_hash}'
    expected = hmac.new(shared_token.encode(), message.encode(), hashlib.sha256).hexdigest()
    if not secrets.compare_digest(expected, signature):
        return False

    # [SECURITY HARDENING] Optional nonce replay guard for signed requests.
    if nonce:
        if not _remember_nonce_once(request.path, request.method.upper(), timestamp, nonce, signature, max_skew):
            return False

    return True


def _license_to_dict(item: License) -> dict:
    exp = item.expires_at
    if exp and exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    return {
        'id': item.id,
        'key': _format_key(item.key),
        'tier': item.tier,
        'revoked': bool(item.is_revoked),
        'expires_at': exp.isoformat() if exp else None,
        'hwid_bound': bool(item.hwid_hash),
        'hwid_change_count': int(item.hwid_change_count or 0),
        'notes': (item.extra_metadata or {}).get('notes', ''),
        'created_at': item.created_at.isoformat() if item.created_at else None,
        'last_validated': item.last_validated.isoformat() if item.last_validated else None,
    }


def _find_license_by_purchase_id(purchase_id: str) -> License | None:
    # [SECURITY HARDENING] Verify purchase id by parsed metadata to avoid
    # false positives from broad SQL text matching.
    query = (
        License.query
        .filter(License._metadata.isnot(None))
        .order_by(License.id.desc())
        .yield_per(200)
    )
    for item in query:
        if (item.extra_metadata or {}).get('purchase_id') == purchase_id:
            return item
    return None


@admin_bp.route('/v1/admin/licenses', methods=['GET'])
def admin_list_licenses():
    if not _require_token(current_app.config.get('BOT_API_TOKEN', '')):
        audit_event('admin.list.unauthorized', ip=_client_ip())
        return _auth_failed()
    if not _check_rate('list', int(current_app.config.get('ADMIN_RPM', 120))):
        audit_event('admin.list.rate_limited', ip=_client_ip())
        return jsonify(_RATE_ERR), 429

    q = License.query.order_by(License.id.desc())
    tier = request.args.get('tier', '').strip().lower()
    if tier in {'monthly', 'lifetime'}:
        q = q.filter_by(tier=tier)
    if request.args.get('revoked', '').strip().lower() in {'1', 'true', 'yes'}:
        q = q.filter_by(is_revoked=True)

    limit = _parse_int(request.args.get('limit', 50), 50, 1, 200)
    rows = q.limit(limit).all()
    audit_event('admin.list.ok', ip=_client_ip(), count=len(rows))
    return jsonify({'ok': True, 'items': [_license_to_dict(x) for x in rows]}), 200


@admin_bp.route('/v1/admin/licenses', methods=['POST'])
def admin_create_license():
    if not _require_token(current_app.config.get('BOT_API_TOKEN', '')):
        audit_event('admin.create.unauthorized', ip=_client_ip())
        return _auth_failed()
    if not _check_rate('create', int(current_app.config.get('ADMIN_RPM', 120))):
        audit_event('admin.create.rate_limited', ip=_client_ip())
        return jsonify(_RATE_ERR), 429

    data, err = _ensure_json_body()
    if err:
        audit_event('admin.create.bad_request', ip=_client_ip())
        return err

    tier = str(data.get('tier', 'monthly')).strip().lower()
    if tier not in {'monthly', 'lifetime'}:
        audit_event('admin.create.bad_request', ip=_client_ip(), reason='bad_tier')
        return jsonify({'ok': False, 'error': 'tier must be monthly or lifetime'}), 400

    expires_at = None
    if tier == 'monthly':
        days = _parse_int(data.get('days', 30), 30, 1, 3650)
        expires_at = datetime.now(timezone.utc) + timedelta(days=days)

    notes = str(data.get('notes', '')).strip()[:400]
    requested = str(data.get('key', '')).strip()
    normalized = _normalize_license(requested) if requested else _generate_key()

    existing = License.query.filter_by(key_hash=sha256_hex(normalized)).first()
    if existing:
        audit_event('admin.create.conflict', ip=_client_ip())
        return jsonify({'ok': False, 'error': 'Key already exists'}), 409

    item = License(
        key=normalized,
        key_hash=sha256_hex(normalized),
        user_enc_key=secrets.token_hex(32),
        user_salt=secrets.token_hex(16),
        tier=tier,
        expires_at=expires_at,
        is_revoked=False,
    )
    item.extra_metadata = {'notes': notes} if notes else {}
    db.session.add(item)
    db.session.commit()
    audit_event('admin.create.ok', ip=_client_ip(), license_id=item.id, tier=item.tier)
    return jsonify({'ok': True, 'item': _license_to_dict(item)}), 201


@admin_bp.route('/v1/admin/licenses/by-key/<string:license_key>', methods=['GET'])
def admin_get_license_by_key(license_key: str):
    if not _require_token(current_app.config.get('BOT_API_TOKEN', '')):
        audit_event('admin.get_by_key.unauthorized', ip=_client_ip())
        return _auth_failed()
    if not _check_rate('get_by_key', int(current_app.config.get('ADMIN_RPM', 120))):
        audit_event('admin.get_by_key.rate_limited', ip=_client_ip())
        return jsonify(_RATE_ERR), 429
    try:
        normalized = _normalize_license(license_key)
    except ValueError:
        audit_event('admin.get_by_key.bad_request', ip=_client_ip())
        return jsonify({'ok': False, 'error': 'Invalid key format'}), 400

    item = License.query.filter_by(key_hash=sha256_hex(normalized)).first()
    if not item:
        audit_event('admin.get_by_key.not_found', ip=_client_ip())
        return jsonify({'ok': False, 'error': 'Not found'}), 404
    audit_event('admin.get_by_key.ok', ip=_client_ip(), license_id=item.id)
    return jsonify({'ok': True, 'item': _license_to_dict(item)}), 200


@admin_bp.route('/v1/admin/licenses/<int:license_id>', methods=['PATCH'])
def admin_update_license(license_id: int):
    if not _require_token(current_app.config.get('BOT_API_TOKEN', '')):
        audit_event('admin.update.unauthorized', ip=_client_ip(), license_id=license_id)
        return _auth_failed()
    if not _check_rate('update', int(current_app.config.get('ADMIN_RPM', 120))):
        audit_event('admin.update.rate_limited', ip=_client_ip(), license_id=license_id)
        return jsonify(_RATE_ERR), 429

    data, err = _ensure_json_body()
    if err:
        audit_event('admin.update.bad_request', ip=_client_ip(), license_id=license_id)
        return err

    item = db.session.get(License, license_id)
    if not item:
        audit_event('admin.update.not_found', ip=_client_ip(), license_id=license_id)
        return jsonify({'ok': False, 'error': 'Not found'}), 404

    if 'revoked' in data:
        item.is_revoked = bool(data.get('revoked'))

    if 'tier' in data:
        tier = str(data.get('tier', '')).strip().lower()
        if tier not in {'monthly', 'lifetime'}:
            audit_event('admin.update.bad_request', ip=_client_ip(), license_id=license_id, reason='bad_tier')
            return jsonify({'ok': False, 'error': 'tier must be monthly or lifetime'}), 400
        item.tier = tier
        if tier == 'lifetime':
            item.expires_at = None

    if 'extend_days' in data:
        extend_days = _parse_int(data.get('extend_days', 0), 0, -3650, 3650)
        if extend_days != 0:
            base = item.expires_at or datetime.now(timezone.utc)
            if base.tzinfo is None:
                base = base.replace(tzinfo=timezone.utc)
            item.expires_at = base + timedelta(days=extend_days)

    if bool(data.get('reset_hwid', False)):
        item.hwid_hash = None
        item.hwid_change_count = 0

    if 'notes' in data:
        meta = item.extra_metadata or {}
        notes = str(data.get('notes', '')).strip()[:400]
        if notes:
            meta['notes'] = notes
        else:
            meta.pop('notes', None)
        item.extra_metadata = meta

    item.session_nonce = secrets.token_hex(16)
    db.session.commit()
    audit_event('admin.update.ok', ip=_client_ip(), license_id=item.id)
    return jsonify({'ok': True, 'item': _license_to_dict(item)}), 200


@admin_bp.route('/v1/store/fulfill', methods=['POST'])
def store_fulfill():
    if not _require_token(current_app.config.get('STORE_API_TOKEN', '')):
        audit_event('store.fulfill.unauthorized', ip=_client_ip())
        return _auth_failed()
    if not _check_rate('store_fulfill', int(current_app.config.get('STORE_FULFILL_RPM', 60))):
        audit_event('store.fulfill.rate_limited', ip=_client_ip())
        return jsonify(_RATE_ERR), 429

    data, err = _ensure_json_body()
    if err:
        audit_event('store.fulfill.bad_request', ip=_client_ip())
        return err

    tier = str(data.get('tier', 'monthly')).strip().lower()
    if tier not in {'monthly', 'lifetime'}:
        audit_event('store.fulfill.bad_request', ip=_client_ip(), reason='bad_tier')
        return jsonify({'ok': False, 'error': 'tier must be monthly or lifetime'}), 400

    email = str(data.get('email', '')).strip().lower()[:180]
    notes = str(data.get('notes', '')).strip()[:300]
    purchase_id = str(data.get('purchase_id', '')).strip()[:120]

    # Idempotency by purchase_id if provided.
    if purchase_id:
        existing = _find_license_by_purchase_id(purchase_id)
        if existing:
            audit_event('store.fulfill.idempotent', ip=_client_ip(), license_id=existing.id)
            return jsonify({'ok': True, 'item': _license_to_dict(existing), 'idempotent': True}), 200

    normalized = _generate_key()
    expires_at = None
    if tier == 'monthly':
        days = _parse_int(data.get('days', 30), 30, 1, 3650)
        expires_at = datetime.now(timezone.utc) + timedelta(days=days)

    meta = {}
    if email:
        meta['email'] = email
    if notes:
        meta['notes'] = notes
    if purchase_id:
        meta['purchase_id'] = purchase_id

    item = License(
        key=normalized,
        key_hash=sha256_hex(normalized),
        user_enc_key=secrets.token_hex(32),
        user_salt=secrets.token_hex(16),
        tier=tier,
        expires_at=expires_at,
        is_revoked=False,
    )
    item.extra_metadata = meta
    db.session.add(item)
    db.session.commit()
    audit_event('store.fulfill.ok', ip=_client_ip(), license_id=item.id, tier=item.tier)

    return jsonify({'ok': True, 'item': _license_to_dict(item)}), 201


@admin_bp.route('/v1/admin/anomaly/clear', methods=['POST'])
def admin_clear_anomaly():
    """Clear the anomaly block for a specific IP so a legitimate user can retry immediately."""
    if not _require_token(current_app.config.get('BOT_API_TOKEN', '')):
        audit_event('admin.anomaly_clear.unauthorized', ip=_client_ip())
        return _auth_failed()
    if not _check_rate('anomaly_clear', int(current_app.config.get('ADMIN_RPM', 120))):
        return jsonify(_RATE_ERR), 429

    data, err = _ensure_json_body()
    if err:
        return err

    target_ip = str(data.get('ip', '')).strip()
    if not target_ip:
        return jsonify({'ok': False, 'error': 'ip is required'}), 400

    from utils.anomaly import get_tracker
    get_tracker().clear_ip(target_ip)
    audit_event('admin.anomaly_clear.ok', ip=_client_ip(), target_ip=target_ip)
    return jsonify({'ok': True, 'cleared_ip': target_ip}), 200


@admin_bp.route('/v1/admin/sync-discord-roles', methods=['POST'])
def sync_discord_roles():
    """
    Audit every license that has a discord_id in metadata.
    - Active (non-revoked, non-expired) → grant customer role.
    - Revoked or expired → remove customer role.
    Returns counts of granted/revoked.
    """
    if not _require_token(current_app.config.get('BOT_API_TOKEN', '')):
        return jsonify({'ok': False, 'error': 'Unauthorized'}), 401

    from datetime import datetime, timezone as tz
    now = datetime.now(tz.utc)

    def _is_active(lic: License) -> bool:
        if lic.is_revoked:
            return False
        exp = lic.expires_at
        if exp:
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=tz.utc)
            if exp < now:
                return False
        return True

    # Build per-discord-id: True if they have at least one active key
    discord_state: dict[str, bool] = {}
    for lic in License.query.all():
        did = str((lic.extra_metadata or {}).get('discord_id', '')).strip()
        if not did:
            continue
        active = _is_active(lic)
        if did not in discord_state or active:
            discord_state[did] = active

    granted = revoked_count = 0
    cfg = current_app.config
    for did, has_active in discord_state.items():
        if has_active:
            grant_customer_role(did, cfg)
            granted += 1
        else:
            revoke_customer_role(did, cfg)
            revoked_count += 1

    audit_event('admin.sync_discord_roles.ok', ip=_client_ip(), granted=granted, revoked=revoked_count)
    return jsonify({'ok': True, 'granted': granted, 'revoked': revoked_count}), 200
