"""
Lightweight structured security audit logging.

Designed to be fail-safe: logging failures must never break request handling.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any

from flask import current_app

_REDACTED_FIELDS = {
    'license_key',
    'session_token',
    'challenge_response',
    'challenge_token',
    'authorization',
    'token',
}


def _hash_token(value: str) -> str:
    secret = str(current_app.config.get('SECRET_KEY', '')).encode()
    digest = hmac.new(secret or b'zenith', value.encode(), hashlib.sha256).hexdigest()
    return digest[:16]


def _safe_value(key: str, value: Any) -> Any:
    if key in _REDACTED_FIELDS:
        return '<redacted>'
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return round(value, 3)
    text = str(value).strip()
    if key in {'ip', 'client_ip'}:
        return _hash_token(text)
    return text[:160]


def audit_event(event: str, **fields: Any) -> None:
    # [SECURITY HARDENING] Structured, privacy-aware audit logging.
    try:
        payload = {
            'event': str(event)[:64],
        }
        for key, value in fields.items():
            payload[str(key)[:64]] = _safe_value(str(key), value)
        current_app.logger.info('[AUDIT] %s', json.dumps(payload, separators=(',', ':')))
    except Exception:
        # Never break request flow due to logging issues.
        pass

