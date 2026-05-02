"""
Seed a test license into the local SQLite database.

Usage (run from the backend/ directory):
    python seed_test.py

The test key printed at the end is what you type into the auth screen.
"""
import os
import sys
import secrets
import hashlib
from datetime import datetime, timezone, timedelta

# Set env vars before importing app modules
os.environ.setdefault('ZENITH_SECRET_KEY', 'fe42c065744dd92c5386f257b778b2074a2e48231fef1cdfff78dfc20534e49d')
from app import create_app
from database import db
from models import License

# ---------------------------------------------------------------------------
# Test license definition
# ---------------------------------------------------------------------------

TEST_KEY = 'ZNTH-TEST-0001-LOCL'   # 20 chars after removing dashes = ZNTHTTEST0001LOCL
NORM_KEY = TEST_KEY.replace('-', '').upper()   # ZNTHTEST0001LOCL

def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()

# ---------------------------------------------------------------------------

app = create_app()

with app.app_context():
    db.create_all()

    existing = License.query.filter_by(key=NORM_KEY).first()
    if existing:
        existing.key_hash = sha256_hex(NORM_KEY)
        existing.user_enc_key = secrets.token_hex(32)
        existing.user_salt = secrets.token_hex(16)
        existing.session_nonce = secrets.token_hex(16)
        existing.hwid_hash = None
        existing.hwid_change_count = 0
        existing.tier = 'lifetime'
        existing.is_revoked = False
        existing.activated_at = None
        existing.last_validated = None
        existing.expires_at = datetime.now(timezone.utc) + timedelta(days=365)
        db.session.commit()

        print('=' * 60)
        print('  Test license reset successfully')
        print('=' * 60)
        print(f'  Key to enter in app : {TEST_KEY}')
        print(f'  Normalized key      : {NORM_KEY}')
        print(f'  Tier                : {existing.tier}')
        print(f'  Expires             : {existing.expires_at.date()}')
        print(f'  DB path             : {app.config["DB_PATH"]}')
        print('  HWID binding        : cleared')
        print('=' * 60)
        sys.exit(0)

    lic = License(
        key=NORM_KEY,
        key_hash=sha256_hex(NORM_KEY),
        user_enc_key=secrets.token_hex(32),   # 32 random bytes = 64 hex chars
        user_salt=secrets.token_hex(16),
        session_nonce=secrets.token_hex(16),
        hwid_hash=None,                        # will be bound on first auth
        hwid_change_count=0,
        tier='lifetime',
        is_revoked=False,
        activated_at=None,
        expires_at=datetime.now(timezone.utc) + timedelta(days=365),
    )
    db.session.add(lic)
    db.session.commit()

    print('=' * 60)
    print('  Test license seeded successfully')
    print('=' * 60)
    print(f'  Key to enter in app : {TEST_KEY}')
    print(f'  Normalized key      : {NORM_KEY}')
    print(f'  Tier                : {lic.tier}')
    print(f'  Expires             : {lic.expires_at.date()}')
    print(f'  DB path             : {app.config["DB_PATH"]}')
    print('=' * 60)
