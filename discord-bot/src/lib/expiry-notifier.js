'use strict'
const { EmbedBuilder } = require('discord.js')

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000

class ExpiryNotifier {
  /**
   * @param {object} opts
   * @param {object} opts.apiClient - LicenseApiClient instance
   * @param {import('discord.js').Client} opts.discordClient
   * @param {number} [opts.intervalMs=86400000] - check interval (default 24h)
   */
  constructor({ apiClient, discordClient, intervalMs = 86400000 }) {
    this.apiClient = apiClient
    this.discordClient = discordClient
    this.intervalMs = intervalMs
    this._timer = null
    /** @type {Map<string, string>} key -> last notified date (YYYY-MM-DD) */
    this._notified = new Map()
  }

  start() {
    // Run once immediately, then on interval
    this.checkExpiries().catch(err => console.error('[expiry-notifier] initial check failed:', err.message))
    this._timer = setInterval(() => {
      this.checkExpiries().catch(err => console.error('[expiry-notifier] check failed:', err.message))
    }, this.intervalMs)
    console.log(`[expiry-notifier] started (interval=${this.intervalMs}ms)`)
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
      console.log('[expiry-notifier] stopped')
    }
  }

  async checkExpiries() {
    let keys
    try {
      const res = await this.apiClient.get('/api/bot/keys?limit=5000')
      keys = res?.keys || res
      if (!Array.isArray(keys)) {
        console.warn('[expiry-notifier] unexpected API response shape')
        return
      }
    } catch (err) {
      console.error('[expiry-notifier] failed to fetch keys:', err.message)
      return
    }

    const now = Date.now()
    const today = new Date().toISOString().slice(0, 10)

    const expiring = keys.filter(k => {
      if (!k.discord_id || !k.expires_at) return false
      const expiresAt = new Date(k.expires_at).getTime()
      if (isNaN(expiresAt)) return false
      const remaining = expiresAt - now
      return remaining > 0 && remaining <= THREE_DAYS_MS
    })

    let sent = 0
    let skipped = 0

    for (const key of expiring) {
      const cacheKey = key.key || key.id
      if (!cacheKey) continue

      // Skip if already notified today
      if (this._notified.get(cacheKey) === today) {
        skipped++
        continue
      }

      const expiresAt = new Date(key.expires_at)
      const daysLeft = Math.max(1, Math.ceil((expiresAt.getTime() - now) / (24 * 60 * 60 * 1000)))
      const keyPreview = String(cacheKey).slice(0, 8) + '...'

      const embed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle('License Expiry Notice')
        .setDescription(`Your Zenith license expires in **${daysLeft} day${daysLeft !== 1 ? 's' : ''}**.`)
        .addFields(
          { name: 'Key', value: `\`${keyPreview}\``, inline: true },
          { name: 'Expires', value: `<t:${Math.floor(expiresAt.getTime() / 1000)}:F>`, inline: true },
        )
        .setFooter({ text: 'Renew to keep uninterrupted access' })
        .setURL('https://zenithmacros.store')
        .setTimestamp()

      try {
        const user = await this.discordClient.users.fetch(key.discord_id)
        await user.send({ embeds: [embed] })
        this._notified.set(cacheKey, today)
        sent++
      } catch (err) {
        // User has DMs disabled, left the server, or invalid ID — skip silently
        this._notified.set(cacheKey, today)
      }
    }

    if (sent > 0 || skipped > 0) {
      console.log(`[expiry-notifier] sent=${sent} skipped=${skipped} total_expiring=${expiring.length}`)
    }
  }
}

module.exports = { ExpiryNotifier }
