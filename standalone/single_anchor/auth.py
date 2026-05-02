"""License verification + entitlement check for Single Anchor CLI."""
import hashlib
import hmac as _hmac
import json
import re
import time
import urllib.error
import urllib.request

API_BASE   = "https://zenith-license.fly.dev"
PRODUCT_ID = "zenith-single-anchor"
HEADERS    = {
    "Content-Type": "application/json",
    "User-Agent":   "ZenithSingleAnchor/1.0",
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


def _normalize_key(raw: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", raw.upper())


def verify_license(raw_key: str) -> dict:
    """
    Run the full auth challenge/verify + entitlement check.

    Returns:
        {"ok": True,  "session_token": "...", "tier": "...", "product_name": "..."}
        {"ok": False, "error": "...", "code": "no_entitlement"|"invalid"|...}
    """
    key = _normalize_key(raw_key)
    if len(key) < 16:
        return {"ok": False, "error": "Key is too short — check for typos.", "code": "bad_key"}

    # Step 1: challenge
    hwid_fp = hashlib.sha256(
        (urllib.request.socket.gethostname() + "-zenith-sa").encode()
    ).hexdigest()
    client_ts = int(time.time() * 1000)  # backend expects milliseconds
    ch = _post("/v1/auth/challenge", {"hwid_fp": hwid_fp, "client_ts": client_ts})
    if not ch.get("challenge_id"):
        return {"ok": False, "error": ch.get("error", "Challenge failed"), "code": "challenge"}

    challenge_id     = ch["challenge_id"]
    challenge_nonce  = ch["challenge_nonce"]
    challenge_token  = ch["challenge_token"]

    # Step 2: compute HMAC response
    msg = f"verify:{challenge_id}:{challenge_nonce}:{hwid_fp}:{client_ts}"
    response = _hmac.new(key.encode(), msg.encode(), hashlib.sha256).hexdigest()

    vr = _post("/v1/auth/verify", {
        "license_key":        key,
        "challenge_id":       challenge_id,
        "challenge_response": response,
        "challenge_token":    challenge_token,
        "hwid_fp":            hwid_fp,
        "client_ts":          client_ts,
    })
    if not vr.get("ok"):
        err = vr.get("error", "Verification failed")
        code = "hwid_locked" if "hwid" in err.lower() else "invalid"
        return {"ok": False, "error": err, "code": code}

    session_token = vr.get("session_token", "")
    tier          = vr.get("tier", "")

    # Step 3: entitlement check
    er = _post("/v1/entitlement/check", {
        "session_token": session_token,
        "product_id":    PRODUCT_ID,
    })
    if not er.get("ok"):
        return {"ok": False, "error": er.get("error", "Entitlement check failed"), "code": "entitlement_error"}

    if not er.get("granted"):
        return {
            "ok":    False,
            "error": "This key does not own Single Anchor. Purchase it at zenithmacros.store",
            "code":  "no_entitlement",
        }

    return {
        "ok":           True,
        "session_token": session_token,
        "tier":          tier,
        "product_name":  er.get("product_name", "Single Anchor"),
    }


def refresh_session(session_token: str, raw_key: str) -> dict:
    """Try to refresh an existing session. Falls back to full re-verify if needed."""
    hwid_fp   = hashlib.sha256(
        (urllib.request.socket.gethostname() + "-zenith-sa").encode()
    ).hexdigest()
    client_ts = int(time.time() * 1000)
    r = _post("/v1/session/refresh", {
        "session_token": session_token,
        "hwid_fp":       hwid_fp,
        "client_ts":     client_ts,
    })
    if r.get("ok"):
        return {"ok": True, "session_token": r.get("session_token", session_token)}
    # Full re-verify
    return verify_license(raw_key)
