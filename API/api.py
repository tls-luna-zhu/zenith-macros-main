#!/usr/bin/env python3
"""
Zenith Macros — single-file Flask API (JSON persistence).
Run: python api.py  → http://127.0.0.1:5000
"""
from __future__ import annotations

import base64
import datetime
import email.mime.multipart
import email.mime.text
import hashlib
import hmac
import json
import os
import re
import secrets
import smtplib
import string
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import requests
import stripe
from flask import Flask, jsonify, redirect, request, make_response

# Load API/.env into os.environ (Flask does not read .env by itself)
try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent / ".env")
except ImportError:
    pass

# ---------------------------------------------------------------------------
# Hardcoded defaults (override with environment variables)
# ---------------------------------------------------------------------------
API_HOST = os.environ.get("API_HOST", "127.0.0.1")
API_PORT = int(os.environ.get("API_PORT", "5000"))
SECRET_KEY = os.environ.get("SECRET_KEY", "dev-change-me-use-openssl-rand-hex-32")
BOT_API_TOKEN = os.environ.get("BOT_API_TOKEN", "dev-bot-token-change-me")
BOT_API_SECRET = os.environ.get("BOT_API_SECRET", "") or BOT_API_TOKEN
BOT_SIGNED_MAX_SKEW_MS = int(os.environ.get("BOT_SIGNED_MAX_SKEW_MS", "300000"))

DISCORD_CLIENT_ID = os.environ.get("DISCORD_CLIENT_ID", "")
DISCORD_CLIENT_SECRET = os.environ.get("DISCORD_CLIENT_SECRET", "")
DISCORD_REDIRECT_URI = os.environ.get("DISCORD_REDIRECT_URI", "http://127.0.0.1:5000/api/auth/discord/callback")

FRONTEND_ORIGIN = os.environ.get("FRONTEND_ORIGIN", "http://localhost:3000")

STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY", "")
STRIPE_PUBLISHABLE_KEY = os.environ.get("STRIPE_PUBLISHABLE_KEY", "")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
STRIPE_SECRET_KEY_MONTHLY = os.environ.get("STRIPE_SECRET_KEY_MONTHLY", "") or os.environ.get("STRIPE_MONTHLY_SECRET_KEY", "")
STRIPE_SECRET_KEY_LIFETIME = os.environ.get("STRIPE_SECRET_KEY_LIFETIME", "") or os.environ.get("STRIPE_LIFETIME_SECRET_KEY", "")
STRIPE_PUBLISHABLE_KEY_MONTHLY = os.environ.get("STRIPE_PUBLISHABLE_KEY_MONTHLY", "") or os.environ.get("STRIPE_MONTHLY_PUBLISHABLE_KEY", "")
STRIPE_PUBLISHABLE_KEY_LIFETIME = os.environ.get("STRIPE_PUBLISHABLE_KEY_LIFETIME", "") or os.environ.get("STRIPE_LIFETIME_PUBLISHABLE_KEY", "")
STRIPE_WEBHOOK_SECRET_MONTHLY = os.environ.get("STRIPE_WEBHOOK_SECRET_MONTHLY", "") or os.environ.get("STRIPE_MONTHLY_WEBHOOK_SECRET", "")
STRIPE_WEBHOOK_SECRET_LIFETIME = os.environ.get("STRIPE_WEBHOOK_SECRET_LIFETIME", "") or os.environ.get("STRIPE_LIFETIME_WEBHOOK_SECRET", "")

OWNER_DISCORD_ID = int(os.environ.get("OWNER_DISCORD_ID", "1292582729040396351"))
_raw_admins = os.environ.get("ADMIN_DISCORD_IDS", str(OWNER_DISCORD_ID))
ADMIN_DISCORD_IDS = {int(x.strip()) for x in _raw_admins.split(",") if x.strip().isdigit()}
ADMIN_DISCORD_IDS.add(OWNER_DISCORD_ID)

PRICE_MONTHLY_CENTS = 1000   # $10
PRICE_LIFETIME_CENTS = 2500  # $25
AUTH_CHALLENGE_TTL_SEC = int(os.environ.get("AUTH_CHALLENGE_TTL_SEC", "60"))
AUTH_SESSION_TTL_SEC = int(os.environ.get("AUTH_SESSION_TTL_SEC", "900"))

