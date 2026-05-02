"""
Web OAuth: Discord authorization code flow + Flask session (24h) for the marketing site.

Requires DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and matching redirect URI in the Discord app.
"""
from __future__ import annotations

import json
import secrets
import urllib.error
import urllib.parse
import urllib.request
from flask import Blueprint, jsonify, redirect, request, session

web_bp = Blueprint("web_oauth", __name__)

DISCORD_API = "https://discord.com/api"
DISCORD_AUTHORIZE = f"{DISCORD_API}/oauth2/authorize"
DISCORD_TOKEN = f"{DISCORD_API}/oauth2/token"


def _cfg(key: str, default: str = "") -> str:
    from flask import current_app

    return str(current_app.config.get(key) or default).strip()


def _cors_headers():
    from flask import current_app

    origin = request.headers.get("Origin", "")
    allowed = current_app.config.get("WEB_CORS_ORIGINS") or []
    if origin and origin in allowed:
        return {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        }
    return {}


@web_bp.route("/api/web/session", methods=["GET", "OPTIONS"])
def web_session():
    if request.method == "OPTIONS":
        r = jsonify({})
        r.status_code = 204
        for k, v in _cors_headers().items():
            r.headers[k] = v
        return r

    u = session.get("web_user")
    r = jsonify({"ok": bool(u), "user": u})
    for k, v in _cors_headers().items():
        r.headers[k] = v
    return r


@web_bp.route("/api/web/logout", methods=["POST", "OPTIONS"])
def web_logout():
    if request.method == "OPTIONS":
        r = jsonify({})
        r.status_code = 204
        for k, v in _cors_headers().items():
            r.headers[k] = v
        return r

    session.pop("web_user", None)
    session.pop("oauth_state", None)
    r = jsonify({"ok": True})
    for k, v in _cors_headers().items():
        r.headers[k] = v
    return r


@web_bp.route("/oauth/discord/start")
def discord_oauth_start():
    client_id = _cfg("DISCORD_CLIENT_ID")
    redirect_uri = _cfg("WEB_OAUTH_REDIRECT_URI")
    if not client_id or not redirect_uri:
        return (
            "Discord OAuth is not configured. Set DISCORD_CLIENT_ID and WEB_OAUTH_REDIRECT_URI in the backend .env.",
            503,
        )

    state = secrets.token_urlsafe(32)
    session["oauth_state"] = state
    session.permanent = True

    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": "identify email",
        "state": state,
        "prompt": "consent",
    }
    url = f"{DISCORD_AUTHORIZE}?{urllib.parse.urlencode(params)}"
    return redirect(url)


@web_bp.route("/oauth/discord/callback")
def discord_oauth_callback():
    frontend = _cfg("WEB_FRONTEND_ORIGIN", "http://127.0.0.1:8080").rstrip("/")
    err_url = f"{frontend}/?oauth_error=1"
    ok_url = f"{frontend}/?oauth_success=1"

    error = request.args.get("error")
    if error:
        return redirect(err_url)

    code = request.args.get("code")
    state = request.args.get("state")
    expected = session.get("oauth_state")
    if not code or not state or not expected or not secrets.compare_digest(str(state), str(expected)):
        return redirect(err_url)

    session.pop("oauth_state", None)

    client_id = _cfg("DISCORD_CLIENT_ID")
    client_secret = _cfg("DISCORD_CLIENT_SECRET")
    redirect_uri = _cfg("WEB_OAUTH_REDIRECT_URI")
    if not client_id or not client_secret or not redirect_uri:
        return redirect(err_url)

    body = urllib.parse.urlencode(
        {
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
        }
    ).encode()

    req = urllib.request.Request(
        DISCORD_TOKEN,
        data=body,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            token_payload = json.loads(resp.read().decode())
    except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError, TimeoutError):
        return redirect(err_url)

    access_token = token_payload.get("access_token")
    if not access_token:
        return redirect(err_url)

    ureq = urllib.request.Request(
        f"{DISCORD_API}/users/@me",
        headers={"Authorization": f"Bearer {access_token}"},
    )
    try:
        with urllib.request.urlopen(ureq, timeout=20) as resp:
            user = json.loads(resp.read().decode())
    except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError, TimeoutError):
        return redirect(err_url)

    uid = str(user.get("id") or "")
    username = str(user.get("username") or "")
    disc = str(user.get("discriminator") or "0")
    avatar = user.get("avatar")
    email = user.get("email")

    display = username
    if disc and disc != "0":
        display = f"{username}#{disc}"

    avatar_url = None
    if uid and avatar:
        avatar_url = f"https://cdn.discordapp.com/avatars/{uid}/{avatar}.png?size=64"

    session.permanent = True
    session["web_user"] = {
        "id": uid,
        "username": display,
        "global_name": user.get("global_name") or username,
        "email": email,
        "avatar_url": avatar_url,
    }

    return redirect(ok_url)
