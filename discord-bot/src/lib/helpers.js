'use strict'
const { EmbedBuilder, AttachmentBuilder } = require('discord.js')

/**
 * Shared helper functions for key management, formatting, and embeds.
 */

const clamp = (n, min, max) => Math.max(min, Math.min(max, n))
const escapeRegExp = s => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const fmt = s => String(s || '')
  .replace(/\\n/g, '\n')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/\r\n/g, '\n')
  .trim()
const col = s => /^[0-9a-fA-F]{6}$/.test((s || '').replace('#', '')) ? parseInt((s || '').replace('#', ''), 16) : 0x8b5cf6
const shortSha = s => String(s || '').slice(0, 7)

function parseDurationMs(input) {
  const txt = String(input || '').trim().toLowerCase()
  if (!txt) return 0
  const re = /(\d+)\s*(s|m|h|d|w)/g
  let total = 0
  let match
  while ((match = re.exec(txt))) {
    const n = Number(match[1]) || 0
    const u = match[2]
    if (u === 's') total += n * 1000
    if (u === 'm') total += n * 60000
    if (u === 'h') total += n * 3600000
    if (u === 'd') total += n * 86400000
    if (u === 'w') total += n * 604800000
  }
  return total
}

function prettyDuration(ms) {
  const sec = Math.max(1, Math.floor(ms / 1000))
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const out = []
  if (d) out.push(`${d}d`)
  if (h) out.push(`${h}h`)
  if (m) out.push(`${m}m`)
  if (!d && !h && !m) out.push(`${s}s`)
  return out.join(' ')
}

function safeFieldText(value, fallback = '-') {
  const txt = String(value == null ? '' : value).trim()
  if (!txt) return fallback
  return txt.slice(0, 1024)
}

// ── Key utilities ────────────────────────────────────────────────

function keyAccessOf(k) {
  const raw = String(k?.access || k?.tier || 'monthly').toLowerCase()
  return raw === 'lifetime' ? 'lifetime' : 'monthly'
}

function keyExpired(k) {
  if (!k?.expires_at) return false
  const ts = Date.parse(String(k.expires_at))
  return Number.isFinite(ts) && ts <= Date.now()
}

function keyUsed(k) {
  return !!String(k?.hwid || '').trim() || !!String(k?.activated_at || '').trim()
}

function keyStatus(k) {
  if (!k?.active) return 'inactive'
  if (keyExpired(k)) return 'expired'
  if (keyUsed(k)) return 'used'
  return 'available'
}

function summarizeKey(k, { showNotes = false } = {}) {
  const status = keyStatus(k)
  const access = keyAccessOf(k)
  const expires = k?.expires_at ? String(k.expires_at).slice(0, 10) : 'never'
  const note = String(k?.note || '').trim()
  const notePart = showNotes
    ? ` | note: ${note ? note.replace(/\s+/g, ' ').slice(0, 40) : '-'}`
    : ''
  return `\`${k.key}\` | ${access} | ${status} | exp: ${expires}${notePart}`
}

function keyPreviewHwid(hwid) {
  const txt = String(hwid || '').trim()
  if (!txt) return '-'
  if (txt.length <= 12) return txt
  return `${txt.slice(0, 6)}...${txt.slice(-6)}`
}

function keyInfoEmbed(k, { title = 'License Key' } = {}) {
  const status = keyStatus(k)
  const access = keyAccessOf(k)
  const expires = k?.expires_at || 'Never'
  const created = k?.created_at || '-'
  const activated = k?.activated_at || '-'
  const note = safeFieldText(k?.note || '', '-')
  const email = safeFieldText(k?.email || '', '-')
  const discordId = safeFieldText(k?.discord_id || '', '-')
  return new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle(title)
    .addFields(
      { name: 'Key', value: `\`${safeFieldText(k?.key || '', 'unknown')}\`` },
      { name: 'Status', value: status, inline: true },
      { name: 'Plan', value: access, inline: true },
      { name: 'Active', value: k?.active ? 'Yes' : 'No', inline: true },
      { name: 'Expires', value: safeFieldText(expires), inline: true },
      { name: 'HWID', value: safeFieldText(keyPreviewHwid(k?.hwid || '')), inline: true },
      { name: 'Email', value: email, inline: true },
      { name: 'Discord ID', value: discordId, inline: true },
      { name: 'Created', value: safeFieldText(created), inline: true },
      { name: 'Activated', value: safeFieldText(activated), inline: true },
      { name: 'Note', value: note }
    )
}

