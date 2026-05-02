"""
Auth blueprint: /v1/auth/challenge, /v1/auth/verify, /v1/session/refresh
"""

import secrets
import re
import time
from datetime import datetime, timezone
from threading import Lock

from flask import Blueprint, current_app, jsonify, request

from database import db
from models import License, Product, UserEntitlement
from utils.anomaly import get_tracker
from utils.audit import audit_event
from utils.crypto import hmac_sha256_hex, sha256_hex, verify_jwt_allow_expired
from utils.rate_limiter import get_limiter

from .challenge import get_challenge_store
from .session import get_session_manager

auth_bp = Blueprint('auth', __name__)

# Generic error to avoid information leakage
_AUTH_ERR = {'ok': False, 'error': 'Authentication failed'}
_RATE_ERR = {'ok': False, 'error': 'Too many requests'}
_INPUT_ERR = {'ok': False, 'error': 'Invalid request'}
_HWID_RE = re.compile(r'^[0-9a-fA-F]{64}$')
_UUID_RE = re.compile(r'^[0-9a-fA-F-]{36,64}$')
_HEX64_RE = re.compile(r'^[0-9a-fA-F]{64}$')
_REQUEST_CLEANUP_EVERY = 200
_request_counter = 0
_request_counter_lock = Lock()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _client_ip() -> str:
    forwarded = request.headers.get('X-Forwarded-For', '')
    if forwarded:
        return forwarded.split(',')[0].strip()
    return request.remote_addr or '0.0.0.0'


def _require_json(*fields):
    """Return the parsed JSON body or (None, error_response) if invalid."""
    # [SECURITY HARDENING] Limit request body size to mitigate abuse.
    max_body: int = int(current_app.config.get('MAX_JSON_BODY_BYTES', 16_384))
    content_len = request.content_length
    if content_len is not None and content_len > max_body:
        return None, (jsonify(_INPUT_ERR), 413)
    if not request.is_json:
        return None, (jsonify(_INPUT_ERR), 400)
    data = request.get_json(silent=True)
    if not data:
        return None, (jsonify(_INPUT_ERR), 400)
    for f in fields:
        if f not in data or data[f] is None or data[f] == '':
            return None, (jsonify(_INPUT_ERR), 400)
    return data, None


def _lookup_license_by_key(license_key: str) -> License | None:
    """Constant-time-safe license lookup by hashed key."""
    normalized = license_key.strip().upper().replace('-', '')
    key_hash = sha256_hex(normalized)
    return License.query.filter_by(key_hash=key_hash).first()


def _string_field(data: dict, key: str, min_len: int = 1, max_len: int = 2048) -> str | None:
    value = data.get(key)
    if value is None:
        return None
    text = str(value).strip()
    if len(text) < min_len or len(text) > max_len:
        return None
    return text


def _int_field(data: dict, key: str, min_value: int, max_value: int) -> int | None:
    raw = data.get(key)
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    if value < min_value or value > max_value:
        return None
    return value


def _run_housekeeping() -> None:
    global _request_counter
    with _request_counter_lock:
        _request_counter += 1
        if _request_counter % _REQUEST_CLEANUP_EVERY != 0:
            return

    # [SECURITY HARDENING] Periodic cleanup prevents in-memory trackers
    # from growing without bound under random-IP spray.
    try:
        get_limiter().cleanup(max_age=600.0)
        get_tracker().cleanup()
    except Exception:
        # Never let housekeeping interfere with auth request handling.
        pass


def _check_rate(ip: str, action: str, limit: int) -> bool:
    _run_housekeeping()
    limiter = get_limiter()
    key = f'{action}:{ip}'
    global_key = f'global:{ip}'
    global_limit: int = current_app.config['GLOBAL_RPM']

    if not limiter.check_and_record(key, limit, 60):
        return False
    if not limiter.check_and_record(global_key, global_limit, 60):
        return False
    return True


# ---------------------------------------------------------------------------
# POST /v1/auth/challenge
# ---------------------------------------------------------------------------

