'use strict'
const crypto = require('crypto')

/**
 * API client for communicating with the Zenith License backend.
 * Handles HMAC-SHA256 request signing for authentication.
 */

function normalizeApiPath(p) {
  const s = String(p || '').trim()
  if (!s) return '/'
  return s.startsWith('/') ? s : `/${s}`
}

function botPayloadHash(bodyText) {
  return crypto.createHash('sha256').update(String(bodyText || ''), 'utf8').digest('hex')
}

function botRequestSignature(secret, method, apiPath, ts, bodyText) {
  const canonical = [
    String(method || 'GET').toUpperCase(),
    normalizeApiPath(apiPath),
    String(ts),
    botPayloadHash(bodyText)
  ].join('\n')
  return crypto.createHmac('sha256', String(secret || '')).update(canonical, 'utf8').digest('hex')
}

function safeTimingEqual(a, b) {
  const aa = Buffer.from(String(a || ''), 'utf8')
  const bb = Buffer.from(String(b || ''), 'utf8')
  if (aa.length !== bb.length) return false
  try {
    return crypto.timingSafeEqual(aa, bb)
  } catch (_) {
    return false
  }
}

class LicenseApiClient {
  constructor({ licenseApi, botApiSecret, timeoutMs = 8000, maxSkewMs = 300000 }) {
    this.licenseApi = licenseApi
    this.botApiSecret = botApiSecret
    this.timeoutMs = timeoutMs
    this.maxSkewMs = maxSkewMs
    // Simple in-memory cache with TTL
    this._cache = new Map()
  }

  _signedHeaders(method, apiPath, bodyText = '') {
    const ts = Date.now()
    const sig = botRequestSignature(this.botApiSecret, method, apiPath, ts, bodyText)
    return {
      'x-bot-secret': this.botApiSecret,
      'x-bot-ts': String(ts),
      'x-bot-signature': sig
    }
  }

  verifyInboundRequest(req, method, apiPath, bodyText) {
    if (!this.botApiSecret) return false
    const legacySecret = String(req?.headers?.['x-bot-secret'] || '')
    if (legacySecret && safeTimingEqual(legacySecret, this.botApiSecret)) return true

    const tsRaw = String(req?.headers?.['x-bot-ts'] || '').trim()
    const sigRaw = String(req?.headers?.['x-bot-signature'] || '').trim().toLowerCase()
    if (!/^\d{10,16}$/.test(tsRaw) || !/^[a-f0-9]{64}$/.test(sigRaw)) return false

    const ts = Number(tsRaw)
    if (!Number.isFinite(ts)) return false
    if (Math.abs(Date.now() - ts) > this.maxSkewMs) return false

    const expected = botRequestSignature(this.botApiSecret, method, apiPath, tsRaw, bodyText).toLowerCase()
    return safeTimingEqual(sigRaw, expected)
  }

  async get(p) {
    if (!this.botApiSecret) throw new Error('BOT_API_SECRET missing')
    const apiPath = normalizeApiPath(p)
    const r = await fetch(`${this.licenseApi}${apiPath}`, {
      headers: this._signedHeaders('GET', apiPath, ''),
      signal: AbortSignal.timeout(this.timeoutMs)
    })
    if (!r.ok) throw new Error(`License API HTTP ${r.status}`)
    return r.json()
  }

  async post(p, body) {
    if (!this.botApiSecret) throw new Error('BOT_API_SECRET missing')
    const apiPath = normalizeApiPath(p)
    const bodyText = JSON.stringify(body || {})
    const r = await fetch(`${this.licenseApi}${apiPath}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...this._signedHeaders('POST', apiPath, bodyText)
      },
      body: bodyText,
      signal: AbortSignal.timeout(this.timeoutMs)
    })
    if (!r.ok) throw new Error(`License API HTTP ${r.status}`)
    return r.json()
  }

  /**
   * Cached GET — returns cached data if within TTL, otherwise fetches fresh.
   * @param {string} path API path
   * @param {number} ttlMs Cache TTL in milliseconds (default 30s)
   */
  async getCached(path, ttlMs = 30000) {
    const key = normalizeApiPath(path)
    const cached = this._cache.get(key)
    if (cached && Date.now() - cached.ts < ttlMs) {
      return cached.data
    }
    const data = await this.get(path)
    this._cache.set(key, { ts: Date.now(), data })
    return data
  }

  /** Invalidate a cached path */
  invalidateCache(path) {
    this._cache.delete(normalizeApiPath(path))
  }

  /** Invalidate all cache entries */
  clearCache() {
    this._cache.clear()
  }
}

function readRequestBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('payload-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

module.exports = {
  LicenseApiClient,
  readRequestBody,
  normalizeApiPath,
  botRequestSignature,
  safeTimingEqual,
}