// ── Input parsing ────────────────────────────────────────────────

function normalizeClearableText(raw) {
  const txt = String(raw || '').trim()
  if (!txt) return { hasValue: false, value: '' }
  if (['clear', 'none', 'null', '-'].includes(txt.toLowerCase())) {
    return { hasValue: true, value: '' }
  }
  return { hasValue: true, value: txt }
}

function parseToggleText(raw) {
  const txt = String(raw || '').trim().toLowerCase()
  if (!txt) return { ok: true, hasValue: false, value: false }
  if (['1', 'true', 'yes', 'on', 'enable', 'enabled', 'active'].includes(txt)) {
    return { ok: true, hasValue: true, value: true }
  }
  if (['0', 'false', 'no', 'off', 'disable', 'disabled', 'inactive'].includes(txt)) {
    return { ok: true, hasValue: true, value: false }
  }
  return { ok: false, hasValue: false, value: false }
}

function parseDaysText(raw) {
  const txt = String(raw || '').trim().toLowerCase()
  if (!txt) return { ok: true, hasValue: false, clearExpiry: false, days: 0 }
  if (['clear', 'none', 'null', '-'].includes(txt)) {
    return { ok: true, hasValue: true, clearExpiry: true, days: 0 }
  }
  const n = Number(txt)
  if (!Number.isFinite(n) || n < 1) return { ok: false, hasValue: false, clearExpiry: false, days: 0 }
  return { ok: true, hasValue: true, clearExpiry: false, days: clamp(Math.floor(n), 1, 3650) }
}

// ── GitHub embeds ────────────────────────────────────────────────

function commitEmbed(commit, repoName) {
  const sha = shortSha(commit?.sha || '')
  const msg = String(commit?.commit?.message || '').split('\n')[0].slice(0, 200)
  const author = String(commit?.commit?.author?.name || commit?.author?.login || 'unknown')
  const url = String(commit?.html_url || '')
  return new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle(`New Commit — ${repoName}`)
    .setDescription(`[\`${sha}\`](${url}) ${msg}`)
    .addFields({ name: 'Author', value: author, inline: true })
    .setTimestamp(new Date())
}

function releaseEmbed(release, repoName) {
  const tag = String(release?.tag_name || 'unknown')
  const name = String(release?.name || tag)
  const body = String(release?.body || '').slice(0, 1000)
  const url = String(release?.html_url || '')
  return new EmbedBuilder()
    .setColor(0x22c55e)
    .setTitle(`New Release — ${repoName}`)
    .setDescription(`[${name}](${url})\nTag: \`${tag}\`\n\n${body}`)
    .setTimestamp(new Date())
}

// ── Automod utilities ────────────────────────────────────────────

function extractDomainsFromContent(text) {
  const re = /https?:\/\/([\w.-]+)/gi
  const domains = []
  let m
  while ((m = re.exec(text))) {
    domains.push(m[1].toLowerCase())
  }
  return domains
}

function messageCapsRatio(text) {
  const letters = text.replace(/[^a-zA-Z]/g, '')
  if (!letters.length) return 0
  const caps = letters.replace(/[^A-Z]/g, '').length
  return caps / letters.length
}

module.exports = {
  clamp,
  escapeRegExp,
  fmt,
  col,
  shortSha,
  parseDurationMs,
  prettyDuration,
  safeFieldText,
  keyAccessOf,
  keyExpired,
  keyUsed,
  keyStatus,
  summarizeKey,
  keyPreviewHwid,
  keyInfoEmbed,
  normalizeClearableText,
  parseToggleText,
  parseDaysText,
  commitEmbed,
  releaseEmbed,
  extractDomainsFromContent,
  messageCapsRatio,
}