SMTP_HOST = os.environ.get("SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASS = os.environ.get("SMTP_PASS", "")
SMTP_FROM = os.environ.get("SMTP_FROM", f"Zenith Macros <{SMTP_USER}>") if SMTP_USER else ""

GITHUB_RELEASES_REPO = os.environ.get("GITHUB_RELEASES_REPO", "")
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")

# Simple in-memory cache for GitHub releases (avoids hitting rate limit on every page load)
_releases_cache: dict = {"data": None, "ts": 0}
_RELEASES_TTL = 300  # seconds (5 minutes)

DEFAULT_COMMISSION_PERCENT = 20
DEFAULT_BUYER_DISCOUNT_PERCENT = 0

CASHOUT_MIN_CENTS = 1500      # $15
CASHOUT_MAX_CENTS = 50000     # $500
CASHOUT_COOLDOWN_SEC = 5 * 3600

AFFILIATE_CODE_LEN = 10
AFFILIATE_CODE_RE = re.compile(r"^[a-z0-9]{4,32}$")

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"

_lock = threading.Lock()
_challenge_lock = threading.Lock()
_auth_challenges: dict[str, dict[str, Any]] = {}

stripe.api_key = STRIPE_SECRET_KEY or STRIPE_SECRET_KEY_MONTHLY or STRIPE_SECRET_KEY_LIFETIME or None

# ---------------------------------------------------------------------------
# JSON store
# ---------------------------------------------------------------------------

def _read(name: str, default: Any) -> Any:
    path = DATA / name
    if not path.exists():
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _write(name: str, obj: Any) -> None:
    path = DATA / name
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
    tmp.replace(path)


def load_json(name: str, default: Any) -> Any:
    with _lock:
        return _read(name, default)


def save_json(name: str, obj: Any) -> None:
    with _lock:
        _write(name, obj)


def audit(event: str, **kw: Any) -> None:
    row = {"ts": int(time.time()), "event": event, **kw}
    log = load_json("audit.json", [])
    log.append(row)
    save_json("audit.json", log[-5000:])


# ---------------------------------------------------------------------------
# Session (signed cookie)
# ---------------------------------------------------------------------------
SESSION_COOKIE = "zenith_session"
SESSION_MAX_AGE = 7 * 24 * 3600


def _sign(payload: str) -> str:
    return hmac.new(SECRET_KEY.encode(), payload.encode(), hashlib.sha256).hexdigest()


def make_session_token(discord_id: str, username: str) -> str:
    exp = int(time.time()) + SESSION_MAX_AGE
    obj = {"v": 1, "id": str(discord_id), "u": username, "exp": exp}
    raw = base64.urlsafe_b64encode(json.dumps(obj, separators=(",", ":")).encode()).decode().rstrip("=")
    return f"{raw}.{_sign(raw)}"


def read_session_token(token: str | None) -> dict | None:
    if not token or "." not in token:
        return None
    raw, sig = token.rsplit(".", 1)
    if not hmac.compare_digest(_sign(raw), sig):
        return None
    pad = "=" * ((4 - len(raw) % 4) % 4)
    try:
        obj = json.loads(base64.urlsafe_b64decode(raw + pad).decode())
    except Exception:
        return None
    if int(obj.get("exp", 0)) < int(time.time()):
        return None
    return obj


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _jwt_sign(msg: str) -> str:
    return hmac.new(SECRET_KEY.encode(), msg.encode(), hashlib.sha256).digest()


def _make_auth_jwt(payload: dict[str, Any]) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    h64 = _b64url(json.dumps(header, separators=(",", ":"), ensure_ascii=False).encode())
    p64 = _b64url(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode())
    sig = _b64url(_jwt_sign(f"{h64}.{p64}"))
    return f"{h64}.{p64}.{sig}"


def _read_auth_jwt(token: str | None) -> dict[str, Any] | None:
    if not token or token.count(".") != 2:
        return None
    h64, p64, s64 = token.split(".")
    expected = _b64url(_jwt_sign(f"{h64}.{p64}"))
    if not hmac.compare_digest(expected, s64):
        return None
    pad = "=" * ((4 - len(p64) % 4) % 4)
    try:
        payload = json.loads(base64.urlsafe_b64decode((p64 + pad).encode()).decode())
    except Exception:
        return None
    try:
        exp = int(payload.get("exp", 0))
    except Exception:
        return None
    if exp <= int(time.time()):
        return None
    return payload


def _normalize_license_key(value: str) -> str:
    return "".join(ch for ch in str(value).upper() if ch.isalnum())


def _normalize_plan(value: str) -> str:
    return "lifetime" if str(value).strip().lower() == "lifetime" else "monthly"


def _stripe_keys_for_plan(plan: str) -> tuple[str, str]:
    p = _normalize_plan(plan)
    if p == "lifetime":
        secret = STRIPE_SECRET_KEY_LIFETIME or STRIPE_SECRET_KEY
        pub = STRIPE_PUBLISHABLE_KEY_LIFETIME or STRIPE_PUBLISHABLE_KEY
    else:
        secret = STRIPE_SECRET_KEY_MONTHLY or STRIPE_SECRET_KEY
        pub = STRIPE_PUBLISHABLE_KEY_MONTHLY or STRIPE_PUBLISHABLE_KEY
    return secret, pub


def _all_stripe_secrets(plan_hint: str | None = None) -> list[str]:
    out: list[str] = []
    if plan_hint:
        hinted, _ = _stripe_keys_for_plan(plan_hint)
        if hinted:
            out.append(hinted)
    for key in (
        STRIPE_SECRET_KEY,
        STRIPE_SECRET_KEY_MONTHLY,
        STRIPE_SECRET_KEY_LIFETIME,
    ):
        if key and key not in out:
            out.append(key)
    return out


def _all_webhook_secrets() -> list[str]:
    out: list[str] = []
    for key in (
        STRIPE_WEBHOOK_SECRET,
        STRIPE_WEBHOOK_SECRET_MONTHLY,
        STRIPE_WEBHOOK_SECRET_LIFETIME,
    ):
        if key and key not in out:
            out.append(key)
    return out


def _find_license_for_auth(license_key: str) -> tuple[list[dict[str, Any]], int, dict[str, Any]] | tuple[None, None, None]:
    key_norm = _normalize_license_key(license_key)
    licenses = load_json("licenses.json", [])
    now = int(time.time())
    for idx, lic in enumerate(licenses):
        if _normalize_license_key(lic.get("key", "")) != key_norm:
            continue
        if str(lic.get("status", "active")).lower() != "active":
            continue
        expires_at = lic.get("expires_at")
        if expires_at is not None:
            try:
                if now > int(expires_at):
                    continue
            except Exception:
                continue
        return licenses, idx, lic
    return None, None, None


def _cleanup_challenges(now_ts: int | None = None) -> None:
    now = now_ts if now_ts is not None else int(time.time())
    stale = [cid for cid, c in _auth_challenges.items() if int(c.get("exp", 0)) <= now]
    for cid in stale:
        _auth_challenges.pop(cid, None)


def get_current_user() -> dict | None:
    tok = request.cookies.get(SESSION_COOKIE)
    data = read_session_token(tok)
    if not data:
        return None
    return {"discord_id": str(data["id"]), "username": str(data.get("u", ""))}


def require_user() -> dict:
    u = get_current_user()
    if not u:
        raise PermissionError("auth")
    return u


def require_bot() -> None:
    if BOT_API_SECRET:
        legacy = str(request.headers.get("x-bot-secret", ""))
        if legacy and hmac.compare_digest(legacy, BOT_API_SECRET):
            return

        ts_raw = str(request.headers.get("x-bot-ts", "")).strip()
        sig_raw = str(request.headers.get("x-bot-signature", "")).strip().lower()
        if re.fullmatch(r"\d{10,16}", ts_raw) and re.fullmatch(r"[a-f0-9]{64}", sig_raw):
            try:
                ts_val = int(ts_raw)
            except Exception:
                ts_val = 0
            now_ms = int(time.time() * 1000)
            if ts_val > 0 and abs(now_ms - ts_val) <= max(1000, BOT_SIGNED_MAX_SKEW_MS):
                body_text = request.get_data(as_text=True) or ""
                body_hash = hashlib.sha256(body_text.encode("utf-8")).hexdigest()
                canonical = "\n".join(
                    [
                        str(request.method or "GET").upper(),
                        str(request.path or "/"),
                        ts_raw,
                        body_hash,
                    ]
                )
                expected_sig = hmac.new(BOT_API_SECRET.encode(), canonical.encode(), hashlib.sha256).hexdigest()
                if hmac.compare_digest(sig_raw, expected_sig):
                    return

    auth = request.headers.get("Authorization", "")
    if auth != f"Bearer {BOT_API_TOKEN}":
        raise PermissionError("bot")


def _cors_allow_origin(o: str) -> bool:
    if not o:
        return False
    if o == FRONTEND_ORIGIN or o.rstrip("/") == FRONTEND_ORIGIN.rstrip("/"):
        return True
    # Dev: Next may be http://localhost:3000 or http://127.0.0.1:3000
    if o.startswith("http://localhost:") or o.startswith("http://127.0.0.1:"):
        return True
    return False


def cors(resp):
    o = request.headers.get("Origin") or ""
    if _cors_allow_origin(o):
        resp.headers["Access-Control-Allow-Origin"] = o
    else:
        resp.headers["Access-Control-Allow-Origin"] = FRONTEND_ORIGIN
    resp.headers["Access-Control-Allow-Credentials"] = "true"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    return resp


# ---------------------------------------------------------------------------
# Affiliates & coupons
# ---------------------------------------------------------------------------

def _normalize_code(s: str) -> str:
    return s.strip().lower()


def generate_affiliate_code() -> str:
    alphabet = string.ascii_lowercase + string.digits
    aff = load_json("affiliates.json", {"by_discord_id": {}, "by_code": {}})
    for _ in range(80):
        c = "".join(secrets.choice(alphabet) for _ in range(AFFILIATE_CODE_LEN))
        if c not in aff.get("by_code", {}):
            return c
    raise RuntimeError("Could not generate unique code")


def get_affiliate_by_code(code: str) -> dict | None:
    code = _normalize_code(code)
    aff = load_json("affiliates.json", {"by_discord_id": {}, "by_code": {}})
    did = aff.get("by_code", {}).get(code)
    if not did:
        return None
    row = aff["by_discord_id"].get(did)
    if not row:
        return None
    return {"discord_id": did, **row}


def get_affiliate_dashboard(discord_id: str) -> dict:
    aff_root = load_json("affiliates.json", {"by_discord_id": {}, "by_code": {}})
    row = aff_root["by_discord_id"].get(str(discord_id))
    if not row:
        return {"ok": False, "error": "no_affiliate"}

    code = row["code"]
    sales = load_json("referral_sales.json", [])
    mine = [s for s in sales if s.get("affiliate_discord_id") == str(discord_id)]
    payouts = load_json("affiliate_payouts.json", [])
    my_payouts = [p for p in payouts if p.get("affiliate_discord_id") == str(discord_id)]

    total_sales = len(mine)
    gross = sum(int(s.get("charged_cents", 0)) for s in mine)
    commission_earned = sum(int(s.get("commission_cents", 0)) for s in mine)

    pending_sum = sum(
        int(p.get("amount_cents", 0))
        for p in my_payouts
        if p.get("status") == "pending"
    )
    paid_sum = sum(
        int(p.get("amount_cents", 0))
        for p in my_payouts
        if p.get("status") == "paid"
    )
    available = max(0, commission_earned - paid_sum - pending_sum)

    referral_link_query = f"{FRONTEND_ORIGIN}/?rreferal={code}"
    referral_link_path = f"{FRONTEND_ORIGIN}/rreferal/{code}"

    chart = []
    for s in sorted(mine, key=lambda x: int(x.get("created_at", 0)))[-14:]:
        chart.append(
            {
                "day": time.strftime("%Y-%m-%d", time.gmtime(int(s.get("created_at", 0)))),
                "commission_cents": int(s.get("commission_cents", 0)),
                "charged_cents": int(s.get("charged_cents", 0)),
            }
        )

    return {
        "ok": True,
        "code": code,
        "commission_percent": int(row.get("commission_percent", DEFAULT_COMMISSION_PERCENT)),
        "buyer_discount_percent": int(row.get("buyer_discount_percent", DEFAULT_BUYER_DISCOUNT_PERCENT)),
        "referral_link_query": referral_link_query,
        "referral_link_path": referral_link_path,
        "total_sales": total_sales,
        "gross_revenue_cents": gross,
        "commission_earned_cents": commission_earned,
        "available_balance_cents": available,
        "pending_cashouts_cents": pending_sum,
        "recent_sales": mine[-20:][::-1],
        "recent_cashouts": my_payouts[-20:][::-1],
        "chart": chart,
    }


def get_coupon(code: str) -> dict | None:
    code = _normalize_code(code)
    coupons = load_json("coupons.json", {})
    c = coupons.get(code)
    if not c:
        return None
    return c


# ---------------------------------------------------------------------------
# Price calculation (single source of truth)
# ---------------------------------------------------------------------------

def compute_checkout_amounts(
    plan: str,
    buyer_discord_id: str | None,
    referral_code: str | None,
    coupon_code: str | None,
) -> dict[str, Any]:
    base = PRICE_MONTHLY_CENTS if plan == "monthly" else PRICE_LIFETIME_CENTS
    if plan not in ("monthly", "lifetime"):
        raise ValueError("bad_plan")

    coupon_discount_cents = 0
    buyer_discount_cents = 0
    affiliate_discord_id: str | None = None
    commission_percent = DEFAULT_COMMISSION_PERCENT
    buyer_discount_percent = DEFAULT_BUYER_DISCOUNT_PERCENT

    coupon_message: str | None = None
    referral_message: str | None = None
    coupon_valid = True
    referral_valid = True

    # Coupon
    if coupon_code:
        raw = _normalize_code(coupon_code)
        c = get_coupon(raw)
        if not c or not c.get("active", True):
            coupon_valid = False
            coupon_message = "Invalid coupon."
        else:
            pct = int(c.get("discount_percent", 0))
            coupon_discount_cents = int(base * pct / 100)

    after_coupon = max(0, base - coupon_discount_cents)

    # Referral
    if referral_code:
        rc = referral_code.strip()
        if not AFFILIATE_CODE_RE.match(_normalize_code(rc)):
            referral_valid = False
            referral_message = "Invalid referral code."
        else:
            aff = get_affiliate_by_code(rc)
            if not aff:
                referral_valid = False
                referral_message = "Referral code not found."
            elif str(aff["discord_id"]) == str(buyer_discord_id or ""):
                referral_valid = False
                referral_message = "You cannot use your own referral code."
            else:
                buyer_discount_percent = int(aff.get("buyer_discount_percent", 0))
                commission_percent = int(aff.get("commission_percent", DEFAULT_COMMISSION_PERCENT))
                affiliate_discord_id = str(aff["discord_id"])
                buyer_discount_cents = int(after_coupon * buyer_discount_percent / 100)

    final_cents = max(50, after_coupon - buyer_discount_cents)

    commission_cents = 0
    if affiliate_discord_id and referral_valid:
        commission_cents = int(final_cents * commission_percent / 100)

    return {
        "base_cents": base,
        "plan": plan,
        "coupon_discount_cents": coupon_discount_cents,
        "buyer_discount_cents": buyer_discount_cents,
        "final_cents": final_cents,
        "commission_cents": commission_cents,
        "affiliate_discord_id": affiliate_discord_id,
        "commission_percent": commission_percent,
        "coupon_valid": coupon_valid,
        "coupon_message": coupon_message,
        "referral_valid": referral_valid,
        "referral_message": referral_message,
    }


def send_key_email(to_email: str, username: str, key: str, plan: str, expires_ts: int | None) -> None:
    """Send a purchase confirmation email containing the license key. No-op if SMTP is not configured."""
    if not SMTP_HOST or not SMTP_USER or not SMTP_PASS or not to_email:
        return
    try:
        plan_label = "Lifetime" if plan == "lifetime" else "Monthly"
        expiry_line = (
            "Your access never expires — this is a one-time purchase."
            if plan == "lifetime"
            else (
                f"Your plan renews monthly. Your current period ends on "
                f"{datetime.datetime.utcfromtimestamp(expires_ts).strftime('%B %d, %Y')} UTC."
                if expires_ts else "Your plan renews monthly."
            )
        )
        html = f"""<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#04040a;font-family:'Segoe UI',Arial,sans-serif;color:#f1f0fa">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 20px">
<table width="520" cellpadding="0" cellspacing="0" style="background:#101018;border:1px solid #1c1c2a;border-radius:16px;overflow:hidden">
  <tr><td style="background:linear-gradient(135deg,#3b1f6e,#1a0a35);padding:36px 40px;text-align:center">
    <div style="font-size:32px;font-weight:800;letter-spacing:-.04em;color:#fff">Zenith Macros</div>
    <div style="font-size:14px;color:rgba(255,255,255,.6);margin-top:6px">Purchase Confirmation</div>
  </td></tr>
  <tr><td style="padding:36px 40px">
    <p style="color:#9898b2;font-size:14px;margin:0 0 24px">Hi <strong style="color:#f1f0fa">{username}</strong>, thank you for your purchase.</p>
    <div style="background:#0c0c14;border:1px solid #272738;border-radius:12px;padding:24px;margin-bottom:24px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#5a5a72;margin-bottom:10px">Your License Key</div>
      <div style="font-size:17px;font-weight:700;letter-spacing:.06em;color:#c4b5fd;font-family:monospace;word-break:break-all">{key}</div>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
      <tr>
        <td style="background:#0c0c14;border:1px solid #1c1c2a;border-radius:8px;padding:14px 18px;width:48%">
          <div style="font-size:11px;color:#5a5a72;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Plan</div>
          <div style="font-size:15px;font-weight:700;color:#a855f7">{plan_label}</div>
        </td>
        <td width="4%"></td>
        <td style="background:#0c0c14;border:1px solid #1c1c2a;border-radius:8px;padding:14px 18px;width:48%">
          <div style="font-size:11px;color:#5a5a72;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Status</div>
          <div style="font-size:15px;font-weight:700;color:#57db95">Active</div>
        </td>
      </tr>
    </table>
    <p style="color:#9898b2;font-size:13px;margin:0 0 8px">{expiry_line}</p>
    <p style="color:#9898b2;font-size:13px;margin:0 0 24px">Log in to your dashboard at any time to view your key, check your HWID status, and manage your account.</p>
    <div style="text-align:center;margin-top:8px">
      <a href="https://zenithmacros.com/dashboard.html" style="display:inline-block;background:#7c3aed;color:#fff;font-weight:700;font-size:14px;padding:13px 32px;border-radius:10px;text-decoration:none;letter-spacing:.01em">Open Dashboard</a>
    </div>
  </td></tr>
  <tr><td style="padding:20px 40px;border-top:1px solid #1c1c2a;text-align:center">
    <p style="color:#5a5a72;font-size:12px;margin:0">If you need help, open a ticket in our Discord. Keep this email as proof of purchase.</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>"""
        msg = email.mime.multipart.MIMEMultipart("alternative")
        msg["Subject"] = f"Your Zenith Macros {plan_label} License Key"
        msg["From"] = SMTP_FROM
        msg["To"] = to_email
        msg.attach(email.mime.text.MIMEText(f"Your Zenith Macros {plan_label} key: {key}", "plain"))
        msg.attach(email.mime.text.MIMEText(html, "html"))
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as s:
            s.ehlo()
            s.starttls()
            s.login(SMTP_USER, SMTP_PASS)
            s.sendmail(SMTP_FROM, [to_email], msg.as_string())
        print(f"[zenith-api] Key email sent → {to_email}")
    except Exception as exc:
        print(f"[zenith-api] Email failed ({to_email}): {exc}")


def fulfill_payment(
    stripe_ref: str,
    buyer_discord_id: str,
    plan: str,
    charged_cents: int,
    affiliate_discord_id: str | None,
    commission_cents: int,
    coupon_code: str | None,
) -> None:
    fulfilled = load_json("fulfilled_payments.json", [])
    if any(x.get("ref") == stripe_ref for x in fulfilled):
        return

    key = f"ZNT-{secrets.token_hex(4).upper()}-{secrets.token_hex(2).upper()}-{secrets.token_hex(2).upper()}"
    now = int(time.time())
    expires_at = (now + 30 * 24 * 3600) if plan == "monthly" else None
    licenses = load_json("licenses.json", [])
    licenses.append(
        {
            "key": key,
            "discord_id": str(buyer_discord_id),
            "plan": plan,
            "status": "active",
            "hwid": "",
            "created_at": now,
            "expires_at": expires_at,
            "payment_ref": stripe_ref,
        }
    )
    save_json("licenses.json", licenses)

    if affiliate_discord_id and commission_cents > 0:
        sales = load_json("referral_sales.json", [])
        sales.append(
            {
                "id": str(uuid.uuid4()),
                "affiliate_discord_id": str(affiliate_discord_id),
                "buyer_discord_id": str(buyer_discord_id),
                "plan": plan,
                "charged_cents": charged_cents,
                "commission_cents": commission_cents,
                "coupon_code": coupon_code,
                "stripe_ref": stripe_ref,
                "created_at": int(time.time()),
            }
        )
        save_json("referral_sales.json", sales)

    fulfilled.append({"ref": stripe_ref, "at": int(time.time())})
    save_json("fulfilled_payments.json", fulfilled)
    audit("payment.fulfilled", ref=stripe_ref, buyer=buyer_discord_id, plan=plan)

    # Send key delivery email if SMTP is configured
    users = load_json("users.json", {})
    buyer_row = users.get(str(buyer_discord_id), {})
    buyer_email = buyer_row.get("email", "")
    buyer_name = buyer_row.get("global_name") or buyer_row.get("username") or "there"
    if buyer_email:
        threading.Thread(
            target=send_key_email,
            args=(buyer_email, buyer_name, key, plan, expires_at),
            daemon=True,
        ).start()


# ---------------------------------------------------------------------------
# Flask
# ---------------------------------------------------------------------------
app = Flask(__name__)


@app.after_request
def _cors(resp):
    return cors(resp)


@app.route("/api/<path:_any>", methods=["OPTIONS"])
def _opts(_any):
    return cors(make_response("", 204))


@app.get("/health")
def health():
    return jsonify({"ok": True})


@app.get("/")
def root():
    """No HTML at API root — Zenith site runs on Next.js (FRONTEND_ORIGIN)."""
    return redirect(FRONTEND_ORIGIN, code=302)


# --- Auth: Discord OAuth ---------------------------------------------------

@app.get("/api/auth/discord/start")
def discord_start():
    if not DISCORD_CLIENT_ID:
        return jsonify({"ok": False, "error": "Discord OAuth not configured"}), 501
    state = secrets.token_hex(16)
    # store state in cookie short-lived
    params = {
        "client_id": DISCORD_CLIENT_ID,
        "response_type": "code",
        "redirect_uri": DISCORD_REDIRECT_URI,
        "scope": "identify email",
        "state": state,
    }
    from urllib.parse import urlencode

    url = "https://discord.com/api/oauth2/authorize?" + urlencode(params)
    resp = redirect(url)
    resp.set_cookie("oauth_state", state, max_age=600, httponly=True, samesite="Lax", path="/")
    return resp


@app.get("/api/auth/discord/callback")
def discord_callback():
    err = request.args.get("error")
    if err:
        return redirect(f"{FRONTEND_ORIGIN}/dashboard.html?error=oauth")
    if request.args.get("state") != request.cookies.get("oauth_state"):
        return redirect(f"{FRONTEND_ORIGIN}/dashboard.html?error=state")
    code = request.args.get("code")
    if not code:
        return redirect(f"{FRONTEND_ORIGIN}/dashboard.html?error=code")

    data = {
        "client_id": DISCORD_CLIENT_ID,
        "client_secret": DISCORD_CLIENT_SECRET,
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": DISCORD_REDIRECT_URI,
    }
    r = requests.post("https://discord.com/api/oauth2/token", data=data, timeout=30)
    if r.status_code != 200:
        return redirect(f"{FRONTEND_ORIGIN}/dashboard.html?error=token")
    tok = r.json()
    at = tok.get("access_token")
    u = requests.get(
        "https://discord.com/api/users/@me",
        headers={"Authorization": f"Bearer {at}"},
        timeout=30,
    )
    if u.status_code != 200:
        return redirect(f"{FRONTEND_ORIGIN}/dashboard.html?error=user")
    du = u.json()
    did = str(du["id"])
    username = str(du.get("username", "user"))
    global_name = str(du.get("global_name") or username)
    email = str(du.get("email", ""))

    # Build Discord avatar URL
    avatar_hash = du.get("avatar", "")
    if avatar_hash:
        ext = "gif" if avatar_hash.startswith("a_") else "webp"
        avatar_url = f"https://cdn.discordapp.com/avatars/{did}/{avatar_hash}.{ext}?size=256"
    else:
        default_index = (int(did) >> 22) % 6
        avatar_url = f"https://cdn.discordapp.com/embed/avatars/{default_index}.png"

    users = load_json("users.json", {})
    users[did] = {
        "username": username,
        "global_name": global_name,
        "avatar_url": avatar_url,
        "email": email,
        "discord_id": did,
        "updated_at": int(time.time()),
    }
    save_json("users.json", users)

    # Auto-link any unlinked legacy licenses whose legacy_email matches this Discord email
    if email:
        licenses = load_json("licenses.json", [])
        email_lower = email.lower().strip()
        linked_count = 0
        for lic in licenses:
            if lic.get("discord_id") is None and (lic.get("legacy_email") or "").lower().strip() == email_lower:
                lic["discord_id"] = did
                lic["auto_linked_at"] = int(time.time())
                linked_count += 1
        if linked_count:
            save_json("licenses.json", licenses)
            audit("license.auto_linked", discord_id=did, count=linked_count, email=email)

    token = make_session_token(did, username)
    resp = redirect(f"{FRONTEND_ORIGIN}/dashboard.html?auth=ok")
    resp.set_cookie(SESSION_COOKIE, token, max_age=SESSION_MAX_AGE, httponly=True, samesite="Lax", path="/")
    resp.delete_cookie("oauth_state", path="/")
    return resp


@app.post("/api/auth/logout")
def logout():
    resp = jsonify({"ok": True})
    resp.delete_cookie(SESSION_COOKIE, path="/")
    return resp


@app.get("/api/auth/me")
def me():
    u = get_current_user()
    if not u:
        return jsonify({"ok": False, "user": None})
    return jsonify({"ok": True, "user": u})


# --- Client auth (Tauri/Electron): /v1/auth/* ------------------------------

@app.post("/v1/auth/challenge")
def v1_auth_challenge():
    body = request.get_json(silent=True) or {}
    hwid_fp = str(body.get("hwid_fp", "")).strip().lower()
    try:
        client_ts = int(body.get("client_ts", 0))
    except Exception:
        client_ts = 0

    now_ms = int(time.time() * 1000)
    if not re.fullmatch(r"[0-9a-f]{64}", hwid_fp):
        return jsonify({"ok": False, "error": "Authentication failed"}), 401
    if client_ts <= 0 or abs(now_ms - client_ts) > 10 * 60 * 1000:
        return jsonify({"ok": False, "error": "Authentication failed"}), 401

    challenge_id = str(uuid.uuid4())
    challenge_nonce = secrets.token_hex(16)
    exp = int(time.time()) + max(10, AUTH_CHALLENGE_TTL_SEC)
    token_raw = f"{challenge_id}:{challenge_nonce}:{hwid_fp}:{exp}"
    token_sig = hmac.new(SECRET_KEY.encode(), token_raw.encode(), hashlib.sha256).hexdigest()
    challenge_token = f"{exp}.{token_sig}"

    with _challenge_lock:
        _cleanup_challenges()
        _auth_challenges[challenge_id] = {
            "nonce": challenge_nonce,
            "hwid_fp": hwid_fp,
            "exp": exp,
        }

    return jsonify(
        {
            "challenge_id": challenge_id,
            "challenge_nonce": challenge_nonce,
            "challenge_token": challenge_token,
        }
    )


@app.post("/v1/auth/verify")
def v1_auth_verify():
    body = request.get_json(silent=True) or {}
    challenge_id = str(body.get("challenge_id", "")).strip()
    license_key = str(body.get("license_key", "")).strip()
    hwid_fp = str(body.get("hwid_fp", "")).strip().lower()
    challenge_response = str(body.get("challenge_response", "")).strip().lower()
    challenge_token = str(body.get("challenge_token", "")).strip()
    try:
        client_ts = int(body.get("client_ts", 0))
    except Exception:
        client_ts = 0

    if (
        not challenge_id
        or not license_key
        or not re.fullmatch(r"[0-9a-f]{64}", hwid_fp)
        or not re.fullmatch(r"[0-9a-f]{64}", challenge_response)
        or not challenge_token
        or client_ts <= 0
    ):
        return jsonify({"ok": False, "error": "Authentication failed"}), 401

    with _challenge_lock:
        _cleanup_challenges()
        chall = _auth_challenges.pop(challenge_id, None)

    if not chall:
        return jsonify({"ok": False, "error": "Authentication failed"}), 401
    if chall.get("hwid_fp") != hwid_fp or int(chall.get("exp", 0)) <= int(time.time()):
        return jsonify({"ok": False, "error": "Authentication failed"}), 401

    try:
        tok_exp_str, tok_sig = challenge_token.split(".", 1)
        tok_exp = int(tok_exp_str)
    except Exception:
        return jsonify({"ok": False, "error": "Authentication failed"}), 401

    token_raw = f"{challenge_id}:{chall['nonce']}:{hwid_fp}:{tok_exp}"
    expected_token_sig = hmac.new(SECRET_KEY.encode(), token_raw.encode(), hashlib.sha256).hexdigest()
    if tok_exp < int(time.time()) or not hmac.compare_digest(expected_token_sig, tok_sig):
        return jsonify({"ok": False, "error": "Authentication failed"}), 401

    norm_key = _normalize_license_key(license_key)
    msg = f"verify:{challenge_id}:{chall['nonce']}:{hwid_fp}:{client_ts}"
    expected_response = hmac.new(norm_key.encode(), msg.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected_response, challenge_response):
        return jsonify({"ok": False, "error": "Authentication failed"}), 401

    licenses, idx, row = _find_license_for_auth(norm_key)
    if row is None:
        return jsonify({"ok": False, "error": "Authentication failed"}), 401

    bound_hwid = str(row.get("hwid", "")).strip().lower()
    if bound_hwid and bound_hwid != hwid_fp:
        return jsonify({"ok": False, "error": "Authentication failed"}), 401
    if not bound_hwid:
        row["hwid"] = hwid_fp
        licenses[idx] = row
        save_json("licenses.json", licenses)

    exp = int(time.time()) + max(120, AUTH_SESSION_TTL_SEC)
    payload = {
        "v": 1,
        "sub": norm_key,
        "key": norm_key,
        "tier": str(row.get("plan", "monthly")),
        "hwid_fp": hwid_fp,
        "did": str(row.get("discord_id") or ""),
        "exp": exp,
        "iat": int(time.time()),
        "jti": uuid.uuid4().hex,
    }
    token = _make_auth_jwt(payload)
    expires_iso = datetime.datetime.utcfromtimestamp(exp).isoformat() + "Z"
    return jsonify({"ok": True, "session_token": token, "tier": payload["tier"], "expires_at": expires_iso})


@app.post("/v1/session/refresh")
def v1_session_refresh():
    body = request.get_json(silent=True) or {}
    session_token = str(body.get("session_token", "")).strip()
    hwid_fp = str(body.get("hwid_fp", "")).strip().lower()
    if not session_token or not re.fullmatch(r"[0-9a-f]{64}", hwid_fp):
        return jsonify({"ok": False, "error": "Authentication failed"}), 401

    payload = _read_auth_jwt(session_token)
    if not payload:
        return jsonify({"ok": False, "error": "Authentication failed"}), 401
    if str(payload.get("hwid_fp", "")).lower() != hwid_fp:
        return jsonify({"ok": False, "error": "Authentication failed"}), 401

    norm_key = _normalize_license_key(payload.get("key", ""))
    licenses, idx, row = _find_license_for_auth(norm_key)
    if row is None:
        return jsonify({"ok": False, "error": "Authentication failed"}), 401
    if str(row.get("hwid", "")).strip().lower() not in ("", hwid_fp):
        return jsonify({"ok": False, "error": "Authentication failed"}), 401
    if not str(row.get("hwid", "")).strip():
        row["hwid"] = hwid_fp
        licenses[idx] = row
        save_json("licenses.json", licenses)

    exp = int(time.time()) + max(120, AUTH_SESSION_TTL_SEC)
    new_payload = {
        "v": 1,
        "sub": norm_key,
        "key": norm_key,
        "tier": str(row.get("plan", payload.get("tier", "monthly"))),
        "hwid_fp": hwid_fp,
        "did": str(row.get("discord_id") or payload.get("did") or ""),
        "exp": exp,
        "iat": int(time.time()),
        "jti": uuid.uuid4().hex,
    }
    token = _make_auth_jwt(new_payload)
    return jsonify({"ok": True, "session_token": token, "tier": new_payload["tier"]})


# --- Affiliate (user) ------------------------------------------------------

@app.post("/api/affiliate/create")
def affiliate_create():
    try:
        u = require_user()
    except PermissionError:
        return jsonify({"ok": False, "error": "unauthorized"}), 401
    aff = load_json("affiliates.json", {"by_discord_id": {}, "by_code": {}})
    if str(u["discord_id"]) in aff["by_discord_id"]:
        return jsonify({"ok": False, "error": "already_exists"}), 400
    code = generate_affiliate_code()
    aff["by_discord_id"][str(u["discord_id"])] = {
        "code": code,
        "commission_percent": DEFAULT_COMMISSION_PERCENT,
        "buyer_discount_percent": DEFAULT_BUYER_DISCOUNT_PERCENT,
        "created_at": int(time.time()),
    }
    aff["by_code"][code] = str(u["discord_id"])
    save_json("affiliates.json", aff)
    audit("affiliate.created", discord_id=u["discord_id"], code=code)
    return jsonify({"ok": True, "code": code})


@app.get("/api/affiliate/me")
def affiliate_me():
    try:
        u = require_user()
    except PermissionError:
        return jsonify({"ok": False, "error": "unauthorized"}), 401
    dash = get_affiliate_dashboard(str(u["discord_id"]))
    return jsonify(dash)


@app.post("/api/affiliate/cashout")
def affiliate_cashout():
    try:
        u = require_user()
    except PermissionError:
        return jsonify({"ok": False, "error": "unauthorized"}), 401
    body = request.get_json(silent=True) or {}
    try:
        amount = int(body.get("amount_cents", 0))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "bad_amount"}), 400
    if amount < CASHOUT_MIN_CENTS or amount > CASHOUT_MAX_CENTS:
        return jsonify({"ok": False, "error": "amount_range"}), 400

    dash = get_affiliate_dashboard(str(u["discord_id"]))
    if not dash.get("ok"):
        return jsonify({"ok": False, "error": "no_affiliate"}), 400
    if amount > int(dash["available_balance_cents"]):
        return jsonify({"ok": False, "error": "insufficient"}), 400

    payouts = load_json("affiliate_payouts.json", [])
    now = int(time.time())
    mine = [p for p in payouts if p.get("affiliate_discord_id") == str(u["discord_id"])]
    if mine:
        mine.sort(key=lambda x: int(x.get("requested_at", 0)), reverse=True)
        last_at = int(mine[0].get("requested_at", 0))
        if now - last_at < CASHOUT_COOLDOWN_SEC:
            return jsonify({"ok": False, "error": "cooldown"}), 429

    pid = str(uuid.uuid4())
    payouts.append(
        {
            "id": pid,
            "affiliate_discord_id": str(u["discord_id"]),
            "amount_cents": amount,
            "status": "pending",
            "requested_at": now,
        }
    )
    save_json("affiliate_payouts.json", payouts)
    audit("affiliate.cashout_request", discord_id=u["discord_id"], amount_cents=amount, id=pid)
    return jsonify(
        {
            "ok": True,
            "message": "Cashout request received. Open a Discord support ticket to complete payout.",
            "payout_id": pid,
        }
    )


