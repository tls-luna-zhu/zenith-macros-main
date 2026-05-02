'use strict'

/**
 * Per-user command cooldown system.
 * Prevents command spam and protects API rate limits.
 */

class CooldownManager {
  constructor() {
    // Map<string, Map<string, number>>  — commandName → userId → timestamp
    this._cooldowns = new Map()
    // Default cooldowns per command category (seconds)
    this._defaults = {
      // Key management commands (API-heavy)
      'key': 3,
      'key create': 5,
      'key list': 5,
      'key info': 2,
      'key update': 3,
      'key extend': 3,
      'key reset': 5,
      'key toggle': 3,
      'key delete': 5,
      'user': 3,
      'user lookup': 3,
      'user grant': 5,
      'user revoke': 5,
      'user hwid_reset': 5,
      'user upgrade': 5,
      'macro': 5,
      'affiliate': 3,
      // Giveaway
      'giveaway create': 10,
      'giveaway end': 5,
      'giveaway reroll': 5,
      // General
      'rating': 30,
      'download': 10,
      'claimkey': 10,
      // Moderation (low cooldown for urgent actions)
      'mod': 2,
      // Ticket
      'ticket_close': 3,
      // Default for anything not listed
      '_default': 2,
    }
  }

  /**
   * Set a custom cooldown for a command.
   * @param {string} command Command name
   * @param {number} seconds Cooldown duration in seconds
   */
  setCooldown(command, seconds) {
    this._defaults[command] = seconds
  }

  /**
   * Check if a user can execute a command. Returns remaining cooldown in seconds, or 0 if allowed.
   * @param {string} userId Discord user ID
   * @param {string} command Command name (e.g. 'key create')
   * @returns {number} Remaining cooldown in seconds (0 = allowed)
   */
  check(userId, command) {
    const now = Date.now()
    const cooldownSec = this._defaults[command] ?? this._defaults['_default'] ?? 2
    const cooldownMs = cooldownSec * 1000

    if (!this._cooldowns.has(command)) {
      this._cooldowns.set(command, new Map())
    }
    const users = this._cooldowns.get(command)
    const lastUsed = users.get(userId) || 0

    if (now - lastUsed < cooldownMs) {
      return Math.ceil((cooldownMs - (now - lastUsed)) / 1000)
    }
    return 0
  }

  /**
   * Record that a user executed a command.
   * @param {string} userId Discord user ID
   * @param {string} command Command name
   */
  record(userId, command) {
    if (!this._cooldowns.has(command)) {
      this._cooldowns.set(command, new Map())
    }
    this._cooldowns.get(command).set(userId, Date.now())
  }

  /**
   * Check and record atomically. Returns remaining cooldown or 0 (and records if allowed).
   */
  checkAndRecord(userId, command) {
    const remaining = this.check(userId, command)
    if (remaining === 0) {
      this.record(userId, command)
    }
    return remaining
  }

  /**
   * Clean up stale entries older than maxAge (default 10 minutes).
   */
  cleanup(maxAgeMs = 600000) {
    const cutoff = Date.now() - maxAgeMs
    for (const [cmd, users] of this._cooldowns) {
      for (const [uid, ts] of users) {
        if (ts < cutoff) users.delete(uid)
      }
      if (users.size === 0) this._cooldowns.delete(cmd)
    }
  }
}

module.exports = { CooldownManager }
