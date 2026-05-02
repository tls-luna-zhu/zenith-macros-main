import hashlib
import json
import secrets

from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import inspect, text

db = SQLAlchemy()


def init_db(app):
    db.init_app(app)
    with app.app_context():
        from models import License  # noqa: F401
        db.create_all()
        _ensure_schema()


def _column_exists(inspector, table: str, column: str) -> bool:
    """Check if a column already exists in the table (works on both SQLite and PostgreSQL)."""
    columns = [c['name'] for c in inspector.get_columns(table)]
    return column.lower() in [c.lower() for c in columns]


def _add_column_safe(conn, inspector, table: str, column: str, col_def: str) -> bool:
    """Add a column if it doesn't exist. Returns True if added."""
    if _column_exists(inspector, table, column):
        return False
    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {col_def}"))
    return True


def _ensure_schema():
    """Add any columns that are missing from the live database."""
    with db.engine.begin() as conn:
        insp = inspect(db.engine)

        # ── Core auth columns ──────────────────────────────────────────────
        _add_column_safe(conn, insp, 'licenses', 'key_hash', 'VARCHAR(64)')
        _add_column_safe(conn, insp, 'licenses', 'user_enc_key', 'VARCHAR(64)')
        _add_column_safe(conn, insp, 'licenses', 'user_salt', 'VARCHAR(64)')

        added_nonce = _add_column_safe(conn, insp, 'licenses', 'session_nonce', 'VARCHAR(32)')

        # ── HWID / plan columns ────────────────────────────────────────────
        _add_column_safe(conn, insp, 'licenses', 'hwid_hash', 'VARCHAR(64)')
        _add_column_safe(conn, insp, 'licenses', 'hwid_change_count', 'INTEGER NOT NULL DEFAULT 0')
        _add_column_safe(conn, insp, 'licenses', 'last_validated', 'TIMESTAMP')
        _add_column_safe(conn, insp, 'licenses', 'metadata', 'TEXT')
        _add_column_safe(conn, insp, 'licenses', 'tier', "VARCHAR(16) NOT NULL DEFAULT 'monthly'")
        _add_column_safe(conn, insp, 'licenses', 'is_revoked', 'BOOLEAN NOT NULL DEFAULT FALSE')
        _add_column_safe(conn, insp, 'licenses', 'activated_at', 'TIMESTAMP')
        _add_column_safe(conn, insp, 'licenses', 'expires_at', 'TIMESTAMP')

        added_created = _add_column_safe(conn, insp, 'licenses', 'created_at', 'TIMESTAMP')
        if added_created:
            conn.execute(text(
                "UPDATE licenses SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL"
            ))

        # ── Backfill missing crypto fields for pre-existing rows ───────────
        rows = conn.execute(text(
            "SELECT id, key, key_hash, user_enc_key, user_salt, session_nonce FROM licenses"
        )).fetchall()

        for row in rows:
            lic_id = int(row[0])
            key_raw = str(row[1] or '').strip().upper().replace('-', '')
            key_hash = str(row[2] or '').strip().lower()
            user_enc_key = str(row[3] or '').strip().lower()
            user_salt = str(row[4] or '').strip().lower()
            session_nonce = str(row[5] or '').strip().lower()

            if not key_hash and key_raw:
                key_hash = hashlib.sha256(key_raw.encode('utf-8')).hexdigest()
            if not user_enc_key:
                user_enc_key = secrets.token_hex(32)
            if not user_salt:
                user_salt = secrets.token_hex(16)
            if not session_nonce:
                session_nonce = secrets.token_hex(16)

            conn.execute(
                text(
                    "UPDATE licenses "
                    "SET key_hash = :kh, user_enc_key = :ue, user_salt = :us, session_nonce = :sn "
                    "WHERE id = :id"
                ),
                {'id': lic_id, 'kh': key_hash, 'ue': user_enc_key, 'us': user_salt, 'sn': session_nonce},
            )

        # ── Affiliate code indexed column ──────────────────────────────────
        added_aff = _add_column_safe(conn, insp, 'licenses', 'affiliate_code', 'VARCHAR(64)')
        if added_aff:
            # Backfill from JSON metadata
            meta_rows = conn.execute(text(
                "SELECT id, metadata FROM licenses WHERE metadata IS NOT NULL AND metadata != ''"
            )).fetchall()
            for mr in meta_rows:
                try:
                    meta = json.loads(str(mr[1]))
                    aff = str(meta.get('affiliate_code') or '').strip().lower()
                    if aff:
                        conn.execute(
                            text("UPDATE licenses SET affiliate_code = :ac WHERE id = :id"),
                            {'id': int(mr[0]), 'ac': aff},
                        )
                except (json.JSONDecodeError, TypeError, ValueError):
                    pass
            # Create index
            try:
                conn.execute(text(
                    "CREATE INDEX IF NOT EXISTS ix_licenses_affiliate_code ON licenses (affiliate_code)"
                ))
            except Exception:
                pass  # Index may already exist or DB doesn't support IF NOT EXISTS