@app.get("/api/affiliate/lookup")
def affiliate_lookup():
    code = request.args.get("code", "")
    aff = get_affiliate_by_code(code) if code else None
    if not aff:
        return jsonify({"ok": False, "valid": False})
    return jsonify(
        {
            "ok": True,
            "valid": True,
            "code": aff["code"],
            "buyer_discount_percent": int(aff.get("buyer_discount_percent", 0)),
        }
    )


# --- Checkout --------------------------------------------------------------

@app.get("/api/releases")
def get_releases():
    """
    Returns the latest GitHub releases for the configured repo.
    Cached for 5 minutes to stay well within GitHub API rate limits.
    Accessible to any logged-in user.
    """
    u = get_current_user()
    if not u:
        return jsonify({"ok": False, "error": "unauthorized"}), 401

    if not GITHUB_RELEASES_REPO:
        return jsonify({"ok": True, "releases": [], "note": "no_repo_configured"})

    now = time.time()
    if _releases_cache["data"] is not None and (now - _releases_cache["ts"]) < _RELEASES_TTL:
        return jsonify({"ok": True, "releases": _releases_cache["data"], "cached": True})

    try:
        gh_url = f"https://api.github.com/repos/{GITHUB_RELEASES_REPO}/releases?per_page=10"
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if GITHUB_TOKEN:
            headers["Authorization"] = f"Bearer {GITHUB_TOKEN}"
        r = requests.get(gh_url, headers=headers, timeout=15)
        if r.status_code == 404:
            return jsonify({"ok": False, "error": "repo_not_found"}), 404
        if r.status_code != 200:
            return jsonify({"ok": False, "error": f"github_{r.status_code}"}), 502
        raw = r.json()

        releases = []
        for rel in raw:
            assets = []
            for asset in rel.get("assets", []):
                assets.append({
                    "name": asset["name"],
                    "url": asset["browser_download_url"],
                    "size": asset["size"],
                    "download_count": asset["download_count"],
                    "content_type": asset.get("content_type", ""),
                })
            releases.append({
                "id": rel["id"],
                "tag": rel["tag_name"],
                "name": rel["name"] or rel["tag_name"],
                "body": (rel.get("body") or "").strip(),
                "published_at": rel["published_at"],
                "prerelease": rel.get("prerelease", False),
                "draft": rel.get("draft", False),
                "assets": assets,
                "html_url": rel["html_url"],
            })

        _releases_cache["data"] = releases
        _releases_cache["ts"] = now
        return jsonify({"ok": True, "releases": releases, "cached": False})
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 502


