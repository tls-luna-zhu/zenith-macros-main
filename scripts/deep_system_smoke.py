#!/usr/bin/env python3
"""
Deep smoke tests for Zenith backend auth, key, bot, and legacy migration paths.

Runs entirely against an isolated temporary SQLite DB using Flask test_client.
No network calls and no production side effects.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sqlite3
import sys
import tempfile
import time
from pathlib import Path


def _assert(name: str, cond: bool, details: dict, failures: list[str]) -> None:
    details[name] = bool(cond)
    if not cond:
        failures.append(name)


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root / "backend"))

    bot_secret = "s" * 48
    os.environ["BOT_API_SECRET"] = bot_secret
    os.environ["ZENITH_SECRET_KEY"] = "k" * 48
    os.environ["ZENITH_BOT_API_TOKEN"] = "b" * 48
    os.environ["ZENITH_STORE_API_TOKEN"] = "t" * 48

    temp_dir = Path(tempfile.mkdtemp(prefix="zenith_deep_smoke_"))
    os.environ["ZENITH_DB_PATH"] = str(temp_dir / "backend_test.sqlite3")

    from app import create_app
    from database import db
    from models import License
    from utils.crypto import sha256_hex
    import migrate_legacy_keys

    app = create_app()
    details: dict[str, bool | int | str] = {"tmp_dir": str(temp_dir)}
    failures: list[str] = []

    with app.app_context():
        db.create_all()
        base_key = "ABCD-EFGH-IJKL-MNOP-QRST"
        norm_base = base_key.replace("-", "")
        db.session.add(
            License(
                key=norm_base,
                key_hash=sha256_hex(norm_base),
                user_enc_key="11" * 32,
                user_salt="22" * 16,
                session_nonce="33" * 16,
                tier="monthly",
                is_revoked=False,
            )
        )
        db.session.commit()

    c = app.test_client()

    # Auth challenge/verify/refresh happy path
    hwid = "a" * 64
    client_ts = int(time.time() * 1000)
    ch = c.post("/v1/auth/challenge", json={"hwid_fp": hwid, "client_ts": client_ts})
    details["auth_challenge_status"] = ch.status_code
    _assert("auth_challenge_ok", ch.status_code == 200, details, failures)
    chj = ch.get_json() or {}

    msg = f"verify:{chj.get('challenge_id')}:{chj.get('challenge_nonce')}:{hwid}:{client_ts}"
    sig = hmac.new("ABCDEFGHIJKLMNOPQRST".encode(), msg.encode(), hashlib.sha256).hexdigest()
    vr = c.post(
        "/v1/auth/verify",
        json={
            "challenge_id": chj.get("challenge_id"),
            "license_key": "ABCD-EFGH-IJKL-MNOP-QRST",
            "hwid_fp": hwid,
            "challenge_response": sig,
            "challenge_token": chj.get("challenge_token"),
            "client_ts": client_ts,
        },
    )
    details["auth_verify_status"] = vr.status_code
    _assert("auth_verify_ok", vr.status_code == 200 and bool((vr.get_json() or {}).get("ok")), details, failures)
    vj = vr.get_json() or {}

    rr = c.post("/v1/session/refresh", json={"session_token": vj.get("session_token"), "hwid_fp": hwid})
    details["auth_refresh_status"] = rr.status_code
    _assert("auth_refresh_ok", rr.status_code == 200 and bool((rr.get_json() or {}).get("ok")), details, failures)

    rr_bad = c.post("/v1/session/refresh", json={"session_token": vj.get("session_token"), "hwid_fp": "b" * 64})
    details["auth_refresh_wrong_hwid_status"] = rr_bad.status_code
    _assert("auth_refresh_wrong_hwid_rejected", rr_bad.status_code == 401, details, failures)

    # Bot API lifecycle (bearer)
    headers = {"Authorization": f"Bearer {bot_secret}"}
    cr = c.post("/api/bot/key-create", headers=headers, json={"access": "monthly", "note": "smoke", "discord_id": "1234"})
    details["bot_create_status"] = cr.status_code
    cj = cr.get_json() or {}
    key = cj.get("key")
    _assert("bot_create_ok", cr.status_code == 200 and bool(cj.get("ok")) and bool(key), details, failures)

    if key:
        details["bot_update_status"] = c.post("/api/bot/key-update", headers=headers, json={"key": key, "note": "updated"}).status_code
        details["bot_extend_status"] = c.post("/api/bot/key-extend", headers=headers, json={"key": key, "days": 5}).status_code
        details["bot_reset_status"] = c.post("/api/bot/key-reset-hwid", headers=headers, json={"key": key}).status_code
        details["bot_toggle_status"] = c.post("/api/bot/key-toggle", headers=headers, json={"key": key}).status_code
        details["bot_delete_status"] = c.post("/api/bot/key-delete", headers=headers, json={"key": key}).status_code
        _assert("bot_key_lifecycle_ok", all(details[k] == 200 for k in ("bot_update_status", "bot_extend_status", "bot_reset_status", "bot_toggle_status", "bot_delete_status")), details, failures)

    # Bot API signed-header compatibility
    path = "/api/bot/keys"
    ts = str(int(time.time() * 1000))
    canonical = "\n".join(["GET", path, ts, hashlib.sha256(b"").hexdigest()])
    signed = hmac.new(bot_secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()
    sr = c.get(path, headers={"x-bot-ts": ts, "x-bot-signature": signed})
    details["bot_signed_status"] = sr.status_code
    _assert("bot_signed_ok", sr.status_code == 200 and isinstance(sr.get_json(), list), details, failures)

    # Legacy DB import + recognition
    legacy_key = "ZXCV-BNM1-ASDF-GHJK-LQWE"
    legacy_norm = legacy_key.replace("-", "")
    legacy_hwid = "c" * 64
    legacy_ts = int(time.time() * 1000)
    pre_ch = c.post("/v1/auth/challenge", json={"hwid_fp": legacy_hwid, "client_ts": legacy_ts}).get_json() or {}
    pre_msg = f"verify:{pre_ch.get('challenge_id')}:{pre_ch.get('challenge_nonce')}:{legacy_hwid}:{legacy_ts}"
    pre_sig = hmac.new(legacy_norm.encode(), pre_msg.encode(), hashlib.sha256).hexdigest()
    pre_v = c.post(
        "/v1/auth/verify",
        json={
            "challenge_id": pre_ch.get("challenge_id"),
            "license_key": legacy_key,
            "hwid_fp": legacy_hwid,
            "challenge_response": pre_sig,
            "challenge_token": pre_ch.get("challenge_token"),
            "client_ts": legacy_ts,
        },
    )
    details["legacy_before_status"] = pre_v.status_code
    _assert("legacy_before_rejected", pre_v.status_code == 401, details, failures)

    legacy_db = temp_dir / "legacy_old.sqlite3"
    conn = sqlite3.connect(str(legacy_db))
    conn.execute("CREATE TABLE licenses (key TEXT, tier TEXT, is_revoked INTEGER, notes TEXT)")
    conn.execute(
        "INSERT INTO licenses(key, tier, is_revoked, notes) VALUES(?,?,?,?)",
        (legacy_key, "lifetime", 0, "imported"),
    )
    conn.commit()
    conn.close()

    migrate_legacy_keys.run(str(legacy_db), dry_run=False, replace_existing=False)

    post_ts = int(time.time() * 1000)
    post_ch = c.post("/v1/auth/challenge", json={"hwid_fp": legacy_hwid, "client_ts": post_ts}).get_json() or {}
    post_msg = f"verify:{post_ch.get('challenge_id')}:{post_ch.get('challenge_nonce')}:{legacy_hwid}:{post_ts}"
    post_sig = hmac.new(legacy_norm.encode(), post_msg.encode(), hashlib.sha256).hexdigest()
    post_v = c.post(
        "/v1/auth/verify",
        json={
            "challenge_id": post_ch.get("challenge_id"),
            "license_key": legacy_key,
            "hwid_fp": legacy_hwid,
            "challenge_response": post_sig,
            "challenge_token": post_ch.get("challenge_token"),
            "client_ts": post_ts,
        },
    )
    details["legacy_after_status"] = post_v.status_code
    _assert("legacy_after_accepted", post_v.status_code == 200 and bool((post_v.get_json() or {}).get("ok")), details, failures)

    print(json.dumps({"ok": not failures, "failures": failures, "details": details}, separators=(",", ":")))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
