# Fly Deploy (Backend 1.2)

Run commands from this folder (`backend/`).

## 1) Set app name

Edit [fly.toml](./fly.toml) and set:

- `app = "your-fly-app-name"`

## 2) Create app + volume (first deploy only)

```bash
fly apps create your-fly-app-name
fly volumes create zenith_data --region mia --size 1
```

## 3) Set required secrets

```bash
fly secrets set \
  ZENITH_SECRET_KEY="your-strong-secret-32+-chars" \
  ZENITH_BOT_API_TOKEN="your-bot-api-token" \
  ZENITH_STORE_API_TOKEN="your-store-api-token"
```

Optional:

```bash
fly secrets set ZENITH_DB_PATH="/data/zenith_licenses.db"
fly secrets set ZENITH_BOT_API_SECRET="your-bot-api-secret" # optional, falls back to ZENITH_BOT_API_TOKEN
```

Optional hardening:

```bash
# allowed clock skew window for signed admin/store requests (seconds)
fly secrets set ZENITH_REQUEST_SIG_SKEW_SECONDS="300"
```

## 4) Deploy

```bash
fly deploy
```

## 5) Verify

```bash
fly status
fly logs
```

If keys need migration from old DB:

```bash
python migrate_legacy_keys.py --source C:\path\to\old\licenses.db --dry-run
python migrate_legacy_keys.py --source C:\path\to\old\licenses.db
```