@app.post("/api/checkout/preview")
def checkout_preview():
    u = get_current_user()
    body = request.get_json(silent=True) or {}
    plan = str(body.get("plan", "monthly"))
    ref = body.get("referral_code") or body.get("rreferal")
    coup = body.get("coupon_code")
    try:
        calc = compute_checkout_amounts(plan, u["discord_id"] if u else None, ref, coup)
    except ValueError:
        return jsonify({"ok": False, "error": "bad_plan"}), 400
    return jsonify({"ok": True, **calc})


@app.post("/api/checkout/payment-intent")
def checkout_pi():
    try:
        u = require_user()
    except PermissionError:
        return jsonify({"ok": False, "error": "unauthorized"}), 401

    body = request.get_json(silent=True) or {}
    plan = _normalize_plan(str(body.get("plan", "monthly")))
    ref = body.get("referral_code") or body.get("rreferal")
    coup = body.get("coupon_code")
    stripe_secret, stripe_publishable = _stripe_keys_for_plan(plan)
    if not stripe_secret:
        return jsonify({"ok": False, "error": "stripe_not_configured"}), 501

    try:
        calc = compute_checkout_amounts(plan, u["discord_id"], ref, coup)
    except ValueError:
        return jsonify({"ok": False, "error": "bad_plan"}), 400

    intent = stripe.PaymentIntent.create(
        amount=calc["final_cents"],
        currency="usd",
        automatic_payment_methods={"enabled": True},
        metadata={
            "plan": plan,
            "buyer_discord_id": str(u["discord_id"]),
            "referral_code": _normalize_code(ref) if ref and calc["referral_valid"] else "",
            "coupon_code": _normalize_code(coup) if coup and calc["coupon_valid"] else "",
            "affiliate_discord_id": calc["affiliate_discord_id"] or "",
            "commission_cents": str(calc["commission_cents"]),
            "charged_preview_cents": str(calc["final_cents"]),
        },
        api_key=stripe_secret,
    )

    return jsonify(
        {
            "ok": True,
            "client_secret": intent.client_secret,
            "publishable_key": stripe_publishable,
            "amount_cents": calc["final_cents"],
            "preview": calc,
        }
    )


