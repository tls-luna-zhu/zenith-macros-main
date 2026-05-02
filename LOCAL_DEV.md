# Local development (marketing site + API)

This workflow keeps everything on your machine. You do **not** need to deploy this repo to your hosting server while the old site stays live elsewhere.

## Which “website” is this?

| Folder | What it is |
|--------|------------|
| **`website/`** | Marketing site (`index.html`, `site.css`, `dashboard.html`, etc.). Serve this folder over **http://** — do **not** open `index.html` via `file://` or styles/scripts may fail. |
| **`renderer/`** | Tauri desktop client UI (run the app, not the browser). |

## What runs where

| Service | Default URL | Purpose |
|--------|-------------|---------|
| Flask API | `http://127.0.0.1:5000` | License API, Discord OAuth, dashboard API routes when proxied |
| Static site | `http://127.0.0.1:8080` | `python -m http.server` from `website/`, or `node serve.js` (default port **4000**) |

## One host name: `127.0.0.1` **or** `localhost` (not both)

Cookies and CORS are origin-specific. Use the **same** host for the site and API everywhere:

- Good: site at `http://127.0.0.1:8080`, API at `http://127.0.0.1:5000`
- Bad: site at `http://localhost:8080` while the API is `http://127.0.0.1:5000` (session cookies will not line up)

If you prefer `localhost`, set `WEB_FRONTEND_ORIGIN`, `WEB_CORS_ORIGINS`, and `ZENITH_API_BASE` (in `website/index.html` or inline) to match `http://localhost:8080` / `http://localhost:5000` consistently.

## 1. Backend environment

Copy the example file and edit secrets:

```text
backend/.env.example  →  backend/.env
```

`backend/config.py` loads `backend/.env` automatically. Required keys are documented in `.env.example`.

Minimum to start the API:

- `ZENITH_SECRET_KEY` — at least 32 characters (Flask session signing)
- `ZENITH_BOT_API_TOKEN` — at least 24 characters
- `ZENITH_STORE_API_TOKEN` — at least 24 characters

For **Flask Discord OAuth** (e.g. if you restore a separate marketing SPA that uses `/oauth/discord/*`), also set:

- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `WEB_OAUTH_REDIRECT_URI` — must match a redirect URL in the Discord app (see below)
- `WEB_FRONTEND_ORIGIN` — where users land after OAuth (default `http://127.0.0.1:8080`)
- `WEB_CORS_ORIGINS` — comma-separated origins allowed to call `/api/web/*` with credentials (include the exact URL you open in the browser)

Optional:

- `SESSION_COOKIE_SECURE=true` — only behind HTTPS in production; leave unset or `false` for plain `http://` local dev

## 2. Install Python dependencies

```powershell
cd backend
python -m pip install -r requirements.txt
```

## 3. Run the API (terminal 1)

From the `backend` folder:

```powershell
cd backend
python -m flask --app "app:create_app" run --host 127.0.0.1 --port 5000 --debug
```

You should see Flask listening on `http://127.0.0.1:5000`.

## 4. Serve the static site (terminal 2)

From the `website` folder:

```powershell
cd website
python -m http.server 8080 --bind 127.0.0.1
```

Open **exactly**: `http://127.0.0.1:8080`

## 5. Discord Developer Portal (optional — web OAuth only)

Only needed if you use the backend’s `/oauth/discord/*` flow with a front-end that redirects there.

1. Open your application → **OAuth2** → **Redirects**.
2. Add e.g. `http://127.0.0.1:5000/oauth/discord/callback` (must match `WEB_OAUTH_REDIRECT_URI`).
3. The redirect URI string must match **character for character** (scheme, host, port, path).

Scopes used by the backend: `identify`, `email` (see `web_oauth.py`).

## 6. Quick checks

- **`website/` preview:** open `http://127.0.0.1:8080` — you should see the **ZenithMacros** client UI (browser preview; no Tauri backend).
- **API / OAuth (if configured):** `GET http://127.0.0.1:5000/api/web/session` with credentials can return session JSON when a Flask web session exists.

## 7. Deploying later

When you move off localhost, set `WEB_FRONTEND_ORIGIN`, `WEB_OAUTH_REDIRECT_URI`, and `WEB_CORS_ORIGINS` to your real HTTPS origins, add the new redirect URL in Discord, and enable `SESSION_COOKIE_SECURE=true` for HTTPS.
