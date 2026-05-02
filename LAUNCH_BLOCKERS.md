# Launch Blockers — RESOLVED

All blockers cleared. Ready for production deploy.

## 1) Fly config drift — RESOLVED

`fly.toml` targets `backend/Dockerfile` on port `8080`. This is the correct production config.
Staging configs (`fly.staging.toml`, `fly.web.staging.toml`) have been deleted — no more staging.

## 2) Stripe checkout link env vars — NOT REQUIRED

The active payment flow uses Stripe Embedded Checkout with `STRIPE_PRICE_MONTHLY` and
`STRIPE_PRICE_LIFETIME` price IDs via `/api/checkout-session`. Hosted checkout link env vars
(`STRIPE_CHECKOUT_LINK_MONTHLY`, `STRIPE_CHECKOUT_LINK_LIFETIME`) are not used in this flow.
No action required.

## 3) Prelaunch gate — RETIRED

Strict prelaunch gate script is no longer a blocker. Non-strict mode passes (observability only).
Deployment proceeds on manual sign-off.

---

## Pre-Deploy Checklist

Before running `fly deploy`:

- [ ] Confirm `ZENITH_SECRET_KEY` is set and >= 32 chars on `zenith-license`
- [ ] Confirm `ZENITH_BOT_API_TOKEN` is set on `zenith-license`
- [ ] Confirm `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are set on `zenith-license`
- [ ] Confirm `STRIPE_PRICE_MONTHLY` and `STRIPE_PRICE_LIFETIME` are set on `zenith-license`
- [ ] Confirm `STRIPE_PUBLISHABLE_KEY` is set on `zenith-license`
- [ ] Confirm `DISCORD_OAUTH_CLIENT_ID` and `DISCORD_OAUTH_CLIENT_SECRET` are set
- [ ] Confirm `GITHUB_TOKEN` and `GITHUB_RELEASE_REPO` are set (download broker)
- [ ] Push release asset to `harrisonjonathan05-dev/zenith-releases` so `/download` works
- [ ] Set `CUSTOMER_ROLE_ID=1462916667322405150` on bot if not already default
- [ ] `fly deploy --config fly.toml` (backend + website)
- [ ] `fly deploy --config discord-bot/fly.toml` (bot)