@app.post("/api/checkout/hosted-session")
def hosted_session():
    try:
        u = require_user()
    except PermissionError:
        return jsonify({"ok": False, "error": "unauthorized"}), 401
    body = request.get_json(silent=True) or {}
    plan = _normalize_plan(str(body.get("plan", "monthly")))
    ref = body.get("referral_code") or body.get("rreferal")
    coup = body.get("coupon_code")
    stripe_secret, _ = _stripe_keys_for_plan(plan)
    if not stripe_secret:
        return jsonify({"ok": False, "error": "stripe_not_configured"}), 501
    try:
        calc = compute_checkout_amounts(plan, u["discord_id"], ref, coup)
    except ValueError:
        return jsonify({"ok": False, "error": "bad_plan"}), 400

    session = stripe.checkout.Session.create(
        mode="payment",
        line_items=[
            {
                "price_data": {
                    "currency": "usd",
                    "unit_amount": calc["final_cents"],
                    "product_data": {
                        "name": f"Zenith Macros — {plan}",
                    },
                },
                "quantity": 1,
            }
        ],
        success_url=f"{FRONTEND_ORIGIN}/checkout/success?session_id={{CHECKOUT_SESSION_ID}}",
        cancel_url=f"{FRONTEND_ORIGIN}/checkout?plan={plan}",
        metadata={
            "plan": plan,
            "buyer_discord_id": str(u["discord_id"]),
            "referral_code": _normalize_code(ref) if ref and calc["referral_valid"] else "",
            "coupon_code": _normalize_code(coup) if coup and calc["coupon_valid"] else "",
            "affiliate_discord_id": calc["affiliate_discord_id"] or "",
            "commission_cents": str(calc["commission_cents"]),
        },
        api_key=stripe_secret,
    )
    return jsonify({"ok": True, "url": session.url, "preview": calc})


@app.get("/api/checkout/verify-session")
def verify_session():
    secrets = _all_stripe_secrets()
    if not secrets:
        return jsonify({"ok": False}), 501
    try:
        u = require_user()
    except PermissionError:
        return jsonify({"ok": False, "error": "unauthorized"}), 401
    sid = request.args.get("session_id", "")
    if not sid:
        return jsonify({"ok": False, "error": "missing"}), 400
    sess = None
    for secret in secrets:
        try:
            sess = stripe.checkout.Session.retrieve(sid, expand=["payment_intent"], api_key=secret)
            break
        except Exception:
            continue
    if sess is None:
        return jsonify({"ok": False, "error": "session_lookup_failed"}), 404
    if sess.payment_status != "paid":
        return jsonify({"ok": False, "status": sess.payment_status})
    meta = dict(sess.metadata or {})
    if str(meta.get("buyer_discord_id")) != str(u["discord_id"]):
        return jsonify({"ok": False, "error": "user_mismatch"}), 403
    pi = sess.payment_intent
    if hasattr(pi, "id"):
        ref = str(pi.id)
    elif isinstance(pi, str):
        ref = pi
    else:
        ref = str(sid)
    fulfill_from_meta(ref, meta, int(sess.amount_total or 0))
    return jsonify({"ok": True})


def fulfill_from_meta(stripe_ref: str, meta: dict, charged_cents: int) -> None:
    buyer = str(meta.get("buyer_discord_id", ""))
    plan = str(meta.get("plan", "monthly"))
    aff = meta.get("affiliate_discord_id") or None
    try:
        comm = int(meta.get("commission_cents", 0))
    except (TypeError, ValueError):
        comm = 0
    coup = meta.get("coupon_code") or None
    if not buyer:
        return
    fulfill_payment(stripe_ref, buyer, plan, charged_cents, aff, comm, coup)


@app.post("/api/stripe/webhook")
def stripe_webhook():
    webhook_secrets = _all_webhook_secrets()
    if not webhook_secrets:
        return jsonify({"ok": False}), 501
    payload = request.get_data(as_text=True)
    sig = request.headers.get("Stripe-Signature", "")
    event = None
    for hook_secret in webhook_secrets:
        try:
            event = stripe.Webhook.construct_event(payload, sig, hook_secret)
            break
        except Exception:
            continue
    if event is None:
        return jsonify({"ok": False}), 400

    et = event["type"]
    obj = event["data"]["object"]

    if et == "payment_intent.succeeded":
        pid = obj.get("id")
        meta = obj.get("metadata") or {}
        buyer = str(meta.get("buyer_discord_id", ""))
        plan = str(meta.get("plan", "monthly"))
        aff = meta.get("affiliate_discord_id") or None
        try:
            comm = int(meta.get("commission_cents", 0))
        except (TypeError, ValueError):
            comm = 0
        amt = int(obj.get("amount_received") or obj.get("amount") or 0)
        coup = meta.get("coupon_code") or None
        if buyer and pid:
            fulfill_payment(pid, buyer, plan, amt, aff if aff else None, comm, coup)

    if et == "checkout.session.completed":
        meta = dict(obj.get("metadata") or {})
        pi = obj.get("payment_intent")
        ref = str(pi or obj.get("id") or "")
        fulfill_from_meta(ref, meta, int(obj.get("amount_total") or 0))

    return jsonify({"ok": True})


# --- Internal (bot) ----------------------------------------------------------

