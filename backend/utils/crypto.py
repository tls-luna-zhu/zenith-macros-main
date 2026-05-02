"""
Cryptographic utilities for ZenithMacros auth backend.

All AES-256-GCM operations use a 12-byte IV and a 16-byte authentication tag
appended to the ciphertext (standard GCM convention used by the cryptography
library's AESGCM primitive).
"""

import base64
import hashlib
import hmac as hmac_stdlib
import json
import os
import time
from typing import Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


# ---------------------------------------------------------------------------
# Low-level symmetric crypto
# ---------------------------------------------------------------------------

def aes256_gcm_encrypt(key: bytes, plaintext: bytes) -> tuple[bytes, bytes]:
    """Encrypt *plaintext* under *key* with AES-256-GCM.

    Returns (ciphertext_with_tag, iv).  The 16-byte GCM authentication tag is
    appended to the ciphertext by the underlying library.
    """
    if len(key) != 32:
        raise ValueError(f'AES-256 requires a 32-byte key, got {len(key)}')
    iv = os.urandom(12)
    aesgcm = AESGCM(key)
    ct = aesgcm.encrypt(iv, plaintext, None)  # no AAD
    return ct, iv


def aes256_gcm_decrypt(key: bytes, ciphertext: bytes, iv: bytes) -> bytes:
    """Decrypt AES-256-GCM ciphertext (with appended tag).

    Raises an exception from the cryptography library if the tag is invalid.
    """
    if len(key) != 32:
        raise ValueError(f'AES-256 requires a 32-byte key, got {len(key)}')
    if len(iv) != 12:
        raise ValueError(f'AES-GCM IV must be 12 bytes, got {len(iv)}')
    aesgcm = AESGCM(key)
    return aesgcm.decrypt(iv, ciphertext, None)


# ---------------------------------------------------------------------------
# HMAC / hashing helpers
# ---------------------------------------------------------------------------

def hmac_sha256(key: bytes, data: bytes) -> bytes:
    """Return the raw 32-byte HMAC-SHA256 digest."""
    return hmac_stdlib.new(key, data, hashlib.sha256).digest()


def hmac_sha256_hex(key, data) -> str:
    """Return the hex-encoded HMAC-SHA256 digest.

    *key* and *data* may each be ``str`` or ``bytes``; strings are encoded as
    UTF-8.
    """
    k = key.encode() if isinstance(key, str) else key
    d = data.encode() if isinstance(data, str) else data
    return hmac_stdlib.new(k, d, hashlib.sha256).hexdigest()


def sha256_hex(data) -> str:
    """Return the hex-encoded SHA-256 digest of *data* (str or bytes)."""
    b = data.encode() if isinstance(data, str) else data
    return hashlib.sha256(b).hexdigest()


# ---------------------------------------------------------------------------
# Key derivation
# ---------------------------------------------------------------------------

def derive_challenge_key(shared_secret: str, hwid_fp: str, req_nonce: str) -> bytes:
    """Derive the 32-byte AES key used to encrypt a challenge secret.

    challenge_key = HMAC-SHA256(shared_secret, hwid_fp + ":" + req_nonce)
    The full 32-byte HMAC output is used directly as the key.
    """
    key = shared_secret.encode()
    data = (hwid_fp + ':' + req_nonce).encode()
    return hmac_sha256(key, data)  # 32 bytes


def derive_session_key(jti: str, shared_secret: str) -> bytes:
    """Derive the 32-byte key used to encrypt the user_enc_key in transit.

    transport_key = SHA-256(shared_secret + ":" + jti)

    Uses SHARED_SECRET (known to both server and client) so the client can
    decrypt the user_enc_key without access to the server-only SECRET_KEY.
    """
    raw = (shared_secret + ':' + jti).encode()
    return hashlib.sha256(raw).digest()  # 32 bytes


# ---------------------------------------------------------------------------
# JWT (custom, no library required)
# ---------------------------------------------------------------------------

