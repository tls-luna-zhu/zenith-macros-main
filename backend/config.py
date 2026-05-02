import os
from pathlib import Path


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    """Parse an integer env var safely and clamp to a bounded range."""
    raw = os.environ.get(name)
    if raw is None or str(raw).strip() == '':
        return default
    try:
        parsed = int(str(raw).strip())
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, parsed))


def _env_first(*names: str, default: str = '') -> str:
    placeholder_prefixes = (
        'your_',
        'your-',
        'replace_',
        'replace-',
        'change_me',
        'changeme',
        'example_',
    )
    for name in names:
        value = os.environ.get(name)
        if value is None:
            continue
        text = str(value).strip()
        lowered = text.lower()
        if text and not any(lowered.startswith(prefix) for prefix in placeholder_prefixes):
            return text
    return default


def _load_local_env():
    candidates = [
        Path(__file__).resolve().parents[1] / '.env',
        Path(__file__).with_name('.env'),
    ]
    for env_path in candidates:
        if not env_path.exists():
            continue
        for raw_line in env_path.read_text(encoding='utf-8').splitlines():
            line = raw_line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            key = key.strip()
            if not key or key in os.environ:
                continue
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
                value = value[1:-1]
            os.environ[key] = value


_load_local_env()


class Config:
    # [SECURITY HARDENING] Prefer new names but keep legacy env compatibility.
    SECRET_KEY = _env_first('ZENITH_SECRET_KEY', 'DASHBOARD_SESSION_SECRET', 'ADMIN_SECRET')
    BOT_API_TOKEN = _env_first('BOT_API_SECRET', 'ZENITH_BOT_API_TOKEN')
    STORE_API_TOKEN = _env_first('STORE_API_TOKEN', 'ZENITH_STORE_API_TOKEN', 'BOT_API_SECRET')
    # [SECURITY HARDENING] Legacy bot bridge secret for /api/bot/* compatibility.
    BOT_API_SECRET = _env_first('ZENITH_BOT_API_SECRET', 'BOT_API_SECRET', default=BOT_API_TOKEN)
    ADMIN_SECRET   = _env_first('ADMIN_SECRET')

    CHALLENGE_TTL = 60        # seconds
    SESSION_TTL = 86400       # 24 hours
    REFRESH_WINDOW = 3600     # allow refresh up to 1hr after expiry

    # Rate limits
    CHALLENGE_RPM = 10        # challenges per IP per minute
    VERIFY_RPM = 5            # verifies per IP per minute
    GLOBAL_RPM = 60           # total requests per IP per minute

    # Replay protection window (ms)
    REPLAY_WINDOW_MS = 30_000

    # DB: prefer DATABASE_URL (Fly Postgres), fall back to SQLite for local dev.
    _fly_db_url = _env_first('DATABASE_URL')
    if _fly_db_url:
        # Fly Postgres sets postgres:// but SQLAlchemy requires postgresql://
        if _fly_db_url.startswith('postgres://'):
            _fly_db_url = _fly_db_url.replace('postgres://', 'postgresql://', 1)
        SQLALCHEMY_DATABASE_URI = _fly_db_url
    else:
        _default_db_path = '/data/licenses.db' if os.path.isdir('/data') else os.path.join(os.path.expanduser('~'), 'zenith_licenses.db')
        DB_PATH = os.environ.get('ZENITH_DB_PATH', _default_db_path)
        SQLALCHEMY_DATABASE_URI = f'sqlite:///{DB_PATH}'
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    # Keep connections healthy: ping before use and recycle before Fly Postgres
    # kills idle connections (default idle timeout is ~5 min on Fly Postgres).
    if _fly_db_url:
        SQLALCHEMY_ENGINE_OPTIONS = {
            'pool_pre_ping': True,       # test conn before handing it out
            'pool_recycle': 240,         # recycle connections every 4 min
            'pool_size': 5,
            'max_overflow': 10,
            'connect_args': {
                'connect_timeout': 10,
                'options': '-c statement_timeout=30000',  # 30-second query cap
            },
        }
    else:
        SQLALCHEMY_ENGINE_OPTIONS = {
            'pool_pre_ping': True,
        }

    MAX_HWID_CHANGES = 2  # allowed HWID changes before locking (support reset)
    # [SECURITY HARDENING] Bound JSON body size for auth/admin endpoints.
    MAX_JSON_BODY_BYTES = _env_int('ZENITH_MAX_JSON_BODY_BYTES', 16_384, 2_048, 262_144)
    # [SECURITY HARDENING] Independent per-IP caps for admin/store API usage.
    ADMIN_RPM = _env_int('ZENITH_ADMIN_RPM', 120, 10, 2_000)
    STORE_FULFILL_RPM = _env_int('ZENITH_STORE_FULFILL_RPM', 60, 5, 1_000)
    # [SECURITY HARDENING] Optional request-signature replay window (seconds).
    REQUEST_SIG_SKEW_SECONDS = _env_int('ZENITH_REQUEST_SIG_SKEW_SECONDS', 300, 30, 3_600)

    # Website + dashboard compatibility
    SITE_URL = _env_first('SITE_URL', default='https://zenithmacros.store')
    DISCORD_OAUTH_CLIENT_ID = _env_first('ZENITH_DISCORD_OAUTH_CLIENT_ID', 'DISCORD_OAUTH_CLIENT_ID', 'DISCORD_CLIENT_ID')
    DISCORD_OAUTH_CLIENT_SECRET = _env_first('ZENITH_DISCORD_OAUTH_CLIENT_SECRET', 'DISCORD_OAUTH_CLIENT_SECRET', 'DISCORD_CLIENT_SECRET')
    DISCORD_OAUTH_REDIRECT_URI = _env_first(
        'ZENITH_DISCORD_OAUTH_REDIRECT_URI',
        'DISCORD_OAUTH_REDIRECT_URI',
        default=f'{SITE_URL.rstrip("/")}/auth/discord/callback',
    )
    DASHBOARD_SESSION_SECRET = _env_first('ZENITH_DASHBOARD_SESSION_SECRET', 'DASHBOARD_SESSION_SECRET', default=SECRET_KEY)
    DASHBOARD_SESSION_TTL_MS = _env_int('ZENITH_DASHBOARD_SESSION_TTL_MS', 24 * 60 * 60 * 1000, 3_600_000, 2_592_000_000)
    DASHBOARD_COOKIE_NAME = _env_first('ZENITH_DASHBOARD_COOKIE_NAME', default='zenith_dash')
    MONTHLY_PRICE_DISPLAY = _env_int('MONTHLY_PRICE_DISPLAY', 5, 1, 10_000)
    PRICE_3MONTH_DISPLAY = _env_int('PRICE_3MONTH_DISPLAY', 10, 1, 10_000)
    LIFETIME_STANDARD_PRICE = _env_int('LIFETIME_STANDARD_PRICE', 25, 1, 25_000)
    STRIPE_CHECKOUT_LINK_MONTHLY = _env_first('STRIPE_CHECKOUT_LINK_MONTHLY')
    STRIPE_CHECKOUT_LINK_LIFETIME = _env_first('STRIPE_CHECKOUT_LINK_LIFETIME')
    STRIPE_BILLING_PORTAL_URL = _env_first('STRIPE_BILLING_PORTAL_URL')
    STRIPE_SECRET_KEY = _env_first('STRIPE_SECRET_KEY')
    STRIPE_WEBHOOK_SECRET = _env_first('STRIPE_WEBHOOK_SECRET')
    STRIPE_PRICE_MONTHLY = _env_first('STRIPE_PRICE_MONTHLY', 'STRIPE_PRICE_BASIC')
    STRIPE_PRICE_3MONTH = _env_first('STRIPE_PRICE_3MONTH')
    STRIPE_PRICE_LIFETIME = _env_first('STRIPE_PRICE_LIFETIME', 'STRIPE_PRICE_LIFETIME_PROMO', 'STRIPE_PRICE_PRO')
    STRIPE_PUBLISHABLE_KEY = _env_first('STRIPE_PUBLISHABLE_KEY')
    DISCORD_BOT_TOKEN = _env_first('DISCORD_BOT_TOKEN')
    DISCORD_SALE_CHANNEL_ID = _env_first('DISCORD_SALE_CHANNEL_ID', default='1462916669063172158')
    DISCORD_ORDER_WEBHOOK = _env_first('DISCORD_ORDER_WEBHOOK')
    DISCORD_GUILD_ID = _env_first('DISCORD_GUILD_ID')
    DISCORD_CUSTOMER_ROLE_ID = _env_first('DISCORD_CUSTOMER_ROLE_ID')

    SMTP_HOST = _env_first('SMTP_HOST', default='')
    SMTP_PORT = _env_int('SMTP_PORT', 587, 1, 65535)
    SMTP_USER = _env_first('SMTP_USER', default='')
    SMTP_PASS = _env_first('SMTP_PASS', default='')
    EMAIL_FROM = _env_first('EMAIL_FROM', 'SMTP_FROM', 'SMTP_USER', default='')

    # Release distribution (private GitHub-backed brokered downloads)
    GITHUB_RELEASE_REPO = _env_first('GITHUB_RELEASE_REPO', 'GITHUB_PRIVATE_REPO')
    GITHUB_TOKEN = _env_first('GITHUB_TOKEN')
    RELEASE_ASSET_NAME = _env_first('RELEASE_ASSET_NAME')
    DOWNLOAD_URL_TTL_SECONDS = _env_int('DOWNLOAD_URL_TTL_SECONDS', 900, 60, 86_400)

    @classmethod
    def validate(cls):
        secret = str(cls.SECRET_KEY or '').strip()
        if len(secret) < 32 or secret.startswith('CHANGE_THIS_IN_PRODUCTION'):
            raise RuntimeError(
                'ZENITH_SECRET_KEY must be set to a strong value before starting the backend'
            )
        if len(str(cls.BOT_API_TOKEN or '').strip()) < 24:
            raise RuntimeError(
                'ZENITH_BOT_API_TOKEN must be set to a strong value before starting the backend'
            )
        if len(str(cls.STORE_API_TOKEN or '').strip()) < 24:
            raise RuntimeError(
                'ZENITH_STORE_API_TOKEN must be set to a strong value before starting the backend'
            )
        if cls.DASHBOARD_SESSION_SECRET and len(str(cls.DASHBOARD_SESSION_SECRET).strip()) < 24:
            raise RuntimeError(
                'DASHBOARD session secret must be at least 24 chars'
            )

    @classmethod
    def runtime_warnings(cls):
        """Return non-fatal runtime hardening warnings."""
        warnings = []
        if cls.SESSION_TTL < 300:
            warnings.append('SESSION_TTL is very short; this may increase refresh churn')
        if cls.REFRESH_WINDOW > 600:
            warnings.append('REFRESH_WINDOW is high; consider reducing replay tolerance')
        if cls.CHALLENGE_TTL > 180:
            warnings.append('CHALLENGE_TTL is high; shorter challenge windows are safer')
        if cls.CHALLENGE_RPM > 120 or cls.VERIFY_RPM > 60:
            warnings.append('Auth RPM limits are high; consider tighter anti-abuse limits')
        if cls.MAX_JSON_BODY_BYTES > 131_072:
            warnings.append('MAX_JSON_BODY_BYTES is high; consider lowering request size limit')
        if cls.BOT_API_SECRET and len(str(cls.BOT_API_SECRET).strip()) < 24:
            warnings.append('BOT_API_SECRET is short; consider using a stronger secret')
        if not cls.DISCORD_OAUTH_CLIENT_ID or not cls.DISCORD_OAUTH_CLIENT_SECRET:
            warnings.append('Discord OAuth is not configured; dashboard login will be unavailable')
        if not cls.STRIPE_CHECKOUT_LINK_MONTHLY or not cls.STRIPE_CHECKOUT_LINK_LIFETIME:
            warnings.append('Stripe checkout links are not configured; purchase buttons will be disabled')
        if not cls.GITHUB_RELEASE_REPO:
            warnings.append('GITHUB_RELEASE_REPO is not configured; secure release downloads are unavailable')
        if not cls.GITHUB_TOKEN:
            warnings.append('GITHUB_TOKEN is not configured; private release download broker is unavailable')
        return warnings