@app.post("/api/internal/affiliate/create")
def internal_affiliate_create():
    try:
        require_bot()
    except PermissionError:
        return jsonify({"ok": False}), 403
    body = request.get_json(silent=True) or {}
    did = str(body.get("discord_id", ""))
    username = str(body.get("username", "user"))
    if not did.isdigit():
        return jsonify({"ok": False, "error": "bad_id"}), 400
    aff = load_json("affiliates.json", {"by_discord_id": {}, "by_code": {}})
    if did in aff["by_discord_id"]:
        return jsonify({"ok": False, "error": "exists"}), 400
    code = generate_affiliate_code()
    aff["by_discord_id"][did] = {
        "code": code,
        "commission_percent": DEFAULT_COMMISSION_PERCENT,
        "buyer_discount_percent": DEFAULT_BUYER_DISCOUNT_PERCENT,
        "created_at": int(time.time()),
    }
    aff["by_code"][code] = did
    save_json("affiliates.json", aff)
    users = load_json("users.json", {})
    existing = users.get(did, {})
    users[did] = {**existing, "username": username, "updated_at": int(time.time())}
    save_json("users.json", users)
    audit("internal.affiliate.create", discord_id=did, code=code)
    return jsonify({"ok": True, "code": code})


@app.post("/api/internal/affiliate/edit")
def internal_affiliate_edit():
    try:
        require_bot()
    except PermissionError:
        return jsonify({"ok": False}), 403
    body = request.get_json(silent=True) or {}
    actor = str(body.get("actor_discord_id", ""))
    if int(actor) != OWNER_DISCORD_ID:
        return jsonify({"ok": False, "error": "forbidden"}), 403
    did = str(body.get("discord_id", ""))
    new_code = _normalize_code(str(body.get("new_code", "")))
    try:
        d_pct = int(body.get("buyer_discount_percent", 0))
        c_pct = int(body.get("commission_percent", 20))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "bad_number"}), 400
    if d_pct < 0 or d_pct > 100 or c_pct < 0 or c_pct > 100:
        return jsonify({"ok": False, "error": "range"}), 400
    if not AFFILIATE_CODE_RE.match(new_code):
        return jsonify({"ok": False, "error": "bad_code"}), 400

    aff = load_json("affiliates.json", {"by_discord_id": {}, "by_code": {}})
    row = aff["by_discord_id"].get(did)
    if not row:
        return jsonify({"ok": False, "error": "no_affiliate"}), 404
    old = row["code"]
    if new_code != old and new_code in aff["by_code"]:
        return jsonify({"ok": False, "error": "code_taken"}), 400
    aff["by_code"].pop(old, None)
    row["code"] = new_code
    row["buyer_discount_percent"] = d_pct
    row["commission_percent"] = c_pct
    aff["by_code"][new_code] = did
    aff["by_discord_id"][did] = row
    save_json("affiliates.json", aff)
    audit("internal.affiliate.edit", discord_id=did, code=new_code)
    return jsonify({"ok": True, "code": new_code})


@app.get("/api/internal/affiliate/check")
def internal_affiliate_check():
    try:
        require_bot()
    except PermissionError:
        return jsonify({"ok": False}), 403
    did = request.args.get("discord_id", "")
    aff = load_json("affiliates.json", {"by_discord_id": {}, "by_code": {}})
    row = aff["by_discord_id"].get(str(did))
    if not row:
        return jsonify({"ok": True, "exists": False})
    return jsonify({"ok": True, "exists": True, "profile": row})


@app.get("/api/internal/affiliate/list")
def internal_affiliate_list():
    try:
        require_bot()
    except PermissionError:
        return jsonify({"ok": False}), 403
    aff = load_json("affiliates.json", {"by_discord_id": {}, "by_code": {}})
    return jsonify({"ok": True, "affiliates": aff["by_discord_id"]})


@app.get("/api/internal/license/list")
def internal_license_list():
    """List all licenses for a specific Discord user (bot use)."""
    try:
        require_bot()
    except PermissionError:
        return jsonify({"ok": False}), 403
    did = str(request.args.get("discord_id", "")).strip()
    if not did.isdigit():
        return jsonify({"ok": False, "error": "bad_id"}), 400
    licenses = load_json("licenses.json", [])
    mine = [l for l in licenses if str(l.get("discord_id")) == did]
    mine.sort(key=lambda x: int(x.get("created_at", 0)), reverse=True)
    result = []
    for l in mine:
        expires_at = l.get("expires_at")
        if expires_at and int(time.time()) > int(expires_at):
            status = "expired"
        else:
            status = str(l.get("status", "active"))
        result.append({
            "key": l.get("key"),
            "plan": l.get("plan"),
            "status": status,
            "hwid": l.get("hwid", "") or "Unbound",
            "expires_at": datetime.datetime.utcfromtimestamp(int(expires_at)).isoformat() + "Z" if expires_at else "Never",
            "created_at": l.get("created_at"),
        })
    return jsonify({"ok": True, "discord_id": did, "licenses": result, "count": len(result)})


@app.post("/api/internal/license/revoke")
def internal_license_revoke():
    """Deactivate all (or specific) licenses for a Discord user."""
    try:
        require_bot()
    except PermissionError:
        return jsonify({"ok": False}), 403
    body = request.get_json(silent=True) or {}
    did = str(body.get("discord_id", "")).strip()
    target_key = str(body.get("key", "")).strip()
    if not did.isdigit():
        return jsonify({"ok": False, "error": "bad_id"}), 400
    licenses = load_json("licenses.json", [])
    changed = 0
    for l in licenses:
        if str(l.get("discord_id")) != did:
            continue
        if target_key and str(l.get("key", "")) != target_key:
            continue
        l["status"] = "revoked"
        changed += 1
    if changed:
        save_json("licenses.json", licenses)
        audit("internal.license.revoke", discord_id=did, key=target_key or "all", count=changed)
    return jsonify({"ok": True, "revoked": changed})


@app.post("/api/internal/license/resetHwid")
def internal_license_reset_hwid():
    """Reset HWID for all (or specific) licenses for a Discord user."""
    try:
        require_bot()
    except PermissionError:
        return jsonify({"ok": False}), 403
    body = request.get_json(silent=True) or {}
    did = str(body.get("discord_id", "")).strip()
    target_key = str(body.get("key", "")).strip()
    if not did.isdigit():
        return jsonify({"ok": False, "error": "bad_id"}), 400
    licenses = load_json("licenses.json", [])
    changed = 0
    for l in licenses:
        if str(l.get("discord_id")) != did:
            continue
        if target_key and str(l.get("key", "")) != target_key:
            continue
        l["hwid"] = ""
        changed += 1
    if changed:
        save_json("licenses.json", licenses)
        audit("internal.license.resetHwid", discord_id=did, key=target_key or "all", count=changed)
    return jsonify({"ok": True, "reset": changed})


@app.post("/api/internal/license/grant")
def internal_license_grant():
    try:
        require_bot()
    except PermissionError:
        return jsonify({"ok": False}), 403
    body = request.get_json(silent=True) or {}
    did = str(body.get("discord_id", "")).strip()
    plan = str(body.get("plan", "lifetime")).strip().lower()
    if not did.isdigit():
        return jsonify({"ok": False, "error": "bad_id"}), 400
    if plan not in ("monthly", "lifetime"):
        return jsonify({"ok": False, "error": "bad_plan"}), 400
    now = int(time.time())
    expires_at = (now + 30 * 24 * 3600) if plan == "monthly" else None
    key = f"ZNT-{secrets.token_hex(4).upper()}-{secrets.token_hex(2).upper()}-{secrets.token_hex(2).upper()}"
    licenses = load_json("licenses.json", [])
    licenses.append({
        "key": key,
        "discord_id": did,
        "plan": plan,
        "status": "active",
        "hwid": "",
        "created_at": now,
        "expires_at": expires_at,
        "payment_ref": f"admin-grant-{now}",
    })
    save_json("licenses.json", licenses)
    audit("internal.license.grant", discord_id=did, plan=plan, key=key)
    return jsonify({"ok": True, "key": key, "plan": plan})


@app.post("/api/internal/license/claim")
def internal_license_claim():
    """
    Bot endpoint: link an unlinked legacy license to a Discord user.
    Any authenticated bot call may use this; the Discord user's ID is provided.
    The key must currently have discord_id == null (not yet claimed).
    """
    try:
        require_bot()
    except PermissionError:
        return jsonify({"ok": False}), 403

    body = request.get_json(silent=True) or {}
    did = str(body.get("discord_id", "")).strip()
    key = str(body.get("key", "")).strip().upper()

    if not did.isdigit():
        return jsonify({"ok": False, "error": "bad_discord_id"}), 400
    if not key:
        return jsonify({"ok": False, "error": "key_required"}), 400

    licenses = load_json("licenses.json", [])

    # Check this Discord account doesn't already own an active license
    existing_active = next(
        (l for l in licenses if str(l.get("discord_id")) == did and l.get("status") == "active"),
        None,
    )
    if existing_active:
        return jsonify({
            "ok": False,
            "error": "already_linked",
            "existing_key": existing_active.get("key"),
            "existing_plan": existing_active.get("plan"),
        }), 400

    # Find the unlinked entry
    target = next(
        (l for l in licenses if l.get("key", "").upper() == key and l.get("discord_id") is None),
        None,
    )
    if not target:
        return jsonify({
            "ok": False,
            "error": "not_found",
            "detail": "Key not found or already linked to an account.",
        }), 404

    target["discord_id"] = did
    target["claimed_at"] = int(time.time())
    save_json("licenses.json", licenses)
    audit("internal.license.claim", discord_id=did, key=key)
    return jsonify({
        "ok": True,
        "key": target.get("key"),
        "plan": target.get("plan"),
        "status": target.get("status"),
    })


