# Zenith Macros Discord Bot

## Environment File

Create `.env` inside this folder by copying `.env.example`.

## How To Get Them

1. `DISCORD_TOKEN`
- Go to [Discord Developer Portal](https://discord.com/developers/applications)
- Open your app -> `Bot` -> `Reset Token` -> copy token

2. `DISCORD_CLIENT_ID`
- Same app -> `General Information` -> copy `Application ID`

3. `DISCORD_GUILD_ID`
- In Discord: `User Settings -> Advanced -> Developer Mode` ON
- Right-click your server -> `Copy Server ID`

4. Channel/Category/Role IDs (`TICKET_CATEGORY_ID`, `TRANSCRIPT_CHANNEL_ID`, `SUPPORT_ROLE_IDS`, `BOT_ADMIN_ROLE_ID`)
- Developer Mode ON
- Right-click channel/category/role -> `Copy ID`

5. License API secrets
- `BOT_API_SECRET`: required for key commands (`/createkey`, `/keys`, `/key_update`, `/key_extend`, `/key_toggle`, etc.) via `/api/bot/*`.
- `BOT_OWNER_USER_ID`: your Discord user ID; only this account can manage keys.
- `ADMIN_SECRET`: optional now (only needed if you still run `/api/admin/*` manually).

## Run

1. `cd discord-bot`
2. `npm install`
3. `npm start`

If startup says missing token/client id, make sure `.env` is in `discord-bot/.env`.

## Features Included

- Custom ticket system with multiple ticket types (buttons)
- Ticket claim / add / remove / rename / priority / close
- Close reason modal
- Ticket transcript export to transcript channel
- Limit open tickets per user
- Staff/admin permission checks
- Utility/mod commands:
  - `/ping`, `/help`, `/serverinfo`, `/userinfo`
  - `/embed`, `/say` (supports `\n` for clean line breaks)
  - `/purge`, `/lockdown`, `/unlock`
- License linkage command:
  - Simple: `/createkey`, `/keys`, `/keyinfo`
  - Advanced: `/license key`, `/key_create`, `/key_update`, `/key_extend`, `/key_reset_hwid`, `/key_toggle`, `/key_delete`
  - Key commands are restricted to `BOT_OWNER_USER_ID` (or guild owner fallback if unset)
  - `/claim_customer_role key` (existing customers can claim the customer role)
- GitHub feed:
  - Bot can post new commits and releases to channels
  - Configure with `/bot_channels`, check with `/bot_config`
- Branding:
  - Auto sets bot name/avatar (`Zenith Macros`)

## Ticket Customization

In `.env`, you can customize:
- `TICKET_TYPES` (JSON array)
- `TICKET_CATEGORY_MAP` (JSON map per type)
- `TICKET_PANEL_TITLE`
- `TICKET_PANEL_DESCRIPTION`
- `MAX_OPEN_TICKETS_PER_USER`
- `SUPPORT_ROLE_IDS` (comma separated)

Example `TICKET_TYPES`:
```json
[{"id":"support","label":"Support","emoji":"🎯"},{"id":"billing","label":"Billing","emoji":"💳"},{"id":"bug","label":"Bug Report","emoji":"🐛"},{"id":"appeal","label":"Ban Appeal","emoji":"⚖️"}]
```
## Backend Compatibility

This bot uses legacy endpoints:
- `/api/bot/*`
- `/api/claim-discord-role`

The new backend in this repo includes a compatibility bridge for those routes.
Set:
- `LICENSE_API_URL` to your backend URL
- `BOT_API_SECRET` to the same secret configured as backend `ZENITH_BOT_API_SECRET` (or `ZENITH_BOT_API_TOKEN` if you use fallback)
