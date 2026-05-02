"""
Import legacy license keys into the new 1.2 auth database.

Usage (run from backend/):
    python migrate_legacy_keys.py --source C:\\path\\to\\old.db --dry-run
    python migrate_legacy_keys.py --source C:\\path\\to\\old.db

Optional:
    --replace-existing   Overwrite existing rows when key already exists.
"""

import argparse
import json
import os
import re
import secrets
import sqlite3
from datetime import datetime, timezone
from typing import Any

from app import create_app
from database import db
from models import License
from utils.crypto import sha256_hex


def _normalize_key(raw: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9]", "", str(raw or "")).upper()
    if len(cleaned) < 8 or len(cleaned) > 32:
        raise ValueError(f"license key invalid length after strip: {len(cleaned)}")
    return cleaned


def _first_value(row: dict[str, Any], keys: list[str], default=None):
    for key in keys:
        if key in row and row[key] is not None:
            return row[key]
    return default


def _parse_bool(value: Any, default=False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "y"}:
        return True
    if text in {"0", "false", "no", "n"}:
        return False
    return default


def _parse_int(value: Any, default=0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _parse_dt(value: Any):
    if value in (None, "", 0):
        return None
    if isinstance(value, (int, float)):
        # Assume unix seconds.
        try:
            return datetime.fromtimestamp(float(value), tz=timezone.utc)
        except Exception:
            return None
    text = str(value).strip()
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _load_legacy_rows(source_db: str) -> list[dict[str, Any]]:
    conn = sqlite3.connect(source_db)
    conn.row_factory = sqlite3.Row
    try:
        table = None
        for candidate in ("licenses", "license_keys", "keys"):
            exists = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
                (candidate,),
            ).fetchone()
            if exists:
                table = candidate
                break
        if not table:
            raise RuntimeError("No license table found (checked: licenses, license_keys, keys)")
        rows = conn.execute(f"SELECT * FROM {table}").fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def _to_license_payload(row: dict[str, Any]) -> dict[str, Any]:
    raw_key = _first_value(row, ["key", "license_key", "code", "token"], "")
    key = _normalize_key(raw_key)

    tier = str(_first_value(row, ["tier", "plan", "type"], "monthly")).strip().lower()
    if tier not in {"monthly", "lifetime"}:
        tier = "monthly"

    metadata = {}
    notes = _first_value(row, ["notes", "note", "comment"], "")
    if notes:
        metadata["notes"] = str(notes)[:400]
    email = _first_value(row, ["email", "buyer_email"], "")
    if email:
        metadata["email"] = str(email)[:180]

    # Keep any raw metadata payload if present.
    raw_meta = _first_value(row, ["metadata", "_metadata"], None)
    if raw_meta:
        try:
            parsed = json.loads(raw_meta) if isinstance(raw_meta, str) else dict(raw_meta)
            if isinstance(parsed, dict):
                metadata.update(parsed)
        except Exception:
            metadata["legacy_metadata"] = str(raw_meta)[:600]

    return {
        "key": key,
        "key_hash": sha256_hex(key),
        "user_enc_key": _first_value(row, ["user_enc_key"], "") or secrets.token_hex(32),
        "user_salt": _first_value(row, ["user_salt"], "") or secrets.token_hex(16),
        "session_nonce": _first_value(row, ["session_nonce"], "") or secrets.token_hex(16),
        "hwid_hash": _first_value(row, ["hwid_hash"], None),
        "hwid_change_count": _parse_int(_first_value(row, ["hwid_change_count"], 0), 0),
        "tier": tier,
        "is_revoked": _parse_bool(_first_value(row, ["is_revoked", "revoked", "disabled"], False), False),
        "activated_at": _parse_dt(_first_value(row, ["activated_at"], None)),
        "expires_at": _parse_dt(_first_value(row, ["expires_at", "expiry", "expires"], None)),
        "last_validated": _parse_dt(_first_value(row, ["last_validated", "last_seen"], None)),
        "metadata": metadata,
    }


def run(source: str, dry_run: bool, replace_existing: bool):
    rows = _load_legacy_rows(source)
    print(f"Loaded {len(rows)} legacy rows from: {source}")
    if not rows:
        return

    created = 0
    updated = 0
    skipped = 0
    invalid = 0

    app = create_app()
    with app.app_context():
        for row in rows:
            try:
                payload = _to_license_payload(row)
            except Exception:
                invalid += 1
                continue

            existing = License.query.filter_by(key_hash=payload["key_hash"]).first()
            if existing and not replace_existing:
                skipped += 1
                continue

            target = existing or License()
            target.key = payload["key"]
            target.key_hash = payload["key_hash"]
            target.user_enc_key = payload["user_enc_key"]
            target.user_salt = payload["user_salt"]
            target.session_nonce = payload["session_nonce"]
            target.hwid_hash = payload["hwid_hash"]
            target.hwid_change_count = payload["hwid_change_count"]
            target.tier = payload["tier"]
            target.is_revoked = payload["is_revoked"]
            target.activated_at = payload["activated_at"]
            target.expires_at = payload["expires_at"]
            target.last_validated = payload["last_validated"]
            target.extra_metadata = payload["metadata"]

            if not existing:
                db.session.add(target)
                created += 1
            else:
                updated += 1

        if dry_run:
            db.session.rollback()
            print("Dry run complete. No changes were written.")
        else:
            db.session.commit()
            print("Migration committed.")

    print(f"created={created} updated={updated} skipped={skipped} invalid={invalid}")


def main():
    parser = argparse.ArgumentParser(description="Import legacy keys into Zenith 1.2 backend")
    parser.add_argument("--source", required=True, help="Path to legacy SQLite DB")
    parser.add_argument("--dry-run", action="store_true", help="Validate and simulate import only")
    parser.add_argument("--replace-existing", action="store_true", help="Overwrite keys that already exist")
    args = parser.parse_args()

    if not os.path.exists(args.source):
        raise SystemExit(f"Source DB not found: {args.source}")

    run(args.source, args.dry_run, args.replace_existing)


if __name__ == "__main__":
    main()