@auth_bp.route('/v1/auth/challenge', methods=['POST'])
def auth_challenge():
    ip = _client_ip()
    limit: int = current_app.config['CHALLENGE_RPM']

    if not _check_rate(ip, 'challenge', limit):
        audit_event('auth.challenge.rate_limited', ip=ip)
        return jsonify(_RATE_ERR), 429

    data, err = _require_json('hwid_fp', 'client_ts')
    if err:
        audit_event('auth.challenge.bad_request', ip=ip, reason='missing_or_invalid_json')
        return err

    hwid_fp = _string_field(data, 'hwid_fp', min_len=64, max_len=64)
    if hwid_fp is None or _HWID_RE.fullmatch(hwid_fp) is None:
        audit_event('auth.challenge.bad_request', ip=ip, reason='invalid_hwid_shape')
        return jsonify(_INPUT_ERR), 400

    now_ms = int(time.time() * 1000)
    # [SECURITY HARDENING] Allow modest clock skew only.
    client_ts = _int_field(data, 'client_ts', min_value=946684800000, max_value=now_ms + 600_000)
    if client_ts is None:
        audit_event('auth.challenge.bad_request', ip=ip, reason='invalid_client_ts')
        return jsonify(_INPUT_ERR), 400

    tracker = get_tracker()

    # Clock skew check
    skew = time.time() - client_ts / 1000.0
    tracker.record_clock_skew(ip, skew)
    tracker.record_hwid(ip, hwid_fp)

    if tracker.is_suspicious(ip, threshold=75, client_ts_ms=client_ts):
        audit_event('auth.challenge.blocked', ip=ip, reason='anomaly')
        return jsonify(_AUTH_ERR), 403

    store = get_challenge_store()
    result = store.create(hwid_fp)
    audit_event('auth.challenge.ok', ip=ip)
    return jsonify(result), 200


# ---------------------------------------------------------------------------
# POST /v1/auth/verify
# ---------------------------------------------------------------------------

@auth_bp.route('/v1/auth/verify', methods=['POST'])
def auth_verify():
    ip = _client_ip()
    limit: int = current_app.config['VERIFY_RPM']

    if not _check_rate(ip, 'verify', limit):
        audit_event('auth.verify.rate_limited', ip=ip)
        return jsonify(_RATE_ERR), 429

    data, err = _require_json(
        'challenge_id', 'license_key', 'hwid_fp',
        'challenge_response', 'client_ts', 'challenge_token',
    )
    if err:
        audit_event('auth.verify.bad_request', ip=ip, reason='missing_or_invalid_json')
        return err

    challenge_id = _string_field(data, 'challenge_id', min_len=32, max_len=96)
    license_key = _string_field(data, 'license_key', min_len=8, max_len=64)
    hwid_fp = _string_field(data, 'hwid_fp', min_len=64, max_len=64)
    challenge_response = _string_field(data, 'challenge_response', min_len=64, max_len=64)
    challenge_token = _string_field(data, 'challenge_token', min_len=32, max_len=4096)
    now_ms = int(time.time() * 1000)
    client_ts = _int_field(data, 'client_ts', min_value=946684800000, max_value=now_ms + 600_000)

    if (
        challenge_id is None
        or license_key is None
        or hwid_fp is None
        or challenge_response is None
        or challenge_token is None
        or client_ts is None
        or _UUID_RE.fullmatch(challenge_id) is None
        or _HWID_RE.fullmatch(hwid_fp) is None
        or _HEX64_RE.fullmatch(challenge_response) is None
    ):
        audit_event('auth.verify.bad_request', ip=ip, reason='invalid_field_shape')
        return jsonify(_INPUT_ERR), 400

    tracker = get_tracker()

    # Anomaly check
    skew = time.time() - client_ts / 1000.0
    tracker.record_clock_skew(ip, skew)
    tracker.record_hwid(ip, hwid_fp)

    if tracker.is_suspicious(ip, threshold=75, client_ts_ms=client_ts):
        tracker.record_failure(ip, 'anomaly')
        audit_event('auth.verify.blocked', ip=ip, reason='anomaly')
        return jsonify(_AUTH_ERR), 403

    # --- 1. Verify challenge response (consumes the challenge) ---
    challenge_store = get_challenge_store()
    if not challenge_store.verify_and_consume(
        challenge_id, hwid_fp, license_key, challenge_response, client_ts, challenge_token
    ):
        tracker.record_failure(ip, 'bad_challenge')
        audit_event('auth.verify.failed', ip=ip, reason='bad_challenge')
        return jsonify(_AUTH_ERR), 401

    # --- 2. Look up the license ---
    license = _lookup_license_by_key(license_key)
    if license is None:
        tracker.record_failure(ip, 'not_found')
        audit_event('auth.verify.failed', ip=ip, reason='not_found')
        return jsonify(_AUTH_ERR), 401

    if not license.is_active():
        tracker.record_failure(ip, 'inactive')
        audit_event('auth.verify.failed', ip=ip, reason='inactive')
        return jsonify(_AUTH_ERR), 401

    # Standalone keys are allowed — the session payload carries their granted_macros
    # so the client can restrict which macros are active.

    # --- 3. HWID binding ---
    new_hwid_hash = sha256_hex(hwid_fp)
    max_changes: int = current_app.config['MAX_HWID_CHANGES']

    if license.hwid_hash is None:
        # First activation - bind HWID
        license.hwid_hash = new_hwid_hash
        license.activated_at = datetime.now(timezone.utc)
    elif not secrets.compare_digest(license.hwid_hash, new_hwid_hash):
        # Different device
        if license.hwid_change_count >= max_changes:
            tracker.record_failure(ip, 'hwid_locked')
            audit_event('auth.verify.failed', ip=ip, reason='hwid_locked')
            return jsonify(_AUTH_ERR), 401
        license.hwid_hash = new_hwid_hash
        license.hwid_change_count += 1

    # Rotate the active server-side session marker on every successful login.
    license.session_nonce = secrets.token_hex(16)
    license.last_validated = datetime.now(timezone.utc)

    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({'ok': False, 'error': 'Internal error'}), 500

    tracker.record_success(ip)
    audit_event('auth.verify.ok', ip=ip, license_id=license.id, tier=license.tier)

    # --- 4. Issue session ---
    session_manager = get_session_manager()
    session_data = session_manager.create_session(license, hwid_fp)
    return jsonify(session_data), 200


