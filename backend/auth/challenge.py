"""
Challenge store: creates signed single-use challenges with TTL.

The server issues a random nonce plus a signed challenge token. The client
proves possession of the license key by HMACing server-provided challenge
fields; no reusable shared client/server secret is embedded in the app.
"""

import secrets
import time
import uuid
from threading import Lock

from flask import current_app

from utils.crypto import _b64url_decode, _b64url_encode, hmac_sha256, hmac_sha256_hex


class _ChallengeEntry:
    __slots__ = ("hwid_fp", "nonce", "created_at")

    def __init__(self, hwid_fp: str, nonce: str):
        self.hwid_fp = hwid_fp
        self.nonce = nonce
        self.created_at = time.monotonic()


class ChallengeStore:
    """Thread-safe, TTL-bounded store for pending challenges."""

    def __init__(self):
        self._lock = Lock()
        self._store: dict[str, _ChallengeEntry] = {}
        self._consumed: dict[str, float] = {}  # challenge_id → monotonic time (replay guard)

    def create(self, hwid_fp: str) -> dict:
        self._evict_expired()

        ttl: int = current_app.config["CHALLENGE_TTL"]
        challenge_id = str(uuid.uuid4())
        nonce = secrets.token_hex(16)
        token = self._sign_challenge_token(challenge_id, hwid_fp, nonce, ttl)

        with self._lock:
            self._store[challenge_id] = _ChallengeEntry(hwid_fp, nonce)

        return {
            "challenge_id": challenge_id,
            "challenge_nonce": nonce,
            "challenge_token": token,
            "server_ts": int(time.time() * 1000),
            "ttl": ttl,
        }

    def verify_and_consume(
        self,
        challenge_id: str,
        hwid_fp: str,
        license_key: str,
        challenge_response: str,
        client_ts: int,
        challenge_token: str,
    ) -> bool:
        with self._lock:
            entry = self._store.pop(challenge_id, None)

        if entry is not None:
            # Fast path: in-memory entry found (same worker handled challenge).
            if not self._verify_challenge_token(challenge_token, challenge_id, hwid_fp, entry.nonce):
                return False
            if not secrets.compare_digest(entry.hwid_fp, hwid_fp):
                return False
            nonce = entry.nonce
        else:
            # Fallback: challenge landed on a different gunicorn worker.
            # The signed challenge_token is self-contained and tamper-proof,
            # so we can extract the nonce from it safely.
            payload = self._extract_challenge_token(challenge_token, challenge_id, hwid_fp)
            if payload is None:
                return False
            nonce = payload["nonce"]
            # Track consumed challenge IDs to prevent replay within TTL window.
            with self._lock:
                if challenge_id in self._consumed:
                    return False
                self._consumed[challenge_id] = time.monotonic()

        msg = f"verify:{challenge_id}:{nonce}:{hwid_fp}:{client_ts}"
        norm_key = license_key.strip().upper().replace("-", "")
        expected = hmac_sha256_hex(norm_key, msg)
        return secrets.compare_digest(expected, challenge_response)

    def _extract_challenge_token(self, token: str, challenge_id: str, hwid_fp: str):
        """Verify the signed token and return its payload, or None."""
        payload = _verify_signed_token(token, current_app.config["SECRET_KEY"].encode())
        if payload is None:
            return None
        if payload.get("typ") != "znt_chal":
            return None
        if payload.get("cid") != challenge_id:
            return None
        if payload.get("hwid") != hwid_fp:
            return None
        if "nonce" not in payload:
            return None
        return payload

    def _sign_challenge_token(self, challenge_id: str, hwid_fp: str, nonce: str, ttl: int) -> str:
        issued_at = int(time.time())
        payload = {
            "cid": challenge_id,
            "hwid": hwid_fp,
            "nonce": nonce,
            "iat": issued_at,
            "exp": issued_at + ttl,
            "typ": "znt_chal",
        }
        return _make_signed_token(payload, current_app.config["SECRET_KEY"].encode())

    def _verify_challenge_token(self, token: str, challenge_id: str, hwid_fp: str, nonce: str) -> bool:
        payload = _verify_signed_token(token, current_app.config["SECRET_KEY"].encode())
        if payload is None:
            return False
        if payload.get("typ") != "znt_chal":
            return False
        if payload.get("cid") != challenge_id:
            return False
        if payload.get("hwid") != hwid_fp:
            return False
        if payload.get("nonce") != nonce:
            return False
        return True

    def _evict_expired(self) -> None:
        try:
            ttl: int = current_app.config["CHALLENGE_TTL"]
        except RuntimeError:
            ttl = 60

        now = time.monotonic()
        with self._lock:
            dead = [cid for cid, e in self._store.items() if now - e.created_at > ttl * 2]
            for cid in dead:
                del self._store[cid]
            # Also purge stale consumed-challenge replay entries.
            stale = [cid for cid, ts in self._consumed.items() if now - ts > ttl * 2]
            for cid in stale:
                del self._consumed[cid]


def _make_signed_token(payload: dict, secret: bytes) -> str:
    import json

    header = _b64url_encode(json.dumps({"alg": "HS256", "typ": "ZNTC"}, separators=(",", ":")).encode())
    body = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode())
    signing_input = f"{header}.{body}"
    sig = hmac_sha256(secret, signing_input.encode())
    return f"{signing_input}.{_b64url_encode(sig)}"


def _verify_signed_token(token: str, secret: bytes):
    import json

    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None
        header_b64, payload_b64, sig_b64 = parts
        signing_input = f"{header_b64}.{payload_b64}"
        expected_sig = hmac_sha256(secret, signing_input.encode())
        provided_sig = _b64url_decode(sig_b64)
        if not secrets.compare_digest(expected_sig, provided_sig):
            return None
        payload = json.loads(_b64url_decode(payload_b64))
        if time.time() > int(payload.get("exp", 0)):
            return None
        return payload
    except Exception:
        return None


_challenge_store = ChallengeStore()


def get_challenge_store() -> ChallengeStore:
    return _challenge_store