@app.post("/api/internal/coupon/create")
def internal_coupon_create():
    try:
        require_bot()
    except PermissionError:
        return jsonify({"ok": False}), 403
    body = request.get_json(silent=True) or {}
    code = _normalize_code(str(body.get("code", "")))
    try:
        pct = int(body.get("discount_percent", 0))
    except (TypeError, ValueError):
        return jsonify({"ok": False}), 400
    if not code or pct < 0 or pct > 100:
        return jsonify({"ok": False, "error": "invalid"}), 400
    coupons = load_json("coupons.json", {})
    if code in coupons:
        return jsonify({"ok": False, "error": "exists"}), 400
    coupons[code] = {"discount_percent": pct, "active": True, "created_at": int(time.time())}
    save_json("coupons.json", coupons)
    audit("coupon.create", code=code, pct=pct)
    return jsonify({"ok": True})


@app.get("/api/internal/coupon/check")
def internal_coupon_check():
    try:
        require_bot()
    except PermissionError:
        return jsonify({"ok": False}), 403
    code = _normalize_code(request.args.get("code", ""))
    c = get_coupon(code)
    if not c:
        return jsonify({"ok": True, "exists": False})
    return jsonify({"ok": True, "exists": True, "coupon": c})


@app.post("/api/internal/coupon/delete")
def internal_coupon_delete():
    try:
        require_bot()
    except PermissionError:
        return jsonify({"ok": False}), 403
    body = request.get_json(silent=True) or {}
    code = _normalize_code(str(body.get("code", "")))
    coupons = load_json("coupons.json", {})
    if code not in coupons:
        return jsonify({"ok": False, "error": "missing"}), 404
    del coupons[code]
    save_json("coupons.json", coupons)
    audit("coupon.delete", code=code)
    return jsonify({"ok": True})


@app.get("/api/internal/coupon/list")
def internal_coupon_list():
    try:
        require_bot()
    except PermissionError:
        return jsonify({"ok": False}), 403
    return jsonify({"ok": True, "coupons": load_json("coupons.json", {})})


# ---------------------------------------------------------------------------
# Bot API compatibility routes (/api/bot/*)
# ---------------------------------------------------------------------------

def _bot_find_license_by_key(licenses: list[dict[str, Any]], key: str) -> tuple[int, dict[str, Any]] | tuple[None, None]:
    target = _normalize_license_key(key)
    for i, lic in enumerate(licenses):
        if _normalize_license_key(lic.get("key", "")) == target:
            return i, lic
    return None, None


def _license_status_view(lic: dict[str, Any]) -> str:
    expires_at = lic.get("expires_at")
    if expires_at:
        try:
            if int(time.time()) > int(expires_at):
                return "expired"
        except Exception:
            pass
    return str(lic.get("status", "active"))


@app.get("/api/bot/keys")
def bot_keys_list():
    try:
        require_bot()
    except PermissionError:
        return jsonify({"ok": False}), 403
    licenses = load_json("licenses.json", [])
    out = []
    for lic in licenses:
        out.append(
            {
                "key": lic.get("key"),
                "active": str(lic.get("status", "active")) == "active",
                "access": lic.get("plan", "monthly"),
                "tier": lic.get("plan", "monthly"),
                "status": _license_status_view(lic),
                "discord_id": lic.get("discord_id"),
                "email": lic.get("legacy_email", ""),
                "hwid": lic.get("hwid", ""),
                "created_at": lic.get("created_at"),
                "expires_at": lic.get("expires_at"),
                "note": lic.get("legacy_notes", ""),
            }
        )
    return jsonify(out)


@app.post("/api/bot/key-create")
def bot_key_create():
    try:
        require_bot()
    except PermissionError:
        return jsonify({"ok": False}), 403
    body = request.get_json(silent=True) or {}
    plan = str(body.get("plan") or body.get("access") or body.get("tier") or "monthly").strip().lower()
    if plan not in ("monthly", "lifetime"):
        return jsonify({"ok": False, "error": "bad_plan"}), 400
    count = max(1, min(int(body.get("count", 1) or 1), 100))
    note = str(body.get("note", "")).strip()
    discord_id = str(body.get("discord_id", "")).strip() or None
    expires_days = body.get("expires_in_days")
    now = int(time.time())

    licenses = load_json("licenses.json", [])
    created = []
    for _ in range(count):
        key = f"ZNT-{secrets.token_hex(4).upper()}-{secrets.token_hex(2).upper()}-{secrets.token_hex(2).upper()}"
        expires_at = None
        if expires_days is not None:
            try:
                d = max(1, min(int(expires_days), 3650))
                expires_at = now + (d * 24 * 3600)
            except Exception:
                expires_at = None
        elif plan == "monthly":
            expires_at = now + 30 * 24 * 3600
        row = {
            "key": key,
            "discord_id": discord_id,
            "plan": plan,
            "status": "active",
            "hwid": "",
            "created_at": now,
            "expires_at": expires_at,
            "payment_ref": f"bot-create-{now}",
        }
        if note:
            row["legacy_notes"] = note
        licenses.append(row)
        created.append(row)
    save_json("licenses.json", licenses)
    return jsonify({"ok": True, "created": created, "count": len(created)})


@app.post("/api/bot/key-update")
def bot_key_update():
    try:
        require_bot()
    except PermissionError:
        return jsonify({"ok": False}), 403
    body = request.get_json(silent=True) or {}
    key = str(body.get("key", "")).strip()
    if not key:
        return jsonify({"ok": False, "error": "key_required"}), 400
    licenses = load_json("licenses.json", [])
    idx, lic = _bot_find_license_by_key(licenses, key)
    if lic is None:
        return jsonify({"ok": False, "error": "not_found"}), 404

    if "note" in body:
        lic["legacy_notes"] = str(body.get("note") or "").strip()
    if "active" in body:
        lic["status"] = "active" if bool(body.get("active")) else "revoked"
    if "access" in body or "tier" in body or "plan" in body:
        next_plan = str(body.get("access") or body.get("tier") or body.get("plan")).strip().lower()
        if next_plan in ("monthly", "lifetime"):
            lic["plan"] = next_plan
    if "discord_id" in body:
        did = str(body.get("discord_id") or "").strip()
        lic["discord_id"] = did if did else None
    if "expires_at" in body:
        raw = body.get("expires_at")
        if raw in (None, "", 0, "0"):
            lic["expires_at"] = None
        else:
            try:
                lic["expires_at"] = int(raw)
            except Exception:
                pass

    licenses[idx] = lic
    save_json("licenses.json", licenses)
    return jsonify({"ok": True, "key": lic})


@app.post("/api/bot/key-extend")
def bot_key_extend():
    try:
        require_bot()
    except PermissionError:
        return jsonify({"ok": False}), 403
    body = request.get_json(silent=True) or {}
    key = str(body.get("key", "")).strip()
    try:
        days = max(1, min(int(body.get("days", 30)), 3650))
    except Exception:
        days = 30
    licenses = load_json("licenses.json", [])
    idx, lic = _bot_find_license_by_key(licenses, key)
    if lic is None:
        return jsonify({"ok": False, "error": "not_found"}), 404
    now = int(time.time())
    cur = int(lic.get("expires_at") or now)
    base = cur if cur > now else now
    lic["expires_at"] = base + (days * 24 * 3600)
    licenses[idx] = lic
    save_json("licenses.json", licenses)
    return jsonify({"ok": True, "expires_at": lic["expires_at"]})


@app.post("/api/bot/key-reset-hwid")
def bot_key_reset_hwid():
    try:
        require_bot()
    except PermissionError:
        return jsonify({"ok": False}), 403
    body = request.get_json(silent=True) or {}
    key = str(body.get("key", "")).strip()
    licenses = load_json("licenses.json", [])
    idx, lic = _bot_find_license_by_key(licenses, key)
    if lic is None:
        return jsonify({"ok": False, "error": "not_found"}), 404
    lic["hwid"] = ""
    licenses[idx] = lic
    save_json("licenses.json", licenses)
    return jsonify({"ok": True})


@app.post("/api/bot/key-toggle")
def bot_key_toggle():
    try:
        require_bot()
    except PermissionError:
        return jsonify({"ok": False}), 403
    body = request.get_json(silent=True) or {}
    key = str(body.get("key", "")).strip()
    licenses = load_json("licenses.json", [])
    idx, lic = _bot_find_license_by_key(licenses, key)
    if lic is None:
        return jsonify({"ok": False, "error": "not_found"}), 404
    lic["status"] = "revoked" if str(lic.get("status", "active")) == "active" else "active"
    licenses[idx] = lic
    save_json("licenses.json", licenses)
    return jsonify({"ok": True, "active": lic["status"] == "active"})


@app.post("/api/bot/key-delete")
def bot_key_delete():
    try:
        require_bot()
    except PermissionError:
        return jsonify({"ok": False}), 403
    body = request.get_json(silent=True) or {}
    key = str(body.get("key", "")).strip()
    licenses = load_json("licenses.json", [])
    idx, lic = _bot_find_license_by_key(licenses, key)
    if lic is None:
        return jsonify({"ok": False, "error": "not_found"}), 404
    del licenses[idx]
    save_json("licenses.json", licenses)
    return jsonify({"ok": True})


@app.post("/api/bot/discord/claim")
def bot_discord_claim():
    return internal_license_claim()


@app.post("/api/bot/discord/grant")
def bot_discord_grant():
    return internal_license_grant()


@app.get("/api/bot/discord/licenses")
def bot_discord_licenses():
    return internal_license_list()


@app.post("/api/bot/discord/revoke")
def bot_discord_revoke():
    return internal_license_revoke()


@app.post("/api/bot/discord/upgrade")
def bot_discord_upgrade():
    try:
        require_bot()
    except PermissionError:
        return jsonify({"ok": False}), 403
    body = request.get_json(silent=True) or {}
    did = str(body.get("discord_id", "")).strip()
    target_key = str(body.get("key", "")).strip()
    if not did.isdigit():
        return jsonify({"ok": False, "error": "bad_id"}), 400
    licenses = load_json("licenses.json", [])
    changed = []
    for lic in licenses:
        if str(lic.get("discord_id")) != did:
            continue
        if target_key and str(lic.get("key", "")) != target_key:
            continue
        if str(lic.get("plan", "")).lower() == "lifetime":
            continue
        lic["plan"] = "lifetime"
        lic["expires_at"] = None
        changed.append({"key": lic.get("key"), "plan": "lifetime"})
    if changed:
        save_json("licenses.json", licenses)
    return jsonify({"ok": True, "upgraded": len(changed), "licenses": changed})


