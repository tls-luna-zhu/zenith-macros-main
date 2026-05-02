#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
import urllib.error
import urllib.request


def _load_dotenv() -> None:
    candidates = [
        Path(__file__).resolve().parents[1] / ".env",
        Path(__file__).resolve().parents[1] / "backend" / ".env",
    ]
    for path in candidates:
        if not path.exists():
            continue
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if not key or key in os.environ:
                continue
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
                value = value[1:-1]
            os.environ[key] = value


def _ok(label: str) -> None:
    print(f"[PASS] {label}")


def _fail(label: str, detail: str = "") -> None:
    if detail:
        print(f"[FAIL] {label} - {detail}")
    else:
        print(f"[FAIL] {label}")


def _warn(label: str, detail: str = "") -> None:
    if detail:
        print(f"[WARN] {label} - {detail}")
    else:
        print(f"[WARN] {label}")


def _env(name: str) -> str:
    return str(os.environ.get(name, "")).strip()


def check_env() -> bool:
    required = [
        "ZENITH_SECRET_KEY",
        "ZENITH_BOT_API_TOKEN",
        "ZENITH_STORE_API_TOKEN",
        "DISCORD_CLIENT_ID",
        "DISCORD_CLIENT_SECRET",
        "DISCORD_OAUTH_REDIRECT_URI",
        "STRIPE_CHECKOUT_LINK_MONTHLY",
        "STRIPE_CHECKOUT_LINK_LIFETIME",
        "STRIPE_SECRET_KEY",
        "STRIPE_WEBHOOK_SECRET",
        "SMTP_HOST",
        "SMTP_USERNAME",
        "SMTP_PASSWORD",
        "SMTP_FROM",
        "GITHUB_RELEASE_REPO",
        "GITHUB_TOKEN",
    ]

    ok = True
    for key in required:
        if _env(key):
            _ok(f"env:{key}")
        else:
            _fail(f"env:{key}", "missing")
            ok = False

    optional = [
        "STRIPE_PRICE_ID_MONTHLY",
        "STRIPE_PRICE_ID_LIFETIME",
        "STRIPE_BILLING_PORTAL_URL",
        "ZENITH_UPDATE_ENDPOINT",
    ]
    for key in optional:
        if _env(key):
            _ok(f"env:{key}")
        else:
            _warn(f"env:{key}", "not set")
    return ok


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        return None


def _fetch(url: str) -> tuple[int, str]:
    req = urllib.request.Request(url, method="GET")
    opener = urllib.request.build_opener(_NoRedirect())
    with opener.open(req, timeout=10) as resp:
        body = resp.read(300).decode("utf-8", errors="replace")
        return int(resp.status), body


def check_remote(base: str) -> bool:
    base = base.rstrip("/")
    checks = [
        ("/healthz", 200),
        ("/api/pricing", 200),
        ("/auth/discord/start?next=%2Fdashboard.html", 302),
        ("/api/client/latest", 200),
    ]
    ok = True
    for path, expected in checks:
        url = f"{base}{path}"
        try:
            status, _body = _fetch(url)
            if status == expected or (expected == 302 and status in {301, 302, 303, 307, 308}):
                _ok(f"remote:{path} ({status})")
            else:
                _fail(f"remote:{path}", f"expected {expected}, got {status}")
                ok = False
        except urllib.error.HTTPError as exc:
            code = int(exc.code)
            if expected == 302 and code in {301, 302, 303, 307, 308}:
                _ok(f"remote:{path} ({code})")
            else:
                _fail(f"remote:{path}", f"http {code}")
                ok = False
        except Exception as exc:
            _fail(f"remote:{path}", str(exc))
            ok = False
    return ok


def main() -> int:
    _load_dotenv()
    parser = argparse.ArgumentParser(description="Zenith 1.2.0 release preflight checks")
    parser.add_argument("--base-url", default="", help="Optional deployed base URL to probe")
    args = parser.parse_args()

    overall_ok = True
    print("== ENV CHECK ==")
    overall_ok = check_env() and overall_ok

    if args.base_url.strip():
        print("\n== REMOTE CHECK ==")
        overall_ok = check_remote(args.base_url.strip()) and overall_ok

    if overall_ok:
        print("\nPreflight PASSED")
        return 0

    print("\nPreflight FAILED")
    return 1


if __name__ == "__main__":
    sys.exit(main())
