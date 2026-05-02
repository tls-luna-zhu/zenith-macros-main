"""
Session management: create, validate, and refresh JWT sessions.
"""

import secrets
import time
from datetime import timezone
from typing import Optional

from flask import current_app

from utils.crypto import (
    generate_session_token,
    verify_jwt,
    verify_jwt_allow_expired,
)


class SessionManager:
    """Stateless session manager (all state is encoded in the JWT)."""

    # ------------------------------------------------------------------
    # Session creation
    # ------------------------------------------------------------------

    def create_session(self, license, hwid_fp: str) -> dict:
        """Issue a new session for *license* bound to *hwid_fp*.

        Returns the full success payload ready to send to the client.
        """
        server_secret: str = current_app.config['SECRET_KEY']
        ttl_seconds: int = current_app.config.get('SESSION_TTL', 900)
        token = generate_session_token(license, hwid_fp, server_secret, ttl_seconds)

        expires_at_iso = ''
        if license.expires_at:
            exp = license.expires_at
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
            expires_at_iso = exp.isoformat()

        # For standalone tier: pull the list of granted macro product IDs from the
        # license metadata so the client knows exactly which macros to unlock.
        granted_macros: list = []
        if license.tier == 'standalone':
            import json as _json
            try:
                meta = _json.loads(license.metadata or '{}') if isinstance(license.metadata, str) else (license.metadata or {})
                granted_macros = meta.get('standalone_macros', [])
            except Exception:
                granted_macros = []

            # Also pull from UserEntitlement rows if metadata is empty
            if not granted_macros:
                try:
                    from models import UserEntitlement
                    ents = UserEntitlement.query.filter_by(license_key_hash=license.key_hash).all()
                    granted_macros = [e.product_id for e in ents]
                except Exception:
                    granted_macros = []

        return {
            'ok': True,
            'session_token': token,
            'tier': license.tier,
            'expires_at': expires_at_iso,
            'granted_macros': granted_macros,  # non-empty only for standalone tier
        }

    # ------------------------------------------------------------------
    # Session validation
    # ------------------------------------------------------------------

    def validate_session(self, token: str, hwid_fp: str) -> Optional[dict]:
        """Verify a session token and return its payload, or None on failure.

        Performs signature verification (via verify_jwt) and a partial HWID
        check: the first 16 characters of hwid_fp must match the ``hwid``
        claim stored in the token.
        """
        server_secret: str = current_app.config['SECRET_KEY']
        payload = verify_jwt(token, server_secret.encode())
        if payload is None:
            return None

        # Partial HWID match - the token only stores the first 16 chars
        token_hwid = payload.get('hwid', '')
        if not secrets.compare_digest(token_hwid, hwid_fp[:32]):
            return None

        return payload

    # ------------------------------------------------------------------
    # Session refresh
    # ------------------------------------------------------------------

    def refresh_session(
        self,
        token: str,
        hwid_fp: str,
        license,
    ) -> Optional[dict]:
        """Refresh a session within the allowed window after expiry.

        Returns a new session dict or None when the refresh is rejected.
        """
        import secrets as _secrets

        refresh_window: int = current_app.config.get('REFRESH_WINDOW', 120)

        server_secret: str = current_app.config['SECRET_KEY']
        payload = verify_jwt_allow_expired(token, server_secret.encode())
        if payload is None:
            return None

        exp = payload.get('exp', 0)
        now = int(time.time())

        # Allow refresh up to REFRESH_WINDOW seconds after expiry
        if now > exp + refresh_window:
            return None

        # HWID partial check
        token_hwid = payload.get('hwid', '')
        if not _secrets.compare_digest(token_hwid, hwid_fp[:32]):
            return None

        # Reject stale sessions after the license has rotated its active nonce.
        token_nonce = payload.get('snc', '')
        current_nonce = getattr(license, 'session_nonce', '') or ''
        if not token_nonce or not current_nonce or not _secrets.compare_digest(token_nonce, current_nonce):
            return None

        # Any successful refresh rotates the active nonce so the previous
        # session token becomes stale immediately.
        license.session_nonce = _secrets.token_hex(16)

        # Issue a fresh session
        return self.create_session(license, hwid_fp)


# Module-level singleton
_session_manager = SessionManager()


def get_session_manager() -> SessionManager:
    return _session_manager
