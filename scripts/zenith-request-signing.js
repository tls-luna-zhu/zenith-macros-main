/**
 * Optional request-signing helper for Zenith admin/store API callers.
 *
 * Backward-compatible with current backend behavior:
 * - You can keep bearer auth only.
 * - Or add signature headers for extra hardening.
 */

const crypto = require('crypto');

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function hmacSha256Hex(secret, input) {
  return crypto.createHmac('sha256', secret).update(input).digest('hex');
}

function randomNonce(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

function canonicalMessage({ timestamp, method, path, bodyHash }) {
  return `${timestamp}.${String(method || 'GET').toUpperCase()}.${path}.${bodyHash}`;
}

/**
 * Build headers for a signed API request.
 *
 * @param {Object} params
 * @param {string} params.token     BOT/STORE API token
 * @param {string} params.method    HTTP method (GET/POST/PATCH...)
 * @param {string} params.path      URL path only (e.g. /v1/admin/licenses)
 * @param {string|Buffer} [params.body=''] Raw request body used on the wire
 * @param {string|number} [params.timestamp] Unix timestamp seconds
 * @param {string} [params.nonce]   Optional nonce (recommended)
 */
function buildZenithAuthHeaders({
  token,
  method,
  path,
  body = '',
  timestamp = Math.floor(Date.now() / 1000),
  nonce = randomNonce(),
}) {
  if (!token || !path) {
    throw new Error('buildZenithAuthHeaders requires token and path');
  }

  const ts = String(timestamp);
  const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const bodyHash = sha256Hex(rawBody);
  const message = canonicalMessage({
    timestamp: ts,
    method: String(method || 'GET'),
    path,
    bodyHash,
  });
  const signature = hmacSha256Hex(token, message);

  return {
    Authorization: `Bearer ${token}`,
    'X-Zenith-Timestamp': ts,
    'X-Zenith-Signature': signature,
    'X-Zenith-Nonce': String(nonce),
  };
}

module.exports = {
  buildZenithAuthHeaders,
  canonicalMessage,
  randomNonce,
};