# ---------------------------------------------------------------------------
# POST /v1/session/refresh
# ---------------------------------------------------------------------------

@auth_bp.route('/v1/session/refresh', methods=['POST'])
def session_refresh():
    ip = _client_ip()
    limit: int = current_app.config.get('GLOBAL_RPM', 60)

    if not _check_rate(ip, 'refresh', limit):
        audit_event('auth.refresh.rate_limited', ip=ip)
        return jsonify(_RATE_ERR), 429

    data, err = _require_json('session_token', 'hwid_fp')
    if err:
        audit_event('auth.refresh.bad_request', ip=ip, reason='missing_or_invalid_json')
        return err

    token = _string_field(data, 'session_token', min_len=32, max_len=4096)
    hwid_fp = _string_field(data, 'hwid_fp', min_len=64, max_len=64)
    if token is None or hwid_fp is None or _HWID_RE.fullmatch(hwid_fp) is None:
        audit_event('auth.refresh.bad_request', ip=ip, reason='invalid_field_shape')
        return jsonify(_INPUT_ERR), 400

    payload = verify_jwt_allow_expired(token, current_app.config['SECRET_KEY'].encode())
    if payload is None:
        audit_event('auth.refresh.failed', ip=ip, reason='invalid_token')
        return jsonify(_AUTH_ERR), 401

    try:
        license_id = int(payload.get('lid', 0))
    except (TypeError, ValueError):
        audit_event('auth.refresh.failed', ip=ip, reason='invalid_license_id')
        return jsonify(_AUTH_ERR), 401

    license = db.session.get(License, license_id)

    if license is None or not license.is_active():
        audit_event('auth.refresh.failed', ip=ip, reason='inactive_or_missing')
        return jsonify(_AUTH_ERR), 401

    session_manager = get_session_manager()
    result = session_manager.refresh_session(token, hwid_fp, license)

    if result is None:
        audit_event('auth.refresh.failed', ip=ip, reason='refresh_rejected', license_id=license.id)
        return jsonify(_AUTH_ERR), 401

    license.last_validated = datetime.now(timezone.utc)
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({'ok': False, 'error': 'Internal error'}), 500

    audit_event('auth.refresh.ok', ip=ip, license_id=license.id, tier=license.tier)
    return jsonify(result), 200


# ---------------------------------------------------------------------------
# Entitlement check — used by standalone CLI apps
# ---------------------------------------------------------------------------

@auth_bp.route('/v1/entitlement/check', methods=['POST'])
def entitlement_check():
    """
    Verify that a session token's license owns a specific standalone product.

    Body: {session_token: str, product_id: str}
    Returns: {ok, granted, product_id, product_name}
    """
    ip = _client_ip()
    lim = get_limiter()
    if not lim.check_and_record(f'entcheck:{ip}', 20, 60):
        return jsonify({'ok': False, 'error': 'rate_limited'}), 429

    data = request.get_json(silent=True) or {}
    session_token = str(data.get('session_token') or '').strip()
    product_id    = str(data.get('product_id') or '').strip()

    if not session_token or not product_id:
        return jsonify({'ok': False, 'error': 'session_token and product_id required'}), 400

    product = Product.query.get(product_id)
    if not product or not product.is_active:
        return jsonify({'ok': False, 'error': 'Unknown product'}), 404

    # Validate the JWT — decode and verify signature only (no HWID re-check needed here)
    from utils.crypto import verify_jwt
    server_secret = str(current_app.config.get('SECRET_KEY', '')).encode()
    payload = verify_jwt(session_token, server_secret)
    if not payload:
        return jsonify({'ok': False, 'error': 'invalid_session'}), 401

    license_id = payload.get('lid')
    lic = License.query.get(license_id) if license_id else None
    if not lic or not lic.is_active():
        return jsonify({'ok': False, 'error': 'license_inactive'}), 403

    ent = UserEntitlement.query.filter_by(
        license_key_hash=lic.key_hash,
        product_id=product_id,
    ).first()

    granted = ent is not None
    audit_event('entitlement.check', product_id=product_id,
                license_id=lic.id, granted=granted, ip=ip)

    return jsonify({
        'ok':           True,
        'granted':      granted,
        'product_id':   product_id,
        'product_name': product.name,
    }), 200
