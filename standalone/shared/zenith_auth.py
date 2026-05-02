"""
Shared Zenith Macros auth module — reused by all standalone CLI apps.
Each CLI imports this and passes its own PRODUCT_ID.
"""
import hashlib
import hmac as _hmac
import json
import re
import socket
import time
import urllib.error
import urllib.request

API_BASE = "https://zenith-license.fly.dev"
HEADERS  = {
    "Content-Type": "application/json",
    "User-Agent":   "ZenithStandalone/1.0",
}


def _post(path: str, body: dict) -> dict:
    data = json.dumps(body).encode()
    req  = urllib.request.Request(
        f"{API_BASE}{path}", data=data, headers=HEADERS, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read())
        except Exception:
            return {"ok": False, "error": f"HTTP {e.code}"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def normalize_key(raw: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", raw.upper())


def hwid_fp() -> str:
    return hashlib.sha256((socket.gethostname() + "-zenith").encode()).hexdigest()


def verify_license(raw_key: str, product_id: str) -> dict:
    """
    Full auth + entitlement check for any standalone product.

    Args:
        raw_key:    User's raw license key (with or without dashes)
        product_id: e.g. "zenith-single-anchor"

    Returns:
        {"ok": True,  "session_token": str, "tier": str, "product_name": str}
        {"ok": False, "error": str, "code": str}

    Error codes:
        bad_key         — key too short
        challenge       — challenge request failed
        invalid         — key not found / invalid
        hwid_locked     — device limit reached
        entitlement_error  — entitlement check request failed
        no_entitlement  — key is valid but doesn't own this product
    """
    key = normalize_key(raw_key)
    if len(key) < 16:
        return {"ok": False, "error": "Key is too short — check for typos.", "code": "bad_key"}

    fp        = hwid_fp()
    client_ts = int(time.time() * 1000)  # backend expects milliseconds

    ch = _post("/v1/auth/challenge", {"hwid_fp": fp, "client_ts": client_ts})
    if not ch.get("challenge_id"):
        return {"ok": False, "error": ch.get("error", "Challenge failed"), "code": "challenge"}

    msg      = f"verify:{ch['challenge_id']}:{ch['challenge_nonce']}:{fp}:{client_ts}"
    response = _hmac.new(key.encode(), msg.encode(), hashlib.sha256).hexdigest()

    vr = _post("/v1/auth/verify", {
        "license_key":        key,
        "challenge_id":       ch["challenge_id"],
        "challenge_response": response,
        "challenge_token":    ch["challenge_token"],
        "hwid_fp":            fp,
        "client_ts":          client_ts,
    })
    if not vr.get("ok"):
        err  = vr.get("error", "Verification failed")
        code = "hwid_locked" if "hwid" in err.lower() else "invalid"
        return {"ok": False, "error": err, "code": code}

    session_token = vr.get("session_token", "")
    tier          = vr.get("tier", "")

    er = _post("/v1/entitlement/check", {
        "session_token": session_token,
        "product_id":    product_id,
    })
    if not er.get("ok"):
        return {"ok": False, "error": er.get("error", "Entitlement check failed"), "code": "entitlement_error"}

    if not er.get("granted"):
        return {
            "ok":    False,
            "error": f"This key does not own {er.get('product_name', product_id)}.\n"
                     "  Purchase it at: zenithmacros.store",
            "code":  "no_entitlement",
        }

    return {
        "ok":            True,
        "session_token": session_token,
        "tier":          tier,
        "product_name":  er.get("product_name", product_id),
    }


def refresh_session(session_token: str, raw_key: str, product_id: str) -> dict:
    """Try a cheap session refresh; falls back to full re-verify."""
    fp        = hwid_fp()
    client_ts = int(time.time() * 1000)
    r = _post("/v1/session/refresh", {
        "session_token": session_token,
        "hwid_fp":       fp,
        "client_ts":     client_ts,
    })
    if r.get("ok"):
        return {"ok": True, "session_token": r.get("session_token", session_token)}
    return verify_license(raw_key, product_id)
