"""
Import legacy keys directly from the old bot API into the new backend DB.

Usage (from backend/):
  python migrate_from_legacy_api.py --api https://zenith-license.fly.dev --secret <BOT_API_SECRET> --dry-run
  python migrate_from_legacy_api.py --api https://zenith-license.fly.dev --secret <BOT_API_SECRET>

If --api / --secret are omitted, env fallbacks are used:
  LEGACY_LICENSE_API_URL / LICENSE_API_URL
  LEGACY_BOT_API_SECRET / BOT_API_SECRET / ZENITH_BOT_API_TOKEN
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import re
import secrets
import time
from datetime import datetime, timezone
from typing import Any
from urllib.request import Request, urlopen

from app import create_app
from database import db
from models import License
from utils.crypto import sha256_hex

_STRIP_RE = re.compile(r'[^A-Za-z0-9]')
_HEX64_RE = re.compile(r'^[0-9a-fA-F]{64}$')


def _normalize_key(raw: Any) -> str:
    cleaned = _STRIP_RE.sub('', str(raw or '')).upper()
    if len(cleaned) < 8 or len(cleaned) > 32:
        raise ValueError('invalid key length')
    return cleaned


def _parse_dt(raw: Any):
    if raw in (None, '', 0):
        return None
    text = str(raw).strip()
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text.replace('Z', '+00:00'))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _parse_bool(raw: Any, default=True) -> bool:
    if isinstance(raw, bool):
        return raw
    if raw is None:
        return default
    text = str(raw).strip().lower()
    if text in {'1', 'true', 'yes', 'on', 'enabled', 'active'}:
        return True
    if text in {'0', 'false', 'no', 'off', 'disabled', 'inactive'}:
        return False
    return default


def _build_sig(secret: str, method: str, path: str, ts: str, body: bytes) -> str:
    canonical = '\n'.join([
        method.upper(),
        path,
        ts,
        hashlib.sha256(body or b'').hexdigest(),
    ])
    return hmac.new(secret.encode('utf-8'), canonical.encode('utf-8'), hashlib.sha256).hexdigest()


def _fetch_legacy_keys(api_url: str, secret: str) -> list[dict]:
    api = str(api_url or '').strip().rstrip('/')
    if not api:
        raise RuntimeError('missing api url')
    if not secret:
        raise RuntimeError('missing secret')

    path = '/api/bot/keys'
    ts = str(int(time.time() * 1000))
    sig = _build_sig(secret, 'GET', path, ts, b'')
    headers = {
        'Authorization': f'Bearer {secret}',
        'x-bot-secret': secret,
        'x-bot-ts': ts,
        'x-bot-signature': sig,
    }

    req = Request(api + path, headers=headers, method='GET')
    with urlopen(req, timeout=30) as resp:  # nosec B310
        raw = resp.read().decode('utf-8', errors='replace')
    payload = json.loads(raw or '[]')
    if isinstance(payload, dict):
        items = payload.get('items')
        if isinstance(items, list):
            payload = items
        else:
            payload = [payload]
    if not isinstance(payload, list):
        raise RuntimeError('unexpected payload from legacy api')
    return payload


def run(api_url: str, secret: str, dry_run: bool):
    rows = _fetch_legacy_keys(api_url, secret)
    print(f'Fetched {len(rows)} keys from legacy API.')

    created = 0
    updated = 0
    skipped = 0

    app = create_app()
    with app.app_context():
        for row in rows:
            try:
                key = _normalize_key(row.get('key'))
            except Exception:
                skipped += 1
                continue

            key_hash = sha256_hex(key)
            item = License.query.filter_by(key_hash=key_hash).first()
            is_new = item is None
            if is_new:
                item = License(
                    key=key,
                    key_hash=key_hash,
                    user_enc_key=secrets.token_hex(32),
                    user_salt=secrets.token_hex(16),
                    session_nonce=secrets.token_hex(16),
                )
                db.session.add(item)

            tier = str(row.get('access') or row.get('tier') or row.get('plan') or 'monthly').strip().lower()
            item.tier = tier if tier in {'monthly', 'lifetime'} else 'monthly'
            item.is_revoked = not _parse_bool(row.get('active'), default=True)

            item.expires_at = _parse_dt(row.get('expires_at') or row.get('expiresAt'))
            item.activated_at = _parse_dt(row.get('activated_at') or row.get('activatedAt'))
            item.last_validated = _parse_dt(row.get('last_validated') or row.get('lastValidated'))
            if is_new:
                item.created_at = _parse_dt(row.get('created_at') or row.get('createdAt')) or datetime.now(timezone.utc)

            hwid = str(row.get('hwid') or row.get('hwid_hash') or '').strip()
            if hwid and _HEX64_RE.fullmatch(hwid):
                item.hwid_hash = hwid.lower()
            elif hwid:
                item.hwid_hash = hashlib.sha256(hwid.encode('utf-8')).hexdigest()
            else:
                item.hwid_hash = None

            try:
                item.hwid_change_count = int(row.get('hwid_change_count') or row.get('hwidChangeCount') or 0)
            except Exception:
                item.hwid_change_count = 0

            meta = item.extra_metadata or {}
            note = str(row.get('note') or row.get('notes') or '').strip()
            email = str(row.get('email') or '').strip().lower()
            discord_id = str(row.get('discord_id') or row.get('discordId') or '').strip()

            if note:
                meta['notes'] = note[:400]
            else:
                meta.pop('notes', None)
            if email:
                meta['email'] = email[:180]
            else:
                meta.pop('email', None)
            if discord_id:
                meta['discord_id'] = discord_id[:64]
            else:
                meta.pop('discord_id', None)
            item.extra_metadata = meta
            item.session_nonce = secrets.token_hex(16)

            if is_new:
                created += 1
            else:
                updated += 1

        if dry_run:
            db.session.rollback()
            print('Dry run complete. No changes written.')
        else:
            db.session.commit()
            print('Import committed.')

        total = db.session.query(License).count()
        print(f'created={created} updated={updated} skipped={skipped} total={total}')


def main():
    parser = argparse.ArgumentParser(description='Import legacy keys from old API into current DB')
    parser.add_argument('--api', default='', help='Legacy API base URL (e.g. https://zenith-license.fly.dev)')
    parser.add_argument('--secret', default='', help='Legacy BOT API secret')
    parser.add_argument('--dry-run', action='store_true', help='Fetch + parse only; do not commit')
    args = parser.parse_args()

    import os
    api = args.api.strip() or os.environ.get('LEGACY_LICENSE_API_URL') or os.environ.get('LICENSE_API_URL') or ''
    secret = (
        args.secret.strip()
        or os.environ.get('LEGACY_BOT_API_SECRET')
        or os.environ.get('BOT_API_SECRET')
        or os.environ.get('ZENITH_BOT_API_TOKEN')
        or ''
    )
    if not api or not secret:
        raise SystemExit('missing api/secret (set args or env)')
    run(api, secret, args.dry_run)


if __name__ == '__main__':
    main()

