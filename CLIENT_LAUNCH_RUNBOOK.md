# Client Launch Runbook (No Production Risk)

This runbook is for preparing client launch while protecting the current live app.

## Stage 1: Local readiness gate

Run one command from repo root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/client_prelaunch.ps1 -FlyApp zenith-license -FlyConfig fly.toml
```

For release gating, use strict Fly checks:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/client_prelaunch.ps1 -FlyApp zenith-license -FlyConfig fly.toml -StrictFly
```

Pass criteria:
- API/backend compile checks pass.
- Discord bot and Electron syntax checks pass.
- Website build passes.
- Tauri `cargo check` passes.
- Fly preflight runs and reports current state.

Run deep auth/bot/migration smoke:

```powershell
python scripts/deep_system_smoke.py
```

Deep smoke covers:
- `/v1/auth/challenge` + `/v1/auth/verify` + `/v1/session/refresh`
- `/api/bot/*` key lifecycle and signed auth headers
- Legacy SQLite key import (`backend/migrate_legacy_keys.py`) and post-migration auth acceptance

## Stage 2: Resolve Fly drift before rollout

Current preflight shows drift between local config and live app:
- local Dockerfile: `backend/Dockerfile`
- live Dockerfile: `server/Dockerfile`
- local internal port: `8080`
- live internal port: `3000`

Do not deploy until this is intentional and documented.

## Stage 3: Create isolated Fly staging app

Use the dedicated staging config:

```powershell
fly apps create zenith-license-staging
fly volumes create data --region ord --size 1 --app zenith-license-staging
flyctl config validate -c fly.staging.toml
```

Set required secrets on staging (from your secret manager, not from local files):

```powershell
fly secrets set ZENITH_SECRET_KEY="..." --app zenith-license-staging
fly secrets set ZENITH_BOT_API_TOKEN="..." --app zenith-license-staging
fly secrets set ZENITH_STORE_API_TOKEN="..." --app zenith-license-staging
```

Set recommended feature secrets:
- Discord OAuth IDs/secrets
- Stripe keys/webhook/checkout links
- GitHub release repo/token

## Stage 4: Staging deploy and verification

```powershell
fly deploy -c fly.staging.toml --app zenith-license-staging
fly checks list --app zenith-license-staging
```

Verify:
1. `GET /healthz` is passing.
2. Discord login flow works.
3. Monthly and lifetime checkout both work.
4. Discord bot key operations work against staging API.
5. Tauri/Electron auth challenge/verify/refresh works against staging API.

## Stage 5: Production cutover gate

Only proceed when:
1. Staging is green for at least one full test cycle.
2. Prelaunch script passes again.
3. Rollback target is recorded (current release version from `fly releases`).

## Stage 6: Production deploy window

During controlled window:
1. Run preflight again on production app.
2. Deploy once.
3. Validate health and smoke tests immediately.
4. If smoke fails, rollback immediately to prior release.
