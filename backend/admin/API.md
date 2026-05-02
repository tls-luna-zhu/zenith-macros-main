# Admin and Store API

This backend now exposes token-protected endpoints for Discord bot key management and website purchase fulfillment.

## Required environment variables

- `ZENITH_SECRET_KEY`: backend signing secret (already required).
- `ZENITH_BOT_API_TOKEN`: bearer token used by the Discord bot.
- `ZENITH_STORE_API_TOKEN`: bearer token used by the website/checkout webhook.

## Discord bot endpoints

- `GET /v1/admin/licenses?limit=50&tier=monthly|lifetime&revoked=true|false`
- `POST /v1/admin/licenses`
- `GET /v1/admin/licenses/by-key/<LICENSE>`
- `PATCH /v1/admin/licenses/<ID>`

Auth header (either form is accepted):

- `Authorization: Bearer <ZENITH_BOT_API_TOKEN>`
- `X-API-Token: <ZENITH_BOT_API_TOKEN>`

Optional hardening headers (recommended):

- `X-Zenith-Timestamp: <unix_seconds>`
- `X-Zenith-Signature: <hex_hmac_sha256>`
- `X-Zenith-Nonce: <random_nonce>`

Signature message format:

`<timestamp>.<HTTP_METHOD>.<REQUEST_PATH>.<sha256_hex(raw_body)>`

HMAC secret: the same bot token used in `Authorization`.

### Create key body

```json
{
  "tier": "monthly",
  "days": 30,
  "notes": "Giveaway winner"
}
```

Optional `key` can be supplied to force a specific 20-character key.

### Update key body

```json
{
  "revoked": false,
  "tier": "monthly",
  "extend_days": 30,
  "reset_hwid": false,
  "notes": "Updated by owner"
}
```

## Website fulfillment endpoint

- `POST /v1/store/fulfill`

Auth:

- `Authorization: Bearer <ZENITH_STORE_API_TOKEN>`
- `X-API-Token: <ZENITH_STORE_API_TOKEN>`

Optional hardening headers (recommended, same format as admin endpoints):

- `X-Zenith-Timestamp`
- `X-Zenith-Signature`
- `X-Zenith-Nonce`

Body:

```json
{
  "tier": "monthly",
  "days": 30,
  "email": "buyer@example.com",
  "purchase_id": "stripe_event_or_checkout_id",
  "notes": "checkout"
}
```

`purchase_id` is used for idempotency to avoid issuing duplicate keys for the same purchase.

## Legacy key transfer

Use the migration script to bring old keys into the new auth DB:

```bash
cd backend
python migrate_legacy_keys.py --source C:\path\to\old\licenses.db --dry-run
python migrate_legacy_keys.py --source C:\path\to\old\licenses.db
```

If you need old rows to overwrite same-key rows in the new DB:

```bash
python migrate_legacy_keys.py --source C:\path\to\old\licenses.db --replace-existing
```

## Caller helper (Node.js)

Use the built-in helper script:

- [scripts/zenith-request-signing.js](C:/Users/harri/Desktop/zenith-macros-beta-1.2-20260402-140416/zenith-macros-beta-1.2/scripts/zenith-request-signing.js)

Example:

```js
const { buildZenithAuthHeaders } = require('../scripts/zenith-request-signing');

const body = JSON.stringify({ tier: 'monthly', days: 30 });
const headers = {
  'Content-Type': 'application/json',
  ...buildZenithAuthHeaders({
    token: process.env.ZENITH_BOT_API_TOKEN,
    method: 'POST',
    path: '/v1/admin/licenses',
    body,
  }),
};
```
