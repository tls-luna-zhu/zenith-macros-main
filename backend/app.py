from flask import Flask, request
from werkzeug.middleware.proxy_fix import ProxyFix

from config import Config
from database import init_db


_GH_RELEASE = 'https://github.com/harrisonjonathan05-dev/zenith-releases/releases/download/v1.2.8'

_PRODUCT_DOWNLOAD_REFS = {
    'zenith-single-anchor': f'{_GH_RELEASE}/ZenithSingleAnchor.exe',
    'zenith-safe-anchor':   f'{_GH_RELEASE}/ZenithSafeAnchor.exe',
    'zenith-shield-break':  f'{_GH_RELEASE}/ZenithShieldBreak.exe',
    'zenith-triggerbot':    f'{_GH_RELEASE}/ZenithTriggerbot.exe',
    'zenith-stun-slam':     f'{_GH_RELEASE}/ZenithStunSlam.exe',
    'zenith-pearl-catch':   f'{_GH_RELEASE}/ZenithPearlCatch.exe',
    'zenith-breach-swap':   f'{_GH_RELEASE}/ZenithBreachSwap.exe',
}

# Mace bundle - groups the three mace macros at a discount
_MACE_BUNDLE_ITEMS = 'zenith-stun-slam,zenith-pearl-catch,zenith-breach-swap'


_ALL_PRODUCTS = [
    # Individual macros
    dict(id='zenith-single-anchor', name='Single Anchor',
         description='Place, charge, and explode one anchor in a single keystroke.',
         price_cents=500, badge='SA', sort_order=1),
    dict(id='zenith-safe-anchor', name='Safe Anchor',
         description='Configurable anchor sequence - toggle individual steps on/off.',
         price_cents=500, badge='SA2', sort_order=2),
    dict(id='zenith-shield-break', name='Shield Break',
         description='Instant double-axe click to break shields.',
         price_cents=500, badge='SB', sort_order=3),
    dict(id='zenith-triggerbot', name='Triggerbot',
         description='Auto-clicks when your crosshair turns blue on an enemy.',
         price_cents=1000, badge='TB', sort_order=4),
    dict(id='zenith-stun-slam', name='Stun Slam',
         description='Stun with axe then instantly slam with mace.',
         price_cents=500, badge='SS', sort_order=5),
    dict(id='zenith-pearl-catch', name='Pearl Catch',
         description='Throw pearl and immediately follow with wind charge.',
         price_cents=500, badge='PC', sort_order=6),
    dict(id='zenith-breach-swap', name='Breach Swap',
         description='Mace breach attack then instant sword swap.',
         price_cents=500, badge='BS', sort_order=7),
    # Bundle
    dict(id='zenith-mace-bundle', name='Mace Bundle',
         description='Stun Slam, Pearl Catch, and Breach Swap - all three mace macros at a discount.',
         price_cents=1000, badge='MACE', sort_order=10,
         bundle_items=_MACE_BUNDLE_ITEMS),
]

# Overrides applied after upsert (e.g. to set Stripe price IDs set via admin panel)
_PRODUCT_OVERRIDES = {
    'zenith-triggerbot': {'price_cents': 1000, 'stripe_price_id': 'price_1TJQEL3qVSH8gHeEh0V8uFps'},
}


def _seed_products(app):
    """Ensure all known products exist and have correct download_refs."""
    from database import db
    from models import Product
    with app.app_context():
        # 1. Create any missing products
        try:
            changed = False
            for spec in _ALL_PRODUCTS:
                if not Product.query.get(spec['id']):
                    p = Product(
                        id=spec['id'],
                        name=spec['name'],
                        description=spec.get('description', ''),
                        price_cents=spec['price_cents'],
                        badge=spec.get('badge'),
                        sort_order=spec.get('sort_order', 0),
                        bundle_items=spec.get('bundle_items'),
                        download_ref=_PRODUCT_DOWNLOAD_REFS.get(spec['id']),
                    )
                    db.session.add(p)
                    changed = True
            if changed:
                db.session.commit()
        except Exception:
            db.session.rollback()

        # 2. Backfill / fix download_refs for all known individual products
        try:
            changed = False
            for pid, ref in _PRODUCT_DOWNLOAD_REFS.items():
                p = Product.query.get(pid)
                if p and p.download_ref != ref:
                    p.download_ref = ref
                    changed = True
            if changed:
                db.session.commit()
        except Exception:
            db.session.rollback()

        # 3. Apply overrides (price, Stripe ID, etc.)
        try:
            changed = False
            for pid, overrides in _PRODUCT_OVERRIDES.items():
                p = Product.query.get(pid)
                if p:
                    for field, val in overrides.items():
                        if getattr(p, field, None) != val:
                            setattr(p, field, val)
                            changed = True
            if changed:
                db.session.commit()
        except Exception:
            db.session.rollback()


def create_app():
    Config.validate()
    app = Flask(__name__)
    app.config.from_object(Config)
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_port=1)

    init_db(app)
    _seed_products(app)

    from auth.routes import auth_bp
    from web.routes import web_bp
    from bot.routes import bot_bp
    from admin.routes import admin_bp
    app.register_blueprint(auth_bp)
    app.register_blueprint(web_bp)
    app.register_blueprint(bot_bp)
    app.register_blueprint(admin_bp)

    # CORS: allow website origin for API requests
    _allowed_origins = {
        app.config.get('SITE_URL', 'https://zenithmacros.store').rstrip('/'),
        'https://zenithmacros.store',
        'https://zenith-macros-web.fly.dev',
    }

    @app.after_request
    def apply_security_headers(response):
        origin = request.headers.get('Origin', '')
        if origin in _allowed_origins:
            response.headers['Access-Control-Allow-Origin'] = origin
            response.headers['Access-Control-Allow-Credentials'] = 'true'
            response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
            response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
        response.headers.setdefault('Cache-Control', 'no-store')
        response.headers.setdefault('Pragma', 'no-cache')
        response.headers.setdefault('X-Content-Type-Options', 'nosniff')
        response.headers.setdefault('X-Frame-Options', 'DENY')
        response.headers.setdefault('Referrer-Policy', 'no-referrer')
        if request.is_secure:
            response.headers.setdefault('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
        return response

    return app