def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def _b64url_decode(s: str) -> bytes:
    # Add padding
    pad = 4 - len(s) % 4
    if pad != 4:
        s += '=' * pad
    return base64.urlsafe_b64decode(s)


def make_jwt(payload: dict, secret: bytes, user_salt: str) -> str:
    """Create a custom JWT signed with HMAC-SHA256(secret + "." + user_salt).

    Header is always {"alg":"HS256","typ":"ZNT"}.
    """
    header = _b64url_encode(json.dumps({'alg': 'HS256', 'typ': 'ZNT'}, separators=(',', ':')).encode())
    body = _b64url_encode(json.dumps(payload, separators=(',', ':')).encode())
    signing_input = f'{header}.{body}'
    signing_key = secret + b'.' + user_salt.encode()
    sig = hmac_sha256(signing_key, signing_input.encode())
    return f'{signing_input}.{_b64url_encode(sig)}'


def _verify_jwt_payload(token: str, secret: bytes, allow_expired: bool = False) -> Optional[dict]:
    try:
        parts = token.split('.')
        if len(parts) != 3:
            return None
        header_b64, payload_b64, sig_b64 = parts

        payload = json.loads(_b64url_decode(payload_b64))
        user_salt = payload.get('_salt', '')
        signing_key = secret + b'.' + user_salt.encode()
        signing_input = f'{header_b64}.{payload_b64}'
        expected_sig = hmac_sha256(signing_key, signing_input.encode())
        provided_sig = _b64url_decode(sig_b64)

        if not hmac_stdlib.compare_digest(expected_sig, provided_sig):
            return None

        # Check expiry unless the caller explicitly allows the normal refresh
        # grace window to handle a recently expired token.
        exp = payload.get('exp', 0)
        if not allow_expired and time.time() > exp:
            return None

        return payload
    except Exception:
        return None


def verify_jwt(token: str, secret: bytes) -> Optional[dict]:
    """Verify a JWT produced by :func:`make_jwt` and reject expired tokens."""
    return _verify_jwt_payload(token, secret, allow_expired=False)


def verify_jwt_allow_expired(token: str, secret: bytes) -> Optional[dict]:
    """Verify a JWT signature while allowing the payload to be expired."""
    return _verify_jwt_payload(token, secret, allow_expired=True)


# ---------------------------------------------------------------------------
# Session token generation
# ---------------------------------------------------------------------------

def generate_session_token(license, hwid_fp: str, server_secret: str, ttl_seconds: int) -> str:
    """Build and sign a session JWT for *license*.

    The ``_salt`` field is embedded in the payload so :func:`verify_jwt` can
    recover it without a separate DB lookup during lightweight token checks.
    """
    import secrets as _secrets
    now = int(time.time())
    jti = _secrets.token_hex(16)
    sub = sha256_hex(license.key)[:16]

    payload = {
        'lid': license.id,
        'sub': sub,
        'hwid': hwid_fp[:32],
        'iat': now,
        'exp': now + max(60, int(ttl_seconds)),
        'jti': jti,
        'snc': license.session_nonce,
        'tier': license.tier,
        'iss': 'zenith-auth',
        'ver': '2026.1',
        '_salt': license.user_salt,
    }
    return make_jwt(payload, server_secret.encode(), license.user_salt)


# ---------------------------------------------------------------------------
# User key transport encryption
# ---------------------------------------------------------------------------

def encrypt_user_key_for_transport(
    user_enc_key: bytes,
    jti: str,
    server_secret: str,
) -> tuple[str, str]:
    """Encrypt the 32-byte per-user AES key for in-transit delivery.

    Returns (enc_b64, iv_b64) where *enc_b64* is the base64-encoded
    AES-256-GCM ciphertext+tag and *iv_b64* is the base64-encoded 12-byte IV.
    """
    transport_key = derive_session_key(jti, server_secret)
    ct, iv = aes256_gcm_encrypt(transport_key, user_enc_key)
    return base64.b64encode(ct).decode(), base64.b64encode(iv).decode()