@app.post("/api/bot/discord/reset-hwid")
def bot_discord_reset_hwid():
    return internal_license_reset_hwid()


@app.post("/api/bot/discord/set-affiliate")
def bot_discord_set_affiliate():
    try:
        require_bot()
    except PermissionError:
        return jsonify({"ok": False}), 403
    body = request.get_json(silent=True) or {}
    did = str(body.get("discord_id", "")).strip()
    code_raw = str(body.get("affiliate_code", "")).strip()
    if not did.isdigit():
        return jsonify({"ok": False, "error": "bad_id"}), 400
    aff = load_json("affiliates.json", {"by_discord_id": {}, "by_code": {}})

    existing = aff["by_discord_id"].get(did)
    old_code = existing.get("code") if existing else None
    if old_code:
        aff["by_code"].pop(old_code, None)

    if code_raw:
        code = _normalize_code(code_raw)
        if not AFFILIATE_CODE_RE.match(code):
            return jsonify({"ok": False, "error": "bad_code"}), 400
        taken = aff["by_code"].get(code)
        if taken and str(taken) != did:
            return jsonify({"ok": False, "error": "code_taken"}), 400
        profile = existing or {
            "code": code,
            "commission_percent": DEFAULT_COMMISSION_PERCENT,
            "buyer_discount_percent": DEFAULT_BUYER_DISCOUNT_PERCENT,
            "created_at": int(time.time()),
        }
        profile["code"] = code
        aff["by_discord_id"][did] = profile
        aff["by_code"][code] = did
    else:
        aff["by_discord_id"].pop(did, None)

    save_json("affiliates.json", aff)
    return jsonify({"ok": True, "discord_id": did, "affiliate_code": code_raw or ""})


@app.post("/api/claim-discord-role")
def claim_discord_role():
    body = request.get_json(silent=True) or {}
    did = str(body.get("discordId") or body.get("discord_id") or "").strip()
    key = str(body.get("key") or "").strip()
    if not did.isdigit() or not key:
        return jsonify({"ok": False, "reason": "invalid_input"}), 400
    licenses = load_json("licenses.json", [])
    norm_key = _normalize_license_key(key)
    target = next((l for l in licenses if _normalize_license_key(l.get("key", "")) == norm_key), None)
    if not target:
        return jsonify({"ok": False, "reason": "not_found"}), 404
    owner = str(target.get("discord_id") or "")
    if owner and owner != did:
        return jsonify({"ok": False, "reason": "already_linked"}), 400
    target["discord_id"] = did
    target["claimed_at"] = int(time.time())
    save_json("licenses.json", licenses)
    return jsonify({"ok": True, "plan": target.get("plan", "monthly"), "status": target.get("status", "active")})


# ---------------------------------------------------------------------------
# Compat routes for dashboard.html / dashboard.js
# ---------------------------------------------------------------------------

@app.get("/api/dashboard/me")
def dashboard_me():
    """Return session user + first license summary in the shape dashboard.js expects."""
    u = get_current_user()
    if not u:
        return jsonify({"ok": False, "error": "Not authenticated"}), 401

    did = str(u["discord_id"])
    users = load_json("users.json", {})
    user_row = users.get(did, {})

    # Build avatar URL — use stored one or generate Discord default
    avatar_url = user_row.get("avatar_url", "")
    if not avatar_url:
        default_index = (int(did) >> 22) % 6
        avatar_url = f"https://cdn.discordapp.com/embed/avatars/{default_index}.png"

    global_name = (
        user_row.get("global_name")
        or user_row.get("username")
        or u.get("username", "User")
    )

    licenses = load_json("licenses.json", [])
    mine = [l for l in licenses if str(l.get("discord_id")) == did]
    mine.sort(key=lambda x: int(x.get("created_at", 0)), reverse=True)

    summary = None
    if mine:
        lic = mine[0]
        key = str(lic.get("key", ""))
        plan = str(lic.get("plan", "—"))
        hwid = str(lic.get("hwid", "") or "")
        expires_at = lic.get("expires_at")

        # Determine real status
        if expires_at and int(time.time()) > int(expires_at):
            status = "expired"
        else:
            status = str(lic.get("status", "active"))

        expires_iso = None
        if expires_at:
            expires_iso = datetime.datetime.utcfromtimestamp(int(expires_at)).isoformat() + "Z"

        next_billing = expires_iso if plan == "monthly" else None

        summary = {
            "plan": plan,
            "status": status,
            "keyMasked": key[:8] + "****" if len(key) > 8 else key,
            "keyFull": key,
            "hwid": hwid,
            "expiresAt": expires_iso,
            "nextBillingDate": next_billing,
        }

    return jsonify({
        "ok": True,
        "user": {
            "discordId": did,
            "globalName": global_name,
            "username": user_row.get("username", u.get("username", "")),
            "email": user_row.get("email", ""),
            "avatarUrl": avatar_url,
        },
        "summary": summary,
    })


@app.get("/api/dashboard/licenses")
def dashboard_licenses():
    u = get_current_user()
    if not u:
        return jsonify({"ok": False, "items": []}), 401
    did = str(u["discord_id"])
    licenses = load_json("licenses.json", [])
    mine = [l for l in licenses if str(l.get("discord_id")) == did]
    mine.sort(key=lambda x: int(x.get("created_at", 0)), reverse=True)
    items = []
    for l in mine[:20]:
        key = str(l.get("key", ""))
        hwid = str(l.get("hwid", "") or "")
        expires_at = l.get("expires_at")
        expires_iso = None
        if expires_at:
            expires_iso = datetime.datetime.utcfromtimestamp(int(expires_at)).isoformat() + "Z"
        if expires_at and int(time.time()) > int(expires_at):
            status = "expired"
        else:
            status = str(l.get("status", "active"))
        items.append({
            "keyMasked": key[:8] + "****" if len(key) > 8 else key,
            "keyFull": key,
            "plan": l.get("plan", "—"),
            "status": status,
            "hwid": hwid,
            "expiresAt": expires_iso,
            "createdAt": l.get("created_at"),
        })
    return jsonify({"ok": True, "items": items})


@app.post("/api/dashboard/logout")
def dashboard_logout():
    resp = jsonify({"ok": True})
    resp.delete_cookie(SESSION_COOKIE, path="/")
    return resp


@app.post("/api/dashboard/reset-hwid")
def dashboard_reset_hwid():
    u = get_current_user()
    if not u:
        return jsonify({"ok": False, "error": "unauthorized"}), 401
    did = str(u["discord_id"])
    body = request.get_json(silent=True) or {}
    target_key = str(body.get("key", "")).strip()

    licenses = load_json("licenses.json", [])
    changed = 0
    for lic in licenses:
        if str(lic.get("discord_id")) != did:
            continue
        if target_key and str(lic.get("key", "")) != target_key:
            continue
        lic["hwid"] = ""
        changed += 1
    if changed:
        save_json("licenses.json", licenses)
        audit("hwid.reset", discord_id=did, key=target_key or "all")
    return jsonify({"ok": True, "message": f"HWID reset for {changed} license(s)."})


@app.post("/api/dashboard/cancel-subscription")
def dashboard_cancel_subscription():
    u = get_current_user()
    if not u:
        return jsonify({"ok": False, "error": "unauthorized"}), 401
    return jsonify({"ok": True, "message": "No active subscription to cancel."})


@app.post("/api/dashboard/claim-legacy")
def dashboard_claim_legacy():
    """
    Allow a logged-in user to claim an unlinked legacy (ZNTH*) license
    by entering the exact key.  Only works if the license has no discord_id set.
    """
    u = get_current_user()
    if not u:
        return jsonify({"ok": False, "error": "unauthorized"}), 401

    did = str(u["discord_id"])
    body = request.get_json(silent=True) or {}
    key = str(body.get("key", "")).strip().upper()

    if not key:
        return jsonify({"ok": False, "error": "No key provided."}), 400

    licenses = load_json("licenses.json", [])

    # Check caller doesn't already have an active license
    caller_active = any(
        str(l.get("discord_id")) == did and l.get("status") == "active"
        for l in licenses
    )
    if caller_active:
        return jsonify({"ok": False, "error": "Your account already has an active license."}), 400

    # Find the unlinked license
    target = next(
        (l for l in licenses if l.get("key", "").upper() == key and l.get("discord_id") is None),
        None,
    )
    if not target:
        return jsonify({
            "ok": False,
            "error": "Key not found or already linked to an account.",
        }), 404

    # Link it
    target["discord_id"] = did
    target["claimed_at"] = int(time.time())
    save_json("licenses.json", licenses)
    audit("license.claimed", discord_id=did, key=key)

    return jsonify({
        "ok": True,
        "message": "License successfully linked to your account.",
        "plan": target.get("plan"),
        "status": target.get("status"),
    })


@app.get("/api/create-checkout")
def create_checkout_redirect():
    """Redirect old buy-button links to the new Next.js checkout pages."""
    plan = request.args.get("plan", "monthly")
    if plan not in ("monthly", "lifetime"):
        plan = "monthly"
    return redirect(f"{FRONTEND_ORIGIN}/selectpayment?plan={plan}")


# ---------------------------------------------------------------------------
if __name__ == "__main__":
    DATA.mkdir(parents=True, exist_ok=True)
    print(f"[zenith-api] FRONTEND_ORIGIN={FRONTEND_ORIGIN}")
    print(f"[zenith-api] DISCORD_REDIRECT_URI={DISCORD_REDIRECT_URI}")
    print(f"[zenith-api] Discord OAuth: {'yes' if DISCORD_CLIENT_ID else 'no (set DISCORD_CLIENT_ID in API/.env)'}")
    if (
        DISCORD_CLIENT_SECRET
        and SECRET_KEY
        and DISCORD_CLIENT_SECRET == SECRET_KEY
    ):
        print(
            "[zenith-api] WARNING: DISCORD_CLIENT_SECRET equals SECRET_KEY. "
            "Use the OAuth2 Client Secret from Discord Developer Portal, not your Flask SECRET_KEY."
        )
    app.run(host=API_HOST, port=API_PORT, debug=os.environ.get("FLASK_DEBUG") == "1")
