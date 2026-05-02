# Zenith Staging and Deploy Guard

This file exists to protect the currently live Fly deployment while we validate the new build.

## Hard rule

- Do not run any deployment command from this workspace.
- Do not run `fly deploy`.
- Do not push new release artifacts to production.

## Safe local workflow

1. Run local stack only:
   - `start_zenith_staging.bat`
2. Validate website build:
   - `cd website && npm run build`
3. Validate API syntax:
   - `python -m py_compile API/api.py`
4. Validate desktop compile:
   - `cd src-tauri && cargo check`
5. Validate bot syntax:
   - `node --check discord-bot/src/index.js`

## Payment verification checklist (local)

1. Open `http://localhost:3000/selectpayment?plan=monthly`
2. Open `http://localhost:3000/selectpayment?plan=lifetime`
3. Confirm both pages look/function the same, except plan details.
4. In API config, set plan-specific Stripe envs:
   - `STRIPE_SECRET_KEY_MONTHLY`
   - `STRIPE_PUBLISHABLE_KEY_MONTHLY`
   - `STRIPE_WEBHOOK_SECRET_MONTHLY`
   - `STRIPE_SECRET_KEY_LIFETIME`
   - `STRIPE_PUBLISHABLE_KEY_LIFETIME`
   - `STRIPE_WEBHOOK_SECRET_LIFETIME`
5. Confirm monthly checkout returns monthly publishable key.
6. Confirm lifetime checkout returns lifetime publishable key.

## Discord bot integration checklist (local)

1. Ensure API and bot share the same `BOT_API_SECRET` (or legacy `BOT_API_TOKEN`).
2. Start `discord-bot` locally.
3. Run a key create/list/update/toggle/delete flow via bot commands.
4. Verify API responds on `/api/bot/*` endpoints without auth errors.

## Snapshot before any future release candidate

1. Run:
   - `powershell -ExecutionPolicy Bypass -File scripts/create_safe_snapshot.ps1`
2. Confirm snapshot zip exists in `snapshots/`.
3. Snapshot excludes `.env` and key material by default.

## If you later decide to deploy

1. Freeze a candidate tag/branch first.
2. Run Fly preflight only (no deploy):
   - `powershell -ExecutionPolicy Bypass -File scripts/fly_preflight.ps1 -App zenith-license -Config fly.toml`
3. Confirm preflight has no config drift warnings before deployment.
4. Deploy to a separate staging app/environment, not production.
5. Run one monthly and one lifetime real payment in staging.
6. Verify Discord bot commands in staging.
7. Keep rollback ready to the exact previous production version.
