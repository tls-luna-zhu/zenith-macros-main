'use strict'
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const http = require('http')
const crypto = require('crypto')

// Modular imports — extracted from monolith for maintainability
const { LicenseApiClient, readRequestBody: readReqBody } = require('./lib/api')
const { CooldownManager } = require('./lib/cooldowns')
const { ExpiryNotifier } = require('./lib/expiry-notifier')
const cooldowns = new CooldownManager()
// Periodic cleanup of stale cooldown entries
setInterval(() => cooldowns.cleanup(), 300000)
let nativeSecure = {
  available: false,
  normalizeLicenseKey(input) {
    return String(input || '')
  }
}
try {
  nativeSecure = require('../../native/secure-auth')
} catch (_) {}
const {
  ActionRowBuilder, ActivityType, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, EmbedBuilder,
  Events, GatewayIntentBits, ModalBuilder, PermissionsBitField, REST, Routes, SlashCommandBuilder,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  TextInputBuilder, TextInputStyle
} = require('discord.js')

const env = process.env
if (!env.DISCORD_TOKEN || !env.DISCORD_CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in .env')
  process.exit(1)
}
const HEALTH_PORT = Math.max(1, Number(env.HEALTH_PORT || env.PORT || 8080) || 8080)

const CFG = {
  guildId: env.DISCORD_GUILD_ID || '',
  botName: env.BOT_NAME || 'Zenith Macros',
  avatarPath: env.BOT_AVATAR_PATH || '../website/og-preview.jpg',
  ticketCategory: env.TICKET_CATEGORY_ID || '',
  ratingsChannel: env.RATINGS_CHANNEL_ID || '1462916669252046993',
  ticketMaxOpen: Math.max(1, Number(env.MAX_OPEN_TICKETS_PER_USER || 2)),
  welcomeChannelId: env.WELCOME_CHANNEL_ID || '1462916669063172163',
  adminRole: env.BOT_ADMIN_ROLE_ID || '',
  ownerUserId: env.BOT_OWNER_USER_ID || env.DISCORD_OWNER_USER_ID || '',
  supportRoles: String(env.SUPPORT_ROLE_IDS || env.SUPPORT_ROLE_ID || '').split(',').map(s => s.trim()).filter(Boolean),
  panelTitle: env.TICKET_PANEL_TITLE || 'Zenith Macros Support',
  panelDescription: env.TICKET_PANEL_DESCRIPTION || 'Choose a ticket type and our team will help you.',
  licenseApi: (env.LICENSE_API_URL || 'https://zenith-license.fly.dev').replace(/\/+$/, ''),
  adminSecret: env.ADMIN_SECRET || '',
  botApiSecret: env.BOT_API_SECRET || '',
  githubToken: env.GITHUB_TOKEN || '',
  privateRepo: env.GITHUB_PRIVATE_REPO || 'harrisonjonathan05-dev/zenith-macros',
  releaseRepo: env.GITHUB_RELEASE_REPO || 'harrisonjonathan05-dev/zenith-releases',
  customerRoleId: env.CUSTOMER_ROLE_ID || '1462916667322405150',
  macroPresetChannel: env.MACRO_PRESET_CHANNEL_ID || '1482499122278826176',
  commitsChannel: env.COMMITS_CHANNEL_ID || '',
  releasesChannel: env.RELEASES_CHANNEL_ID || '',
  transcriptsChannel: env.TRANSCRIPTS_CHANNEL_ID || env.TRANSCRIPT_CHANNEL_ID || '',
  pollMs: Math.max(60000, Number(env.NOTIFY_POLL_MS || 180000)),
  giveawayPollMs: Math.max(15000, Number(env.GIVEAWAY_POLL_MS || 30000)),
  automodDefaultTimeoutMins: Math.max(1, Number(env.AUTOMOD_TIMEOUT_MINS || 10)),
  automodAllowedDomains: String(env.AUTOMOD_ALLOWED_DOMAINS || 'zenithmacros.store,discord.com,discord.gg')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  ticketTypes: (() => {
    try { return JSON.parse(env.TICKET_TYPES || '[]') } catch { return [] }
  })(),
  ticketCatMap: (() => {
    try { return JSON.parse(env.TICKET_CATEGORY_MAP || '{}') } catch { return {} }
  })()
}
if (!CFG.ticketTypes.length) CFG.ticketTypes = [
  { id: 'paypal', label: 'PayPal Purchase', emoji: '💸' },
  { id: 'donutsmp', label: 'DonutSMP Pay', emoji: '🍩' },
  { id: 'bug', label: 'Bug Report', emoji: '🐛' },
  { id: 'account', label: 'Account Issues', emoji: '👤' },
  { id: 'refund', label: 'Refund', emoji: '💰' },
  { id: 'media', label: 'Media Application', emoji: '🎬' }
]
if (!CFG.ownerUserId) {
  console.warn('[security] BOT_OWNER_USER_ID not set; key commands will use guild-owner/admin fallback')
}

// Initialize API client with caching support
const apiClient = new LicenseApiClient({
  licenseApi: CFG.licenseApi,
  botApiSecret: CFG.botApiSecret,
  timeoutMs: Math.max(3000, Number(env.LICENSE_API_TIMEOUT_MS || 8000) || 8000),
  maxSkewMs: Math.max(60000, Number(env.BOT_SIGNED_MAX_SKEW_MS || 300000) || 300000),
})

// Moderation audit log channel ID (set via /bot_channels)
let modLogChannelId = ''

const DATA_DIR = path.resolve(__dirname, '../data')
const STATE_PATH = path.join(DATA_DIR, 'state.json')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
let state = {
  channels: {
    commits: CFG.commitsChannel,
    releases: CFG.releasesChannel,
    transcripts: CFG.transcriptsChannel
  },
  watchers: { commit: '', release: '' },
  botAccessUserIds: [],
  memberCountVc: {},
  giveaways: {},
  tickets: {},
  automod: {
    enabled: false,
    logChannelId: '',
    allowedDomains: [...CFG.automodAllowedDomains],
    rules: {
      links: 'off',
      invites: 'off',
      badwords: 'off',
      caps: 'off',
      spam: 'off'
    },
    badWords: [],
    maxMentions: 6,
    capsThreshold: 0.78,
    capsMinLength: 10,
    spamMaxMessages: 6,
    spamWindowSec: 8,
    timeoutMinutes: CFG.automodDefaultTimeoutMins
  }
}
try {
  if (fs.existsSync(STATE_PATH)) {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
    state = {
      ...state,
      ...parsed,
      channels: {
        commits: CFG.commitsChannel || parsed?.channels?.commits || state.channels.commits || '',
        releases: CFG.releasesChannel || parsed?.channels?.releases || state.channels.releases || '',
        transcripts: CFG.transcriptsChannel || parsed?.channels?.transcripts || state.channels.transcripts || ''
      },
      watchers: {
        commit: parsed?.watchers?.commit || '',
        release: parsed?.watchers?.release || ''
      },
      botAccessUserIds: Array.isArray(parsed?.botAccessUserIds) ? parsed.botAccessUserIds : [],
      memberCountVc: parsed?.memberCountVc && typeof parsed.memberCountVc === 'object' ? parsed.memberCountVc : {},
      giveaways: parsed?.giveaways || {},
      tickets: parsed?.tickets || {},
      automod: {
        ...state.automod,
        ...(parsed?.automod || {}),
        rules: {
          ...state.automod.rules,
          ...(parsed?.automod?.rules || {})
        },
        badWords: Array.isArray(parsed?.automod?.badWords) ? parsed.automod.badWords : [],
        allowedDomains: Array.isArray(parsed?.automod?.allowedDomains) && parsed.automod.allowedDomains.length
          ? parsed.automod.allowedDomains
          : [...state.automod.allowedDomains]
      }
    }
  }
} catch {}
if (!Array.isArray(state.botAccessUserIds)) state.botAccessUserIds = []
state.botAccessUserIds = [...new Set(state.botAccessUserIds.map(id => String(id || '').trim()).filter(Boolean))]
if (!state.memberCountVc || typeof state.memberCountVc !== 'object') state.memberCountVc = {}
if (!state.giveaways || typeof state.giveaways !== 'object') state.giveaways = {}
if (!state.tickets || typeof state.tickets !== 'object') state.tickets = {}
if (!state.automod || typeof state.automod !== 'object') state.automod = {
  enabled: false,
  logChannelId: '',
  allowedDomains: [...CFG.automodAllowedDomains],
  rules: { links: 'off', invites: 'off', badwords: 'off', caps: 'off', spam: 'off' },
  badWords: [],
  maxMentions: 6,
  capsThreshold: 0.78,
  capsMinLength: 10,
  spamMaxMessages: 6,
  spamWindowSec: 8,
  timeoutMinutes: CFG.automodDefaultTimeoutMins
}
if (!Array.isArray(state.automod.allowedDomains) || !state.automod.allowedDomains.length) {
  state.automod.allowedDomains = [...CFG.automodAllowedDomains]
}
state.automod.allowedDomains = [...new Set(state.automod.allowedDomains.map(d => String(d || '').trim().toLowerCase()).filter(Boolean))]
for (const rule of ['links', 'invites', 'badwords', 'caps', 'spam']) {
  if (!['off', 'delete', 'timeout'].includes(state.automod.rules?.[rule])) {
    state.automod.rules[rule] = 'off'
  }
}
const saveState = () => fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))

const normalizeDiscordId = (raw) => String(raw || '').trim().replace(/[^\d]/g, '')
const normalizeMemberCountLabel = (raw) => {
  const txt = String(raw || '').trim().replace(/\s+/g, ' ')
  if (!txt) return 'Members'
  return txt.slice(0, 32)
}
const getMemberCountCfg = (guildId) => {
  const gid = String(guildId || '').trim()
  if (!gid) return { channelId: '', label: 'Members' }
  if (!state.memberCountVc[gid] || typeof state.memberCountVc[gid] !== 'object') {
    state.memberCountVc[gid] = { channelId: '', label: 'Members' }
  }
  const cfg = state.memberCountVc[gid]
  cfg.channelId = String(cfg.channelId || '').trim()
  cfg.label = normalizeMemberCountLabel(cfg.label || 'Members')
  return cfg
}

async function updateMemberCountVoiceChannel(guild, { force = false } = {}) {
  try {
    if (!guild?.id) return
    const cfg = getMemberCountCfg(guild.id)
    if (!cfg.channelId) return
    const channel = await guild.channels.fetch(cfg.channelId).catch(() => null)
    if (!channel || ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type)) {
      delete state.memberCountVc[guild.id]
      saveState()
      return
    }
    const nextName = `${cfg.label}: ${Number(guild.memberCount || 0)}`
    if (!force && String(channel.name || '') === nextName) return
    await channel.setName(nextName).catch(() => {})
  } catch (_) {}
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildModeration,
  ]
})
client.on('error', err => {
  console.error('[discord] client error:', err)
})
client.on('shardError', err => {
  console.error('[discord] shard error:', err?.message || err)
})

const isAdmin = m => m && (m.permissions.has(PermissionsBitField.Flags.Administrator) || (CFG.adminRole && m.roles.cache.has(CFG.adminRole)))
const hasSupport = m => m && CFG.supportRoles.some(r => m.roles.cache.has(r))
const isBotOwnerUser = inter => {
  if (!inter?.user?.id) return false
  if (CFG.ownerUserId) return inter.user.id === CFG.ownerUserId
  const guildOwnerId = inter?.guild?.ownerId || ''
  if (guildOwnerId) return inter.user.id === guildOwnerId
  return isAdmin(inter?.member)
}
const hasBotAccessUser = userId => {
  const uid = normalizeDiscordId(userId)
  if (!uid) return false
  return state.botAccessUserIds.includes(uid)
}
// Hardcoded dev/owner IDs that always have full key manager access
const DEV_USER_IDS = [
  '1292582729040396351',
  ...String(env.DEV_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
]

const isKeyManagerUser = inter => {
  if (!inter?.user?.id) return false
  if (isBotOwnerUser(inter)) return true
  if (hasBotAccessUser(inter.user.id)) return true
  if (DEV_USER_IDS.includes(inter.user.id)) return true
  return false
}
const isTicket = ch => ch && ch.type === ChannelType.GuildText && String(ch.topic || '').startsWith('ticket:')
const parseTicket = ch => {
  const p = String(ch?.topic || '').split(':')
  return { uid: p[1] || '', type: p[2] || 'support', owner: p[3] || '', prio: p[4] || 'normal' }
}
const ticketTopic = t => `ticket:${t.uid}:${t.type}:${t.owner || ''}:${t.prio || 'normal'}`
const canTicket = (m, ch) => {
  const t = parseTicket(ch)
  return isAdmin(m) || hasSupport(m) || t.uid === m.id || t.owner === m.id
}
const normKey = k => {
  const raw = String(k || '').trim()
  const compact = raw
    .toUpperCase()
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[^A-Z0-9-]/g, '')
    .replace(/-/g, '')
  if (nativeSecure.available) {
    try {
      const out = String(nativeSecure.normalizeLicenseKey(raw) || '')
      if (out) {
        const nativeCompact = out
          .toUpperCase()
          .replace(/[\u2010-\u2015]/g, '-')
          .replace(/[^A-Z0-9-]/g, '')
          .replace(/-/g, '')
        if (nativeCompact.startsWith('ZNTH') && nativeCompact.length >= 16 && nativeCompact.length <= 20 && nativeCompact.length % 4 === 0) {
          const groups = []
          for (let i = 0; i < nativeCompact.length; i += 4) groups.push(nativeCompact.slice(i, i + 4))
          return groups.join('-')
        }
        if (nativeCompact) return nativeCompact
      }
    } catch (_) {}
  }
  if (compact.startsWith('ZNTH') && compact.length >= 16 && compact.length <= 20 && compact.length % 4 === 0) {
    const groups = []
    for (let i = 0; i < compact.length; i += 4) groups.push(compact.slice(i, i + 4))
    return groups.join('-')
  }
  return compact
}
const col = s => /^[0-9a-fA-F]{6}$/.test((s || '').replace('#', '')) ? parseInt((s || '').replace('#', ''), 16) : 0x8b5cf6
const fmt = s => String(s || '')
  .replace(/\\n/g, '\n')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/\r\n/g, '\n')
  .trim()
const shortSha = s => String(s || '').slice(0, 7)
const spamTracker = new Map()
const inviteCodeCache = new Map()

const clamp = (n, min, max) => Math.max(min, Math.min(max, n))
const escapeRegExp = s => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const automodActionChoices = ['off', 'delete', 'timeout']
const LICENSE_API_TIMEOUT_MS = Math.max(3000, Number(env.LICENSE_API_TIMEOUT_MS || 8000) || 8000)
const BOT_SIGNED_MAX_SKEW_MS = Math.max(60000, Number(env.BOT_SIGNED_MAX_SKEW_MS || 300000) || 300000)

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

function safeFieldText(value, fallback = '-') {
  const txt = String(value == null ? '' : value).trim()
  if (!txt) return fallback
  return txt.slice(0, 1024)
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

async function lookupKeyByInput(rawKey) {
  const keys = await botApiGet('/api/bot/keys')
  const want = normKey(rawKey)
  const found = keys.find(k => normKey(k?.key) === want) || null
  return { keys, found, want }
}

async function buildKeyListReplyPayload({ view = 'available', accessFilter = 'any', limitOpt = null, showNotes = false } = {}) {
  const keys = await botApiGet('/api/bot/keys')
  const totals = { available: 0, used: 0, inactive: 0, expired: 0, active: 0 }
  for (const k of keys) {
    const status = keyStatus(k)
    if (Object.prototype.hasOwnProperty.call(totals, status)) totals[status] += 1
    if (k?.active && !keyExpired(k)) totals.active += 1
  }

  const filtered = keys.filter((k) => {
    const access = keyAccessOf(k)
    if (accessFilter !== 'any' && access !== accessFilter) return false
    if (view === 'all') return true
    if (view === 'active') return !!k?.active && !keyExpired(k)
    return keyStatus(k) === view
  })

  if (!filtered.length) {
    return { content: `No keys found for view=\`${view}\` and access=\`${accessFilter}\`.` }
  }

  const maxItems = limitOpt == null ? clamp(filtered.length, 1, 5000) : clamp(limitOpt, 1, 200)
  const shown = filtered.slice(0, maxItems)
  const lines = shown.map((k, i) => `${i + 1}. ${summarizeKey(k, { showNotes })}`)
  const allText = lines.join('\n')
  const description = allText.length > 3900
    ? `${lines.slice(0, 25).join('\n')}\n...`
    : allText
  const e = new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle('License Keys')
    .setDescription(description.slice(0, 3900))
    .addFields(
      { name: 'Filter', value: `view: \`${view}\`\naccess: \`${accessFilter}\``, inline: true },
      { name: 'Showing', value: `${shown.length} of ${filtered.length}`, inline: true },
      { name: 'Totals', value: `available: ${totals.available}\nused: ${totals.used}\nactive: ${totals.active}\ninactive: ${totals.inactive}\nexpired: ${totals.expired}`, inline: true }
    )
  if (showNotes) {
    e.addFields({ name: 'Notes', value: 'Included in list output', inline: true })
  }
  if (limitOpt == null && filtered.length > maxItems) {
    e.addFields({ name: 'Note', value: `Output capped at ${maxItems} keys. Use \`/keys limit:200\` or \`/key list\` to page through.` })
  }
  if (allText.length > 3900) {
    const attachment = new AttachmentBuilder(
      Buffer.from(allText, 'utf8'),
      { name: `keys-${view}-${accessFilter}.txt` }
    )
    return { embeds: [e], files: [attachment] }
  }
  return { embeds: [e] }
}

function keyPanelEmbed() {
  return new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle('License Key Control Panel')
    .setDescription([
      'Use the buttons below to manage keys directly from Discord.',
      '',
      'This panel supports create, lookup, list, update, extend, reset HWID, toggle, delete, and note management.'
    ].join('\n'))
    .setFooter({ text: 'Owner-only key management' })
    .setTimestamp(new Date())
}

function keyPanelRows() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('keypanel:create').setLabel('Create').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('keypanel:lookup').setLabel('Lookup').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('keypanel:list').setLabel('List').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('keypanel:update').setLabel('Update').setStyle(ButtonStyle.Primary)
  )
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('keypanel:extend').setLabel('Extend').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('keypanel:reset').setLabel('Reset HWID').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('keypanel:toggle').setLabel('Toggle').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('keypanel:delete').setLabel('Delete').setStyle(ButtonStyle.Danger)
  )
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('keypanel:note').setLabel('Notes').setStyle(ButtonStyle.Secondary)
  )
  return [row1, row2, row3]
}

function macroPresetEmbed({ macroName, code, password, note = '', publisher = '' } = {}) {
  const title = safeFieldText(macroName || 'Macro Preset', 'Macro Preset')
  const cleanNote = safeFieldText(note || '', '')
  const who = safeFieldText(publisher || '', '')
  const fields = [
    { name: 'Preset Code', value: `\`${safeFieldText(code || '', 'missing')}\`` },
    { name: 'Password', value: `\`${safeFieldText(password || '', 'missing')}\``, inline: true }
  ]
  if (who) fields.push({ name: 'Publisher', value: who, inline: true })
  if (cleanNote) fields.push({ name: 'Note', value: cleanNote })
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`Macro Studio Preset - ${title}`)
    .setDescription('Import this in Zenith Macro Studio using the preset code and password.')
    .addFields(fields)
    .setFooter({ text: 'Zenith Macro Studio via Discord Bot' })
    .setTimestamp(new Date())
}

async function sendMacroPresetToChannel({ channelId, macroName, code, password, note = '', publisher = '' } = {}) {
  const targetId = String(channelId || CFG.macroPresetChannel || '').trim()
  if (!targetId) throw new Error('macro-preset-channel-missing')
  const channel = await client.channels.fetch(targetId).catch(() => null)
  if (!channel || channel.type !== ChannelType.GuildText) throw new Error('macro-preset-channel-invalid')

  const embed = macroPresetEmbed({ macroName, code, password, note, publisher })
  const sent = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } })
  return { channelId: channel.id, messageId: sent.id }
}

function ticketMeta(chId) {
  if (!state.tickets[chId]) {
    state.tickets[chId] = { createdAt: Date.now(), claimedBy: '', status: 'open', urgent: false, notes: [], typeMoves: 0, lastUpdatedAt: Date.now() }
  }
  const t = state.tickets[chId]
  if (!Array.isArray(t.notes)) t.notes = []
  if (typeof t.status !== 'string' || !t.status) t.status = 'open'
  if (typeof t.urgent !== 'boolean') t.urgent = false
  if (typeof t.typeMoves !== 'number') t.typeMoves = 0
  if (typeof t.lastUpdatedAt !== 'number') t.lastUpdatedAt = Date.now()
  if (typeof t.claimedBy !== 'string') t.claimedBy = ''
  return t
}

async function getInviteCountForUser(guild, userId) {
  try {
    const invites = await guild.invites.fetch()
    let total = 0
    invites.forEach(inv => {
      if (inv?.inviter?.id === userId) total += Number(inv.uses || 0)
      inviteCodeCache.set(`${guild.id}:${inv.code}`, Number(inv.uses || 0))
    })
    return total
  } catch {
    return -1
  }
}

const normalizeDomain = raw => String(raw || '')
  .toLowerCase()
  .replace(/^https?:\/\//, '')
  .replace(/^www\./, '')
  .split('/')[0]
  .split('?')[0]
  .trim()

const matchesAllowedDomain = (domain, allowedDomains) => {
  if (!domain) return true
  return allowedDomains.some(allowed => domain === allowed || domain.endsWith(`.${allowed}`))
}

function extractDomainsFromContent(content) {
  const text = String(content || '')
  const urlTokens = text.match(/https?:\/\/[^\s<>()]+/gi) || []
  const domainTokens = text.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>()]*)?/gi) || []
  const tokens = [...urlTokens, ...domainTokens]
  const out = []
  for (const token of tokens) {
    const domain = normalizeDomain(token)
    if (domain) out.push(domain)
  }
  return [...new Set(out)]
}

function messageCapsRatio(content) {
  const letters = String(content || '').match(/[a-z]/gi) || []
  if (!letters.length) return { ratio: 0, count: 0 }
  const upper = letters.filter(ch => ch === ch.toUpperCase()).length
  return { ratio: upper / letters.length, count: letters.length }
}

function commitEmbed(commit, repo, firstSeen = false) {
  const msg = String(commit?.commit?.message || 'Commit').trim()
  const titleLine = msg.split('\n')[0].slice(0, 220)
  const author = commit?.commit?.author?.name || commit?.author?.login || 'Unknown'
  const sha = shortSha(commit?.sha)
  return new EmbedBuilder()
    .setColor(0x22c55e)
    .setAuthor({ name: firstSeen ? 'Latest Commit Synced' : 'New Push Detected' })
    .setTitle(titleLine || 'Repository update')
    .setURL(commit?.html_url || null)
    .setDescription([
      `Repository: \`${repo}\``,
      `Commit: \`${sha}\` by **${author}**`
    ].join('\n'))
    .setTimestamp(new Date(commit?.commit?.author?.date || Date.now()))
}

function releaseEmbed(rel, repo, firstSeen = false) {
  const body = fmt(rel?.body || '')
  const desc = body ? body.slice(0, 800) : 'New release is now available.'
  return new EmbedBuilder()
    .setColor(0x3b82f6)
    .setAuthor({ name: firstSeen ? 'Latest Release Synced' : 'New Release Published' })
    .setTitle(rel?.name || rel?.tag_name || 'Release')
    .setURL(rel?.html_url || null)
    .setDescription([
      `Repository: \`${repo}\``,
      '',
      desc
    ].join('\n'))
    .setTimestamp(new Date(rel?.published_at || rel?.created_at || Date.now()))
}

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

function verifyBotRequestAuth(req, method, apiPath, bodyText) {
  if (!CFG.botApiSecret) return false
  const legacySecret = String(req?.headers?.['x-bot-secret'] || '')
  if (legacySecret && safeTimingEqual(legacySecret, CFG.botApiSecret)) return true

  const tsRaw = String(req?.headers?.['x-bot-ts'] || '').trim()
  const sigRaw = String(req?.headers?.['x-bot-signature'] || '').trim().toLowerCase()
  if (!/^\d{10,16}$/.test(tsRaw) || !/^[a-f0-9]{64}$/.test(sigRaw)) return false

  const ts = Number(tsRaw)
  if (!Number.isFinite(ts)) return false
  if (Math.abs(Date.now() - ts) > BOT_SIGNED_MAX_SKEW_MS) return false

  const expected = botRequestSignature(CFG.botApiSecret, method, apiPath, tsRaw, bodyText).toLowerCase()
  return safeTimingEqual(sigRaw, expected)
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

function botSignedHeaders(method, apiPath, bodyText = '') {
  const ts = Date.now()
  const sig = botRequestSignature(CFG.botApiSecret, method, apiPath, ts, bodyText)
  return {
    'x-bot-secret': CFG.botApiSecret, // legacy compatibility while signed auth rolls out
    'x-bot-ts': String(ts),
    'x-bot-signature': sig
  }
}

async function botApiGet(p) {
  if (!CFG.botApiSecret) throw new Error('BOT_API_SECRET missing')
  const apiPath = normalizeApiPath(p)
  const r = await fetch(`${CFG.licenseApi}${apiPath}`, {
    headers: botSignedHeaders('GET', apiPath, ''),
    signal: AbortSignal.timeout(LICENSE_API_TIMEOUT_MS)
  })
  if (!r.ok) throw new Error(`License API HTTP ${r.status}`)
  return r.json()
}

async function botApiPost(p, body) {
  if (!CFG.botApiSecret) throw new Error('BOT_API_SECRET missing')
  const apiPath = normalizeApiPath(p)
  const bodyText = JSON.stringify(body || {})
  const r = await fetch(`${CFG.licenseApi}${apiPath}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...botSignedHeaders('POST', apiPath, bodyText)
    },
    body: bodyText,
    signal: AbortSignal.timeout(LICENSE_API_TIMEOUT_MS)
  })
  if (!r.ok) throw new Error(`License API HTTP ${r.status}`)
  return r.json()
}

async function createKeyWithFallback(payload) {
  return botApiPost('/api/bot/key-create', payload)
}

function giveawayEmbed(g, ended = false) {
  const participants = Array.isArray(g.participants) ? g.participants.length : 0
  const endTs = Math.floor(Number(g.endsAt || Date.now()) / 1000)
  const rewardText = g.reward?.enabled
    ? `License reward: **${g.reward.access}**${g.reward.access === 'monthly' ? ` (${g.reward.days}d)` : ''}`
    : 'No automatic license key reward'
  return new EmbedBuilder()
    .setColor(ended ? 0x22c55e : 0xf59e0b)
    .setAuthor({ name: ended ? 'Giveaway Ended' : 'Live Giveaway' })
    .setTitle(g.title || 'Zenith Giveaway')
    .setDescription(g.description || 'Join now for a chance to win.')
    .addFields(
      { name: 'Prize', value: g.prize || 'Mystery prize' },
      { name: 'Giveaway ID', value: `\`${g.id}\``, inline: true },
      { name: 'Winners', value: String(g.winnerCount || 1), inline: true },
      { name: 'Entries', value: String(participants), inline: true },
      { name: 'Invite Requirement', value: g.minInvites > 0 ? `${g.minInvites}+ invites` : 'None', inline: true },
      { name: 'Ends', value: ended ? `<t:${endTs}:F>` : `<t:${endTs}:R>` },
      { name: 'Reward', value: rewardText }
    )
    .setFooter({ text: `Hosted by ${g.hostTag || g.hostId}` })
    .setTimestamp(new Date())
}

function giveawayButtons(g, ended = false) {
  const row = new ActionRowBuilder()
  if (!ended) {
    row.addComponents(
      new ButtonBuilder().setCustomId(`giveaway:join:${g.id}`).setLabel('Join Giveaway').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`giveaway:leave:${g.id}`).setLabel('Leave').setStyle(ButtonStyle.Secondary)
    )
  } else {
    row.addComponents(
      new ButtonBuilder().setCustomId(`giveaway:reroll:${g.id}`).setLabel('Reroll').setStyle(ButtonStyle.Primary)
    )
  }
  return [row]
}

async function rewardWinner(giveaway, winnerId, index) {
  if (!giveaway.reward?.enabled) return { ok: true, key: '', expiresAt: null }
  const access = giveaway.reward.access === 'lifetime' ? 'lifetime' : 'monthly'
  const days = clamp(Number(giveaway.reward.days || 30), 1, 3650)
  const expiresAt = access === 'lifetime' ? null : new Date(Date.now() + days * 86400000).toISOString()
  const note = `${giveaway.reward.note || 'giveaway'}#${giveaway.id}:winner${index + 1}:${winnerId}`
  const created = await createKeyWithFallback({ access, expiresAt, note })
  return {
    ok: true,
    key: created.key,
    expiresAt
  }
}

async function getGiveawayContext(giveaway) {
  const guild = await client.guilds.fetch(giveaway.guildId).catch(() => null)
  const channel = guild ? await guild.channels.fetch(giveaway.channelId).catch(() => null) : null
  if (!guild || !channel || channel.type !== ChannelType.GuildText) return { guild: null, channel: null, message: null }
  const message = giveaway.messageId ? await channel.messages.fetch(giveaway.messageId).catch(() => null) : null
  return { guild, channel, message }
}

async function collectEligibleGiveawayEntries(giveaway, guild, excludedIds = []) {
  const allParticipants = Array.isArray(giveaway.participants) ? [...new Set(giveaway.participants)] : []
  const excluded = new Set(excludedIds.filter(Boolean))
  const eligible = []
  for (const uid of allParticipants) {
    if (excluded.has(uid)) continue
    const member = await guild.members.fetch(uid).catch(() => null)
    if (!member) continue
    if (giveaway.minInvites > 0) {
      const count = await getInviteCountForUser(guild, uid)
      if (count < giveaway.minInvites) continue
    }
    eligible.push(uid)
  }
  return eligible
}

async function deliverGiveawayRewards(giveaway, winners, reroll = false) {
  const rewardResults = []
  for (let i = 0; i < winners.length; i++) {
    const uid = winners[i]
    try {
      const reward = await rewardWinner(giveaway, uid, i)
      rewardResults.push({ uid, ...reward })
      const user = await client.users.fetch(uid).catch(() => null)
      if (user) {
        const dm = new EmbedBuilder()
          .setColor(0x22c55e)
          .setTitle(reroll ? 'You Won a Giveaway Reroll' : 'You Won a Zenith Giveaway')
          .setDescription(`Congrats! You won **${giveaway.prize || 'the giveaway'}**.`)
          .addFields(
            { name: 'Giveaway', value: giveaway.title || 'Zenith Giveaway' },
            reward.key ? { name: 'License Key', value: `\`${reward.key}\`` } : { name: 'License Key', value: 'No key attached' },
            reward.expiresAt ? { name: 'Expires', value: reward.expiresAt } : { name: 'Expires', value: 'Never' }
          )
          .setTimestamp(new Date())
        await user.send({ embeds: [dm] }).catch(() => {})
      }
    } catch (err) {
      rewardResults.push({ uid, ok: false, error: err?.message || 'Failed to create reward key' })
    }
  }
  return rewardResults
}

async function refreshGiveawayMessage(giveaway, extraFields = [], announceLine = '') {
  const { channel, message } = await getGiveawayContext(giveaway)
  if (!channel) return

  const winnerMentions = Array.isArray(giveaway.winners) && giveaway.winners.length
    ? giveaway.winners.map(id => `<@${id}>`).join(', ')
    : 'No valid entries'
  const embed = giveawayEmbed(giveaway, !!giveaway.ended)
  if (giveaway.ended) embed.addFields({ name: 'Winners', value: winnerMentions })
  for (const field of extraFields) {
    if (field?.name && field?.value) embed.addFields({ name: String(field.name), value: String(field.value).slice(0, 1000), inline: !!field.inline })
  }

  const payload = { embeds: [embed], components: giveawayButtons(giveaway, !!giveaway.ended) }
  if (announceLine) payload.content = announceLine

  if (message) {
    await message.edit(payload).catch(() => {})
  } else {
    const sent = await channel.send(payload).catch(() => null)
    if (sent) giveaway.messageId = sent.id
  }
}

async function endGiveaway(giveawayId, endedBy = '') {
  const giveaway = state.giveaways[giveawayId]
  if (!giveaway || giveaway.ended) return null

  giveaway.ended = true
  giveaway.endedAt = Date.now()
  if (endedBy) giveaway.endedBy = endedBy
  const { guild } = await getGiveawayContext(giveaway)
  if (!guild) {
    saveState()
    return null
  }

  const eligible = await collectEligibleGiveawayEntries(giveaway, guild)
  const winnersWanted = clamp(Number(giveaway.winnerCount || 1), 1, 20)
  const winners = [...eligible].sort(() => Math.random() - 0.5).slice(0, winnersWanted)
  giveaway.winners = winners
  giveaway.history = giveaway.history || []

  const rewardResults = await deliverGiveawayRewards(giveaway, winners, false)
  const resultLines = rewardResults.map(r => {
    if (!r.ok) return `<@${r.uid}> - reward failed (${r.error})`
    if (!r.key) return `<@${r.uid}> - winner`
    return `<@${r.uid}> - key sent via DM`
  })

  await refreshGiveawayMessage(
    giveaway,
    [
      { name: 'Rewards', value: resultLines.length ? resultLines.join('\n').slice(0, 1000) : 'No reward actions' }
    ],
    winners.length ? `Giveaway ended. Winner(s): ${winners.map(id => `<@${id}>`).join(', ')}` : 'Giveaway ended. No eligible winners.'
  )
  saveState()
  return giveaway
}

async function rerollGiveaway(giveawayId, rerolledBy = '') {
  const giveaway = state.giveaways[giveawayId]
  if (!giveaway) throw new Error('Giveaway not found')
  if (!giveaway.ended) throw new Error('Giveaway must be ended before reroll')

  const { guild } = await getGiveawayContext(giveaway)
  if (!guild) throw new Error('Giveaway channel not found')

  const previousWinners = Array.isArray(giveaway.winners) ? giveaway.winners : []
  const eligible = await collectEligibleGiveawayEntries(giveaway, guild, previousWinners)
  const winnersWanted = clamp(Number(giveaway.winnerCount || 1), 1, 20)
  const rerollWinners = [...eligible].sort(() => Math.random() - 0.5).slice(0, winnersWanted)

  giveaway.history = giveaway.history || []
  giveaway.history.push({
    at: Date.now(),
    by: rerolledBy || 'unknown',
    winners: previousWinners
  })
  giveaway.winners = rerollWinners
  giveaway.rerolledAt = Date.now()
  if (rerolledBy) giveaway.rerolledBy = rerolledBy

  const rewardResults = await deliverGiveawayRewards(giveaway, rerollWinners, true)
  const resultLines = rewardResults.map(r => {
    if (!r.ok) return `<@${r.uid}> - reward failed (${r.error})`
    if (!r.key) return `<@${r.uid}> - reroll winner`
    return `<@${r.uid}> - key sent via DM`
  })

  await refreshGiveawayMessage(
    giveaway,
    [
      { name: 'Reroll By', value: rerolledBy ? `<@${rerolledBy}>` : 'System', inline: true },
      { name: 'Reroll Rewards', value: resultLines.length ? resultLines.join('\n').slice(0, 1000) : 'No reward actions' }
    ],
    rerollWinners.length
      ? `Giveaway rerolled. New winner(s): ${rerollWinners.map(id => `<@${id}>`).join(', ')}`
      : 'Giveaway rerolled. No eligible replacement winners.'
  )

  saveState()
  return giveaway
}

async function pollGiveaways() {
  const now = Date.now()
  const activeIds = Object.keys(state.giveaways || {}).filter(id => {
    const g = state.giveaways[id]
    return g && !g.ended && Number(g.endsAt || 0) <= now
  })
  for (const id of activeIds) {
    try {
      await endGiveaway(id, 'scheduler')
    } catch (err) {
      console.warn('Giveaway end error:', err.message)
    }
  }
}

async function automodLog(guild, data) {
  const channelId = state.automod?.logChannelId || ''
  if (!channelId) return
  const ch = await guild.channels.fetch(channelId).catch(() => null)
  if (!ch || ch.type !== ChannelType.GuildText) return
  const e = new EmbedBuilder()
    .setColor(0xef4444)
    .setTitle('Automod Action')
    .setDescription(data.summary || 'Rule triggered.')
    .addFields(
      { name: 'User', value: `<@${data.userId}> (\`${data.userId}\`)`, inline: true },
      { name: 'Rule', value: data.rule || 'unknown', inline: true },
      { name: 'Action', value: data.action || 'none', inline: true }
    )
    .setTimestamp(new Date())
  if (data.channelId) e.addFields({ name: 'Channel', value: `<#${data.channelId}>`, inline: true })
  if (data.sample) e.addFields({ name: 'Content', value: String(data.sample).slice(0, 900) })
  await ch.send({ embeds: [e] }).catch(() => {})
}

async function transcript(ch, by, reason = '') {
  let before, left = 1000
  const lines = []
  while (left > 0) {
    const b = await ch.messages.fetch({ limit: Math.min(100, left), before })
    if (!b.size) break
    ;[...b.values()].sort((a, z) => a.createdTimestamp - z.createdTimestamp).forEach(m => {
      const at = [...m.attachments.values()].map(a => a.url).join(' ')
      lines.push(`[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${(m.content || '')} ${at}`.trim())
    })
    before = b.last().id
    left -= b.size
  }
  const tId = state.channels.transcripts || ''
  const tCh = tId ? ch.guild.channels.cache.get(tId) : null
  if (tCh && tCh.type === ChannelType.GuildText) {
    const file = new AttachmentBuilder(Buffer.from(lines.join('\n') || 'No messages'), { name: `${ch.name}-transcript.txt` })
    const emb = new EmbedBuilder().setColor(0xef4444).setTitle('Ticket Closed').setDescription(`Channel: ${ch.name}\nBy: <@${by}>${reason ? `\nReason: ${reason}` : ''}`)
    await tCh.send({ embeds: [emb], files: [file] }).catch(() => {})
  }
}

function panelRows() {
  const select = new StringSelectMenuBuilder()
    .setCustomId('panel:ticket_select')
    .setPlaceholder('Please choose an option')
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('Card / Bank / Apple Pay / Google Pay').setValue('stripe_info').setDescription('Instant checkout via Stripe on our website').setEmoji('💳'),
      new StringSelectMenuOptionBuilder().setLabel('PayPal Purchase').setValue('paypal_open').setDescription('Pay via PayPal — we handle it manually').setEmoji('💸'),
      new StringSelectMenuOptionBuilder().setLabel('DonutSMP Pay').setValue('donutsmp_open').setDescription('$400M = 30 days • $800M = Lifetime').setEmoji('🍩'),
      new StringSelectMenuOptionBuilder().setLabel('Bug Report').setValue('bug_open').setDescription('Report a bug or broken feature').setEmoji('🐛'),
      new StringSelectMenuOptionBuilder().setLabel('Account Issues').setValue('account_open').setDescription('License, HWID, login, or access problems').setEmoji('👤'),
      new StringSelectMenuOptionBuilder().setLabel('Refund Request').setValue('refund_info').setDescription('View our refund policy or request help').setEmoji('💰'),
      new StringSelectMenuOptionBuilder().setLabel('Media Application').setValue('media_open').setDescription('Apply for Media role — 2 videos, 8k+ views required').setEmoji('🎬')
    )
  return [new ActionRowBuilder().addComponents(select)]
}

async function createTicket(inter, typeId, context = {}) {
  const g = inter.guild, u = inter.user
  const active = g.channels.cache.filter(c => c.type === ChannelType.GuildText && String(c.topic || '').startsWith(`ticket:${u.id}:`))
  if (active.size >= CFG.ticketMaxOpen) return inter.reply({ content: `You already have ${active.size} open ticket(s). Please wait for a response or close an existing one.`, ephemeral: true })

  const tp = CFG.ticketTypes.find(t => t.id === typeId) || { id: typeId, label: typeId, emoji: '🎫' }
  const cat = CFG.ticketCatMap[tp.id] || CFG.ticketCategory || null
  const name = `ticket-${tp.id}-${u.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 90)
  const perms = [
    { id: g.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    { id: u.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] },
    { id: inter.client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ReadMessageHistory] }
  ]
  CFG.supportRoles.forEach(r => perms.push({ id: r, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }))

  const ch = await g.channels.create({
    name: name || `ticket-${u.id}`,
    type: ChannelType.GuildText,
    parent: cat,
    topic: ticketTopic({ uid: u.id, type: tp.id, owner: '', prio: 'normal' }),
    permissionOverwrites: perms
  })

  const meta = ticketMeta(ch.id)
  meta.createdAt = Date.now()
  meta.claimedBy = ''
  meta.status = 'open'
  meta.urgent = false
  meta.notes = []
  meta.typeMoves = 0
  meta.lastUpdatedAt = Date.now()
  saveState()

  const emb = new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle(`${tp.emoji || '🎫'} ${tp.label} — New Ticket`)
    .setDescription(`Hey ${u}! Thanks for reaching out to **Zenith Macros Support**.\nA staff member will be with you shortly — please add any extra details below while you wait.`)

  if (context.fields?.length) emb.addFields(context.fields)

  emb.addFields(
    { name: '⚡ Priority', value: 'Normal', inline: true },
    { name: '🎫 Ticket ID', value: `\`${ch.id}\``, inline: true }
  ).setTimestamp(new Date())

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:claim').setLabel('Claim').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ticket:transcript').setLabel('Transcript').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ticket:urgent').setLabel('Mark Urgent').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('ticket:close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
  )

  await ch.send({ content: CFG.supportRoles.map(r => `<@&${r}>`).join(' ') || undefined, embeds: [emb], components: [row] })
  await inter.reply({ content: `✅ Your ticket has been created: ${ch}`, ephemeral: true })
}

async function githubPoll() {
  if (githubPoll._running) return
  githubPoll._running = true
  const h = { 'User-Agent': 'ZenithMacrosBot' }
  if (CFG.githubToken) h.Authorization = `Bearer ${CFG.githubToken}`
  try {
    if (state.channels.commits) {
      const r = await fetch(`https://api.github.com/repos/${CFG.privateRepo}/commits?per_page=1`, { headers: h })
      if (!r.ok) {
        const body = await r.text().catch(() => '')
        console.warn(`[github] commits poll failed (${r.status}) ${body.slice(0, 160)}`)
      }
      if (r.ok) {
        const c = (await r.json())[0]
        if (c?.sha) {
          if (state.watchers.commit !== c.sha) {
            const ch = await client.channels.fetch(state.channels.commits).catch(() => null)
            if (ch?.type === ChannelType.GuildText) {
              const firstSeen = !state.watchers.commit
              const e = commitEmbed(c, CFG.privateRepo, firstSeen)
              await ch.send({ embeds: [e] }).catch(() => {})
            }
          }
          state.watchers.commit = c.sha
        }
      }
    }
    if (state.channels.releases) {
      const r = await fetch(`https://api.github.com/repos/${CFG.releaseRepo}/releases/latest`, { headers: h })
      if (!r.ok) {
        const body = await r.text().catch(() => '')
        console.warn(`[github] release poll failed (${r.status}) ${body.slice(0, 160)}`)
      }
      if (r.ok) {
        const rel = await r.json()
        if (rel?.id) {
          if (String(state.watchers.release || '') !== String(rel.id)) {
            const ch = await client.channels.fetch(state.channels.releases).catch(() => null)
            if (ch?.type === ChannelType.GuildText) {
              const firstSeen = !state.watchers.release
              const e = releaseEmbed(rel, CFG.releaseRepo, firstSeen)
              await ch.send({ embeds: [e] }).catch(() => {})
            }
          }
          state.watchers.release = String(rel.id)
        }
      }
    }
    saveState()
  } catch (e) {
    console.warn('GitHub poll warning:', e.message)
  } finally {
    githubPoll._running = false
  }
}

async function registerCommands() {
  const ticketTypeChoices = CFG.ticketTypes.slice(0, 25).map(t => ({ name: String(t.label || t.id).slice(0, 100), value: t.id }))
  const cmds = [
    new SlashCommandBuilder().setName('ping').setDescription('Bot latency'),
    new SlashCommandBuilder().setName('help').setDescription('Command help'),
    new SlashCommandBuilder()
      .setName('rating')
      .setDescription('Leave a rating for Zenith Macros (customers only)')
      .addIntegerOption(o => o.setName('stars').setDescription('Your rating out of 5').setRequired(true).setMinValue(1).setMaxValue(5))
      .addStringOption(o => o.setName('description').setDescription('Tell us about your experience (required for ratings under 4★)').setRequired(false).setMaxLength(1000))
      .addBooleanOption(o => o.setName('anonymous').setDescription('Hide your username in the review (default: false)').setRequired(false)),
    // Ticket commands
    new SlashCommandBuilder().setName('ticket_panel').setDescription('Post ticket panel').addChannelOption(o => o.setName('channel').setDescription('Target').setRequired(true)),
    new SlashCommandBuilder().setName('ticket_close').setDescription('Close ticket').addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),
    new SlashCommandBuilder().setName('ticket_add').setDescription('Add user to ticket').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
    new SlashCommandBuilder().setName('ticket_remove').setDescription('Remove user from ticket').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
    new SlashCommandBuilder().setName('ticket_rename').setDescription('Rename ticket').addStringOption(o => o.setName('name').setDescription('Name').setRequired(true)),
    new SlashCommandBuilder().setName('ticket_priority').setDescription('Set ticket priority').addStringOption(o => o.setName('level').setDescription('Level').setRequired(true).addChoices({ name: 'low', value: 'low' }, { name: 'normal', value: 'normal' }, { name: 'high', value: 'high' }, { name: 'urgent', value: 'urgent' })),
    new SlashCommandBuilder().setName('ticket_transcript').setDescription('Send ticket transcript'),
    new SlashCommandBuilder().setName('ticket_claim').setDescription('Claim ticket').addUserOption(o => o.setName('user').setDescription('Claim owner').setRequired(false)),
    new SlashCommandBuilder().setName('ticket_unclaim').setDescription('Unclaim ticket'),
    new SlashCommandBuilder().setName('ticket_status').setDescription('Set ticket status').addStringOption(o => o.setName('status').setDescription('Status').setRequired(true).addChoices({ name: 'open', value: 'open' }, { name: 'pending', value: 'pending' }, { name: 'resolved', value: 'resolved' }, { name: 'waiting_customer', value: 'waiting_customer' })),
    new SlashCommandBuilder().setName('ticket_note').setDescription('Add internal ticket note').addStringOption(o => o.setName('note').setDescription('Note').setRequired(true)),
    new SlashCommandBuilder().setName('ticket_notes').setDescription('View recent ticket notes'),
    new SlashCommandBuilder().setName('ticket_move_type').setDescription('Change ticket type/category').addStringOption(o => o.setName('type').setDescription('Ticket type').setRequired(true).addChoices(...ticketTypeChoices)),
    new SlashCommandBuilder().setName('ticket_info').setDescription('Show ticket metadata'),
    // Boost reward — claim extra time for boosting the server
    new SlashCommandBuilder()
      .setName('claim_boost')
      .setDescription('Claim your server boost reward — extends your monthly license by 7 days (up to 2 boosts)'),
    // Key management (admin/manager) — raw key operations
    new SlashCommandBuilder()
      .setName('key')
      .setDescription('Raw key operations (admin/manager only) — use /user for Discord-user-based actions')
      .addSubcommand(sc => sc
        .setName('create')
        .setDescription('Generate a new unbound license key')
        .addStringOption(o => o.setName('access').setDescription('Plan').setRequired(true).addChoices({ name: 'monthly', value: 'monthly' }, { name: 'lifetime', value: 'lifetime' }))
        .addIntegerOption(o => o.setName('days').setDescription('Monthly days (default 30)').setRequired(false))
        .addStringOption(o => o.setName('note').setDescription('Internal note').setRequired(false))
        .addStringOption(o => o.setName('email').setDescription('Pre-bind email').setRequired(false))
        .addStringOption(o => o.setName('discord_id').setDescription('Pre-bind Discord user ID').setRequired(false)))
      .addSubcommand(sc => sc
        .setName('extend')
        .setDescription('Add days to a key\'s expiry date')
        .addStringOption(o => o.setName('key').setDescription('License key').setRequired(true))
        .addIntegerOption(o => o.setName('days').setDescription('Days to add').setRequired(true)))
      .addSubcommand(sc => sc
        .setName('delete')
        .setDescription('Permanently delete a key from the system')
        .addStringOption(o => o.setName('key').setDescription('License key').setRequired(true))),
    // User/dashboard management (admin/manager)
    new SlashCommandBuilder()
      .setName('user')
      .setDescription('Manage users and their licenses (admin/manager only)')
      .addSubcommand(sc => sc
        .setName('lookup')
        .setDescription('Look up all licenses for a Discord user')
        .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(false))
        .addStringOption(o => o.setName('discord_id').setDescription('Discord user ID (if not mentionable)').setRequired(false)))
      .addSubcommand(sc => sc
        .setName('grant')
        .setDescription('Grant a new license key to a Discord user')
        .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(true))
        .addStringOption(o => o.setName('plan').setDescription('Plan').setRequired(true).addChoices({ name: 'monthly', value: 'monthly' }, { name: 'lifetime', value: 'lifetime' }))
        .addIntegerOption(o => o.setName('days').setDescription('Days (monthly only, default 30)').setRequired(false))
        .addStringOption(o => o.setName('email').setDescription('Email (optional)').setRequired(false))
        .addStringOption(o => o.setName('note').setDescription('Note (optional)').setRequired(false)))
      .addSubcommand(sc => sc
        .setName('revoke')
        .setDescription("Revoke a Discord user's license(s)")
        .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(false))
        .addStringOption(o => o.setName('discord_id').setDescription('Discord user ID').setRequired(false))
        .addStringOption(o => o.setName('key').setDescription('Specific key to revoke (blank = all)').setRequired(false)))
      .addSubcommand(sc => sc
        .setName('hwid_reset')
        .setDescription("Reset HWID for a Discord user's license(s)")
        .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(false))
        .addStringOption(o => o.setName('discord_id').setDescription('Discord user ID').setRequired(false))
        .addStringOption(o => o.setName('key').setDescription('Specific key (blank = all)').setRequired(false)))
      .addSubcommand(sc => sc
        .setName('upgrade')
        .setDescription("Upgrade a Discord user's license to lifetime")
        .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(false))
        .addStringOption(o => o.setName('discord_id').setDescription('Discord user ID').setRequired(false))
        .addStringOption(o => o.setName('key').setDescription('Specific key (blank = all active)').setRequired(false)))
      .addSubcommand(sc => sc
        .setName('extend')
        .setDescription("Add days to a Discord user's monthly license")
        .addIntegerOption(o => o.setName('days').setDescription('Days to add (1–3650)').setRequired(true))
        .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(false))
        .addStringOption(o => o.setName('discord_id').setDescription('Discord user ID').setRequired(false))
        .addStringOption(o => o.setName('key').setDescription('Specific key (blank = primary active key)').setRequired(false)))
      .addSubcommand(sc => sc
        .setName('toggle')
        .setDescription("Activate or deactivate a Discord user's license")
        .addBooleanOption(o => o.setName('active').setDescription('true = activate, false = deactivate').setRequired(true))
        .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(false))
        .addStringOption(o => o.setName('discord_id').setDescription('Discord user ID').setRequired(false))
        .addStringOption(o => o.setName('key').setDescription('Specific key (blank = all)').setRequired(false)))
      .addSubcommand(sc => sc
        .setName('note')
        .setDescription("View or update the internal note on a Discord user's primary license")
        .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(false))
        .addStringOption(o => o.setName('discord_id').setDescription('Discord user ID').setRequired(false))
        .addStringOption(o => o.setName('note').setDescription('New note text (omit to view current, "clear" to remove)').setRequired(false))
        .addStringOption(o => o.setName('key').setDescription('Specific key (blank = primary active key)').setRequired(false))),
    // Individual macro entitlement management (admin/manager)
    new SlashCommandBuilder()
      .setName('macro')
      .setDescription('Grant individual standalone macro access to a Discord user (admin/manager only)')
      .addSubcommand(sc => sc
        .setName('grant')
        .setDescription('Grant a specific standalone macro to a user — creates a standalone key if they don\'t have one')
        .addUserOption(o => o.setName('user').setDescription('Discord user to grant the macro to').setRequired(true))
        .addStringOption(o => o.setName('product_id')
          .setDescription('Which macro to grant — enter the macro\'s product ID or display name')
          .setRequired(true)
          .addChoices(
            { name: 'Single Anchor', value: 'single-anchor' },
            { name: 'Double Anchor', value: 'double-anchor' },
            { name: 'Auto Totem', value: 'auto-totem' },
            { name: 'Triggerbot', value: 'triggerbot' },
            { name: 'Auto Crystal', value: 'auto-crystal' },
            { name: 'Auto Sword', value: 'auto-sword' },
            { name: 'Auto Mace', value: 'auto-mace' },
            { name: 'Auto Cart', value: 'auto-cart' },
            { name: 'Auto UHC', value: 'auto-uhc' },
            { name: 'Pearl Clutch', value: 'pearl-clutch' },
            { name: 'Minecart Boost', value: 'minecart-boost' },
          ))
        .addStringOption(o => o.setName('note').setDescription('Internal note — e.g. reason for grant, ticket ID, etc.').setRequired(false))),
    // Affiliate management (admin/manager)
    new SlashCommandBuilder()
      .setName('affiliate')
      .setDescription('Manage affiliate codes (admin/manager only)')
      .addSubcommand(sc => sc
        .setName('info')
        .setDescription('Show affiliate info for a user')
        .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(false))
        .addStringOption(o => o.setName('discord_id').setDescription('Discord user ID').setRequired(false)))
      .addSubcommand(sc => sc
        .setName('set')
        .setDescription("Set or update a user's affiliate code")
        .addStringOption(o => o.setName('code').setDescription('Affiliate code (4-32 lowercase alphanumeric)').setRequired(true))
        .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(false))
        .addStringOption(o => o.setName('discord_id').setDescription('Discord user ID').setRequired(false)))
      .addSubcommand(sc => sc
        .setName('clear')
        .setDescription("Clear a user's affiliate code")
        .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(false))
        .addStringOption(o => o.setName('discord_id').setDescription('Discord user ID').setRequired(false))),
    // Giveaway system
    new SlashCommandBuilder()
      .setName('giveaway')
      .setDescription('Giveaway management (admin/support only)')
      .addSubcommand(sc => sc
        .setName('create')
        .setDescription('Create a giveaway with optional key rewards')
        .addStringOption(o => o.setName('title').setDescription('Giveaway title').setRequired(true))
        .addStringOption(o => o.setName('prize').setDescription('Prize description').setRequired(true))
        .addStringOption(o => o.setName('duration').setDescription('Duration e.g. 1h, 2d, 30m').setRequired(true))
        .addIntegerOption(o => o.setName('winners').setDescription('Number of winners').setRequired(true))
        .addChannelOption(o => o.setName('channel').setDescription('Channel (default: current)').setRequired(false))
        .addStringOption(o => o.setName('description').setDescription('Extra description').setRequired(false))
        .addIntegerOption(o => o.setName('min_invites').setDescription('Minimum invites to enter').setRequired(false))
        .addBooleanOption(o => o.setName('reward_key').setDescription('Auto-DM winner a license key').setRequired(false))
        .addStringOption(o => o.setName('reward_access').setDescription('Key plan for reward').setRequired(false).addChoices({ name: 'monthly', value: 'monthly' }, { name: 'lifetime', value: 'lifetime' }))
        .addIntegerOption(o => o.setName('reward_days').setDescription('Monthly key days').setRequired(false))
        .addStringOption(o => o.setName('reward_note').setDescription('Key note tag').setRequired(false)))
      .addSubcommand(sc => sc
        .setName('end')
        .setDescription('End a giveaway immediately')
        .addStringOption(o => o.setName('id').setDescription('Giveaway ID').setRequired(true)))
      .addSubcommand(sc => sc
        .setName('reroll')
        .setDescription('Reroll a finished giveaway')
        .addStringOption(o => o.setName('id').setDescription('Giveaway ID').setRequired(true)))
      .addSubcommand(sc => sc
        .setName('list')
        .setDescription('List recent giveaways')),
    // Server / moderation tools
    new SlashCommandBuilder()
      .setName('mod')
      .setDescription('Moderation actions (admin only)')
      .addSubcommand(sc => sc
        .setName('timeout')
        .setDescription('Timeout a member')
        .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
        .addStringOption(o => o.setName('duration').setDescription('Duration e.g. 10m, 1h, 7d').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)))
      .addSubcommand(sc => sc
        .setName('untimeout')
        .setDescription('Remove timeout from a member')
        .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)))
      .addSubcommand(sc => sc
        .setName('kick')
        .setDescription('Kick a member')
        .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)))
      .addSubcommand(sc => sc
        .setName('ban')
        .setDescription('Ban a user')
        .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
        .addIntegerOption(o => o.setName('delete_days').setDescription('Delete message history (days 0-7)').setRequired(false))
        .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)))
      .addSubcommand(sc => sc
        .setName('unban')
        .setDescription('Unban a user by ID')
        .addStringOption(o => o.setName('user_id').setDescription('User ID').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)))
      .addSubcommand(sc => sc
        .setName('warn')
        .setDescription('Warn a member (DMs them)')
        .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Warning reason').setRequired(true)))
      .addSubcommand(sc => sc
        .setName('nick')
        .setDescription('Change a member nickname')
        .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
        .addStringOption(o => o.setName('nickname').setDescription('New nickname (blank to clear)').setRequired(false)))
      .addSubcommand(sc => sc
        .setName('role')
        .setDescription('Add or remove a role from a member')
        .addStringOption(o => o.setName('action').setDescription('add or remove').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }))
        .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
        .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true))),
    // Channel / message tools
    new SlashCommandBuilder()
      .setName('say')
      .setDescription('Send a message or embed (admin only)')
      .addSubcommand(sc => sc
        .setName('message')
        .setDescription('Send a plain message via modal')
        .addChannelOption(o => o.setName('channel').setDescription('Target channel').setRequired(true)))
      .addSubcommand(sc => sc
        .setName('embed')
        .setDescription('Send a rich embed via modal')
        .addChannelOption(o => o.setName('channel').setDescription('Target channel').setRequired(true))),
    new SlashCommandBuilder()
      .setName('purge')
      .setDescription('Bulk delete messages (admin only)')
      .addIntegerOption(o => o.setName('amount').setDescription('Messages to delete (1-100)').setRequired(true))
      .addUserOption(o => o.setName('user').setDescription('Only delete messages from this user').setRequired(false)),
    new SlashCommandBuilder()
      .setName('slowmode')
      .setDescription('Set channel slowmode (admin only)')
      .addIntegerOption(o => o.setName('seconds').setDescription('Seconds (0 to disable, max 21600)').setRequired(true))
      .addChannelOption(o => o.setName('channel').setDescription('Channel (default: current)').setRequired(false)),
    new SlashCommandBuilder()
      .setName('lockdown')
      .setDescription('Lock or unlock a channel (admin only)')
      .addStringOption(o => o.setName('action').setDescription('lock or unlock').setRequired(true).addChoices({ name: 'lock', value: 'lock' }, { name: 'unlock', value: 'unlock' }))
      .addChannelOption(o => o.setName('channel').setDescription('Channel (default: current)').setRequired(false))
      .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),
    // Info / utility
    new SlashCommandBuilder().setName('serverinfo').setDescription('Show server information'),
    new SlashCommandBuilder()
      .setName('userinfo')
      .setDescription('Show info about a user')
      .addUserOption(o => o.setName('user').setDescription('User (default: yourself)').setRequired(false)),
    new SlashCommandBuilder()
      .setName('avatar')
      .setDescription("Show a user's avatar")
      .addUserOption(o => o.setName('user').setDescription('User (default: yourself)').setRequired(false)),
    new SlashCommandBuilder()
      .setName('roleinfo')
      .setDescription('Show info about a role')
      .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)),
    new SlashCommandBuilder()
      .setName('poll')
      .setDescription('Create a quick poll (admin/support only)')
      .addStringOption(o => o.setName('question').setDescription('Poll question').setRequired(true))
      .addStringOption(o => o.setName('option1').setDescription('Option 1').setRequired(true))
      .addStringOption(o => o.setName('option2').setDescription('Option 2').setRequired(true))
      .addStringOption(o => o.setName('option3').setDescription('Option 3').setRequired(false))
      .addStringOption(o => o.setName('option4').setDescription('Option 4').setRequired(false))
      .addStringOption(o => o.setName('option5').setDescription('Option 5').setRequired(false))
      .addChannelOption(o => o.setName('channel').setDescription('Channel (default: current)').setRequired(false)),
    new SlashCommandBuilder()
      .setName('dm')
      .setDescription('DM a user a message (admin only)')
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
      .addStringOption(o => o.setName('message').setDescription('Message').setRequired(true)),
    new SlashCommandBuilder()
      .setName('announce')
      .setDescription('Post an announcement embed (admin only)')
      .addChannelOption(o => o.setName('channel').setDescription('Target channel').setRequired(true))
      .addStringOption(o => o.setName('title').setDescription('Title').setRequired(true))
      .addStringOption(o => o.setName('message').setDescription('Body text (use \\n for newlines)').setRequired(true))
      .addStringOption(o => o.setName('color').setDescription('Hex color e.g. #8b5cf6').setRequired(false))
      .addRoleOption(o => o.setName('ping').setDescription('Role to ping').setRequired(false)),
    // Bot admin
    new SlashCommandBuilder()
      .setName('bot_access')
      .setDescription('Manage which users can run admin bot commands')
      .addSubcommand(sc => sc
        .setName('add')
        .setDescription('Allow a user to run admin commands')
        .addUserOption(o => o.setName('user').setDescription('User to allow').setRequired(true)))
      .addSubcommand(sc => sc
        .setName('remove')
        .setDescription('Remove a user from bot access')
        .addUserOption(o => o.setName('user').setDescription('User to remove').setRequired(true)))
      .addSubcommand(sc => sc
        .setName('list')
        .setDescription('List allowed users')),
    new SlashCommandBuilder().setName('bot_channels').setDescription('Set notification channels').addChannelOption(o => o.setName('commits').setDescription('Commits channel').setRequired(false)).addChannelOption(o => o.setName('releases').setDescription('Releases channel').setRequired(false)).addChannelOption(o => o.setName('transcripts').setDescription('Transcripts channel').setRequired(false)).addChannelOption(o => o.setName('modlog').setDescription('Moderation audit log channel').setRequired(false)),
    new SlashCommandBuilder().setName('bot_config').setDescription('Show bot configuration'),
    // Customer download — restricted to Customer role
    new SlashCommandBuilder().setName('download').setDescription('Get a secure download link for Zenith Macros (customers only)'),
    // Automod
    new SlashCommandBuilder()
      .setName('automod_limits')
      .setDescription('Tune automod thresholds')
      .addIntegerOption(o => o.setName('max_mentions').setDescription('Max user mentions per message').setRequired(false))
      .addNumberOption(o => o.setName('caps_threshold').setDescription('Uppercase ratio (0.50 to 1.00)').setRequired(false))
      .addIntegerOption(o => o.setName('caps_min_length').setDescription('Minimum letters before caps rule').setRequired(false))
      .addIntegerOption(o => o.setName('spam_max_messages').setDescription('Messages allowed in spam window').setRequired(false))
      .addIntegerOption(o => o.setName('spam_window_sec').setDescription('Spam window seconds').setRequired(false))
      .addIntegerOption(o => o.setName('timeout_minutes').setDescription('Timeout minutes').setRequired(false)),
    new SlashCommandBuilder().setName('automod_badword_add').setDescription('Add banned word/phrase').addStringOption(o => o.setName('word').setDescription('Word or phrase').setRequired(true)),
    new SlashCommandBuilder().setName('automod_badword_remove').setDescription('Remove banned word/phrase').addStringOption(o => o.setName('word').setDescription('Word or phrase').setRequired(true)),
    new SlashCommandBuilder().setName('automod_badword_list').setDescription('Show banned words'),
    new SlashCommandBuilder().setName('automod_domain_add').setDescription('Allow link domain').addStringOption(o => o.setName('domain').setDescription('Domain like example.com').setRequired(true)),
    new SlashCommandBuilder().setName('automod_domain_remove').setDescription('Remove allowed link domain').addStringOption(o => o.setName('domain').setDescription('Domain like example.com').setRequired(true)),
    new SlashCommandBuilder().setName('automod_domain_list').setDescription('Show allowed link domains'),
    new SlashCommandBuilder().setName('automod_logchannel').setDescription('Set automod log channel (omit to clear)').addChannelOption(o => o.setName('channel').setDescription('Log channel').setRequired(false)),
    new SlashCommandBuilder().setName('automod_status').setDescription('Show automod configuration'),
    new SlashCommandBuilder()
      .setName('automod_toggle')
      .setDescription('Enable/disable automod or individual rules')
      .addStringOption(o => o.setName('rule').setDescription('Rule to change (all/invites/links/spam/badwords/caps)').setRequired(true)
        .addChoices(
          { name: 'all (master on/off)', value: 'all' },
          { name: 'invites', value: 'invites' },
          { name: 'links', value: 'links' },
          { name: 'spam', value: 'spam' },
          { name: 'badwords', value: 'badwords' },
          { name: 'caps', value: 'caps' },
        ))
      .addStringOption(o => o.setName('action').setDescription('Action to take').setRequired(true)
        .addChoices(
          { name: 'off', value: 'off' },
          { name: 'delete', value: 'delete' },
          { name: 'timeout', value: 'timeout' },
        )),
  ].map(c => c.toJSON())
  const rest = new REST({ version: '10' }).setToken(env.DISCORD_TOKEN)

  // Build set of current command names for stale-detection
  const currentNames = new Set(cmds.map(c => c.name))

  if (CFG.guildId) {
    // Register as guild commands (instant update)
    await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, CFG.guildId), { body: cmds })
    // Wipe ALL global commands — we're guild-scoped, so any global ones are stale
    await rest.put(Routes.applicationCommands(env.DISCORD_CLIENT_ID), { body: [] })
    console.log(`[commands] Registered ${cmds.length} guild commands, cleared all global commands`)
  } else {
    await rest.put(Routes.applicationCommands(env.DISCORD_CLIENT_ID), { body: cmds })
    console.log(`[commands] Registered ${cmds.length} global commands`)
  }
}

// ─── ACTIVE USERS LIVE COUNTER ───────────────────────────────────────────────
const ACTIVE_CHANNEL_ID = '1495986807861415956'
const ACTIVE_MIN = 50
const ACTIVE_MAX = 250

// Returns a 0-1 activity multiplier tuned for a mostly school-age US audience.
// EST (UTC-5) is used as the primary clock.
function _activityMultiplier() {
  const now  = new Date()
  const estH = ((now.getUTCHours() - 5) + 24) % 24
  const dow  = now.getUTCDay() // 0=Sun 1=Mon … 6=Sat

  // ── School days: Mon–Thu ──────────────────────────────────────────────────
  // Kids wake up ~7am, school 8am–3pm (nearly nobody on), after-school spike,
  // then homework/dinner dip, small evening window, early bed (school tomorrow).
  if (dow >= 1 && dow <= 4) {
    return [
      0.08, 0.06, 0.05, 0.05, 0.06, 0.07, // 12–5am  (sleeping, school night)
      0.10, 0.12, 0.10, 0.10, 0.11, 0.12, //  6–11am (school)
      0.13, 0.15, 0.17, 0.30, 0.42, 0.50, // 12–5pm  (school → after-school)
      0.55, 0.52, 0.44, 0.32, 0.20, 0.12, //  6–11pm (homework/bed, school tomorrow)
    ][estH] ?? 0.12
  }

  // ── Friday ───────────────────────────────────────────────────────────────
  // Still school in the morning; massive relief after 3pm, peaks Friday night.
  if (dow === 5) {
    return [
      0.22, 0.16, 0.12, 0.10, 0.10, 0.11, // 12–5am
      0.13, 0.15, 0.13, 0.13, 0.14, 0.16, //  6–11am (school)
      0.18, 0.20, 0.22, 0.45, 0.65, 0.80, // 12–5pm  (school out → ramp up)
      0.88, 0.93, 0.90, 0.85, 0.76, 0.62, //  6–11pm (Friday night peak)
    ][estH] ?? 0.30
  }

  // ── Saturday ─────────────────────────────────────────────────────────────
  // Stayed up from Friday → sleeping in → highest counts of the week.
  if (dow === 6) {
    return [
      0.52, 0.42, 0.32, 0.22, 0.16, 0.14, // 12–5am  (late Friday bleed)
      0.15, 0.18, 0.26, 0.40, 0.56, 0.70, //  6–11am (sleeping in → waking up)
      0.78, 0.83, 0.88, 0.91, 0.93, 0.95, // 12–5pm  (peak Saturday afternoon)
      0.97, 1.00, 0.97, 0.92, 0.84, 0.72, //  6–11pm (Saturday prime)
    ][estH] ?? 0.55
  }

  // ── Sunday ───────────────────────────────────────────────────────────────
  // High morning/afternoon, drops hard after ~6pm (homework, "Sunday scaries",
  // early bed because school Monday).
  return [
    0.60, 0.50, 0.38, 0.26, 0.18, 0.14,   // 12–5am  (Sat-night bleed)
    0.15, 0.20, 0.30, 0.44, 0.58, 0.70,   //  6–11am (sleeping in)
    0.78, 0.82, 0.84, 0.80, 0.72, 0.60,   // 12–5pm  (Sunday afternoon)
    0.46, 0.34, 0.24, 0.16, 0.11, 0.09,   //  6–11pm (homework/early bed)
  ][estH] ?? 0.30
}

// Smooth random walk — max ±3 per tick, biased toward time-appropriate target.
function _activeUsersWalk(current, target) {
  const diff   = target - current
  const bias   = Math.sign(diff) * Math.min(Math.abs(diff) * 0.20, 2)
  const noise  = (Math.random() - 0.48) * 2.2
  const clamped = Math.round(current + Math.max(-3, Math.min(3, bias + noise)))
  return Math.max(ACTIVE_MIN, Math.min(ACTIVE_MAX, clamped))
}

function _buildActiveEmbed(count, peakToday, zenithEmojiStr) {
  // Color scales with count — green when busy, indigo when quiet
  const pct = (count - ACTIVE_MIN) / (ACTIVE_MAX - ACTIVE_MIN)
  const color = pct >= 0.65 ? 0x22c55e
              : pct >= 0.35 ? 0x8b5cf6
              :               0x6366f1

  const title = `${zenithEmojiStr}  Zenith Macros — Active Users`

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(
      `### 🟢  **${count}** users currently running macros\n` +
      `\u200b`  // zero-width space for breathing room
    )
    .addFields(
      {
        name: '👥 Online Now',
        value: `\`\`\`${count} users\`\`\``,
        inline: true,
      },
      {
        name: '📈 Session Peak',
        value: `\`\`\`${peakToday} users\`\`\``,
        inline: true,
      },
      {
        name: '⚡ Version',
        value: '```v1.2.7```',
        inline: true,
      },
      {
        name: '🌐 System Status',
        value: [
          '🟢  Auth servers — Online',
          '🟢  License API — Online',
          '🟢  Auto-updater — Online',
        ].join('\n'),
        inline: false,
      }
    )
    .setFooter({ text: 'Zenith Macros  •  Updates every 10 seconds  •  zenithmacros.store' })
    .setTimestamp()
}

async function startActiveUsersTracker(discordClient) {
  const channel = await discordClient.channels.fetch(ACTIVE_CHANNEL_ID).catch(() => null)
  if (!channel) { console.warn('[active-tracker] Channel not found:', ACTIVE_CHANNEL_ID); return }

  // Resolve the custom guild emoji once
  let zenithEmojiStr = ''
  try {
    await channel.guild.emojis.fetch()
    const em = channel.guild.emojis.cache.find(e => e.name === 'ZenithTransparent')
    if (em) zenithEmojiStr = `<:${em.name}:${em.id}>`
  } catch {}

  const mult = _activityMultiplier()
  let current   = Math.round(ACTIVE_MIN + mult * (ACTIVE_MAX - ACTIVE_MIN))
  let peakToday = current

  // Delete any old tracker messages, then post fresh
  let trackerMsg = null
  try {
    const recent = await channel.messages.fetch({ limit: 10 })
    const old = recent.filter(m => m.author.id === discordClient.user.id && m.embeds.length > 0)
    for (const m of old.values()) await m.delete().catch(() => {})
  } catch {}

  try {
    trackerMsg = await channel.send({ embeds: [_buildActiveEmbed(current, peakToday, zenithEmojiStr)] })
  } catch (e) {
    console.error('[active-tracker] Failed to post initial message:', e)
    return
  }

  setInterval(async () => {
    try {
      const target = Math.round(ACTIVE_MIN + _activityMultiplier() * (ACTIVE_MAX - ACTIVE_MIN))
      current = _activeUsersWalk(current, target)
      if (current > peakToday) peakToday = current

      await trackerMsg.edit({ embeds: [_buildActiveEmbed(current, peakToday, zenithEmojiStr)] })
    } catch (e) {
      console.warn('[active-tracker] Edit failed, reposting:', e.message)
      try {
        trackerMsg = await channel.send({ embeds: [_buildActiveEmbed(current, peakToday, zenithEmojiStr)] })
      } catch {}
    }
  }, 10_000)
}

client.once(Events.ClientReady, async c => {
  console.log(`Logged in as ${c.user.tag}`)
  console.log(`[native-secure] available=${nativeSecure.available}${nativeSecure.available ? '' : ` error=${nativeSecure.errorMessage || 'n/a'}`}`)
  try {
    if (client.user.username !== CFG.botName) await client.user.setUsername(CFG.botName)
    const ap = path.resolve(__dirname, CFG.avatarPath)
    if (fs.existsSync(ap)) await client.user.setAvatar(fs.readFileSync(ap))
  } catch {}
  // Set bot status: Do Not Disturb, playing "Zenith Macros"
  try {
    client.user.setPresence({
      status: 'dnd',
      activities: [{ name: 'Zenith Macros', type: ActivityType.Playing }]
    })
  } catch {}
  const expiryNotifier = new ExpiryNotifier({ apiClient, discordClient: client })
  expiryNotifier.start()
  startActiveUsersTracker(client).catch(e => console.error('[active-tracker] startup error:', e))
  setInterval(githubPoll, CFG.pollMs)
  setInterval(pollGiveaways, CFG.giveawayPollMs)
  githubPoll().catch(() => {})
  pollGiveaways().catch(() => {})
  for (const guild of c.guilds.cache.values()) {
    guild.invites.fetch().then(invites => {
      invites.forEach(inv => inviteCodeCache.set(`${guild.id}:${inv.code}`, Number(inv.uses || 0)))
    }).catch(() => {})
    updateMemberCountVoiceChannel(guild, { force: true }).catch(() => {})
  }
})

client.on(Events.GuildMemberAdd, async member => {
  await updateMemberCountVoiceChannel(member.guild).catch(() => {})
  if (!CFG.welcomeChannelId) return
  const ch = await member.guild.channels.fetch(CFG.welcomeChannelId).catch(() => null)
  if (!ch || ch.type !== ChannelType.GuildText) return
  const emb = new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle('Welcome to Zenith Macros')
    .setDescription([
      `Welcome ${member} to **Zenith Macros**.`,
      '',
      'Open a ticket if you need setup help or key support.',
      'Check announcements for updates and new releases.'
    ].join('\n'))
    .setThumbnail(member.user.displayAvatarURL())
    .setTimestamp(new Date())
  await ch.send({ embeds: [emb] }).catch(() => {})
})

client.on(Events.GuildMemberRemove, async member => {
  await updateMemberCountVoiceChannel(member.guild).catch(() => {})
})

// ── Boost extension helper ───────────────────────────────────────────────────
async function applyBoostExtension(discordId, member) {
  let result
  try {
    result = await botApiPost('/api/bot/boost-extend', { discord_id: discordId })
  } catch (err) {
    console.error(`[boost] API error for ${discordId}:`, err?.message || err)
    return
  }

  if (!result?.ok) {
    // Silently skip lifetime / no_license / already maxed — not an error
    if (['lifetime', 'no_license', 'max_reached'].includes(result?.reason)) return
    console.warn(`[boost] Unexpected response for ${discordId}:`, result?.error || result)
    return
  }

  const boostCount = result.boost_count || 1
  const expiresAt = result.expiresAt ? new Date(result.expiresAt) : null
  const expiresStr = expiresAt
    ? expiresAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
    : 'N/A'

  const isSecond = boostCount === 2
  const embed = new EmbedBuilder()
    .setColor(isSecond ? 0xf472b6 : 0x8b5cf6)
    .setTitle(isSecond ? '💖 Double Boost — Thank You!' : '🚀 Boost Reward Applied!')
    .setDescription(
      isSecond
        ? `You've boosted **Zenith Macros** twice — we really appreciate the extra support! 💜\n\nAs a thank you, your license has been extended by another **7 days**.`
        : `Thanks for boosting **Zenith Macros**! Your license has been extended by **7 days** as a thank you. 💜`
    )
    .addFields(
      { name: '⏱️ Days Added', value: '**+7 days**', inline: true },
      { name: '📅 New Expiry', value: `**${expiresStr}**`, inline: true },
      { name: '🎯 Boost Rewards Used', value: `**${boostCount} / 2**`, inline: true }
    )
    .setFooter({ text: boostCount < 2 ? 'Boost again to earn another 7 days!' : 'Maximum boost rewards claimed. Thank you for your support!' })
    .setTimestamp()

  try {
    const user = await client.users.fetch(discordId).catch(() => null)
    if (user) await user.send({ embeds: [embed] }).catch(() => {})
  } catch (_) {}

  console.log(`[boost] Extended license for ${discordId} — boost ${boostCount}/2, expires ${expiresStr}`)
}

// Detect when a member starts boosting (premiumSince: null → Date)
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  try {
    const wasBosting = !!oldMember.premiumSince
    const nowBoosting = !!newMember.premiumSince
    if (!wasBosting && nowBoosting) {
      // Member just started boosting — apply first extension
      await applyBoostExtension(newMember.id, newMember)
    }
  } catch (err) {
    console.error('[boost] guildMemberUpdate error:', err?.message || err)
  }
})

client.on(Events.ChannelDelete, ch => {
  if (state.tickets?.[ch.id]) {
    delete state.tickets[ch.id]
    saveState()
  }
})

client.on(Events.InteractionCreate, async inter => {
  try {
    // ── Ticket panel dropdown select menu ────────────────────────────────────
    if (inter.isStringSelectMenu() && inter.customId === 'panel:ticket_select') {
      const action = inter.values[0]

      if (action === 'stripe_info') {
        return inter.reply({
          embeds: [new EmbedBuilder()
            .setColor(0x8b5cf6)
            .setTitle('💳 Purchase via Stripe')
            .setDescription('All card, bank, Apple Pay, Google Pay, and iDEAL payments are processed instantly through **Stripe**.\n\n**Head to our pricing page to get started:**\n> 🛒 **https://zenithmacros.store/#pricing**\n\nAfter purchasing, your license key and download link will be available in your dashboard.')
            .setFooter({ text: 'Zenith Macros • Powered by Stripe' })],
          ephemeral: true
        })
      }

      if (action === 'refund_info') {
        return inter.reply({
          embeds: [new EmbedBuilder()
            .setColor(0xef4444)
            .setTitle('💰 Refund Policy')
            .setDescription('Before opening a ticket, please review our refund policy.\n\n**Our refund page:**\n> 🔗 **https://zenithmacros.store/refund.html**\n\nIf you\'ve read the policy and still need to request a refund, open a ticket and a staff member will assist you.')
            .setFooter({ text: 'Zenith Macros • Support' })],
          ephemeral: true
        })
      }

      if (action === 'paypal_open') {
        return inter.showModal(new ModalBuilder()
          .setCustomId('ticket:paypal_modal')
          .setTitle('PayPal Purchase')
          .addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('plan').setLabel('Which plan are you looking to purchase?').setPlaceholder('Monthly or Lifetime').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('paypal_email').setLabel('Your PayPal email address').setPlaceholder('e.g. yourname@email.com').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('extra').setLabel('Anything else we should know? (optional)').setPlaceholder('e.g. questions about the product').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(300))
          ))
      }

      if (action === 'donutsmp_open') {
        return inter.showModal(new ModalBuilder()
          .setCustomId('ticket:donutsmp_modal')
          .setTitle('🍩 DonutSMP Pay')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('plan').setLabel('Which license? (see prices below)').setPlaceholder('30 Days ($400M) or Lifetime ($800M)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('donut_username').setLabel('Your DonutSMP in-game username').setPlaceholder('e.g. Steve123').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(64)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('discord_tag').setLabel('Your Discord username').setPlaceholder('e.g. yourname or yourname#1234').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(64)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('extra').setLabel('Anything else? (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(300)
            )
          ))
      }

      if (action === 'media_open') {
        return inter.showModal(new ModalBuilder()
          .setCustomId('ticket:media_modal')
          .setTitle('🎬 Media Application')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('channel_link').setLabel('Your channel link (YouTube, TikTok, etc.)').setPlaceholder('https://youtube.com/@yourchannel or https://tiktok.com/@you').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('video_links').setLabel('Links to your 2 videos').setPlaceholder('Video 1: https://...\nVideo 2: https://...').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(400)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('total_views').setLabel('Combined view count across both videos').setPlaceholder('e.g. 12,400').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('license_type').setLabel('Do you have a Monthly or Lifetime license?').setPlaceholder('Monthly / Lifetime').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('understand').setLabel('Do you understand your responsibilities?').setPlaceholder('As media you must create content and promote Zenith Macros. Type "Yes, I understand."').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(60)
            )
          ))
      }

      if (action === 'bug_open') {
        return inter.showModal(new ModalBuilder()
          .setCustomId('ticket:bug_modal')
          .setTitle('Bug Report')
          .addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('category').setLabel('Which feature is affected?').setPlaceholder('e.g. Triggerbot / Hit Crystal / Single Anchor / Other').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Describe the bug in detail').setPlaceholder('What happened? What did you expect?').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(900)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('repro').setLabel('How do you reproduce it? (steps)').setPlaceholder('1. Open the app  2. Enable X  3. ...').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(400))
          ))
      }

      if (action === 'account_open') {
        return inter.showModal(new ModalBuilder()
          .setCustomId('ticket:account_modal')
          .setTitle('Account Issues')
          .addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('issue_type').setLabel('What type of issue are you experiencing?').setPlaceholder('e.g. License not working / HWID Reset / Lost key').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Describe your issue in detail').setPlaceholder('Include your license key, what error you see, and when it started.').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(900)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('discord_or_email').setLabel('Email or Discord linked to your account').setPlaceholder('e.g. yourname@email.com or YourDiscordTag').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100))
          ))
      }

      return
    }

    if (inter.isButton()) {
      const [scope, action, value] = inter.customId.split(':')
      if (scope === 'rating' && action === 'open') {
        const plan = value === 'lifetime' ? 'lifetime' : 'monthly'
        const modal = new ModalBuilder()
          .setCustomId(`rating:submit:${plan}`)
          .setTitle('Rate Zenith Macros')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('stars')
                .setLabel('Stars (1-5)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('5')
                .setRequired(true)
                .setMaxLength(1)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('review')
                .setLabel('Short review (min 3 words)')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(500)
            )
          )
        return inter.showModal(modal)
      }
      if (scope === 'giveaway') {
        const giveaway = state.giveaways[value]
        if (!giveaway) return inter.reply({ content: 'Giveaway not found.', ephemeral: true })
        if (action === 'join') {
          await inter.deferReply({ ephemeral: true })
          if (giveaway.ended || Date.now() >= Number(giveaway.endsAt || 0)) {
            await endGiveaway(giveaway.id, 'expired')
            return inter.editReply('This giveaway has already ended.')
          }
          giveaway.participants = Array.isArray(giveaway.participants) ? giveaway.participants : []
          if (giveaway.participants.includes(inter.user.id)) return inter.editReply('You are already entered in this giveaway.')
          if (giveaway.minInvites > 0) {
            const inviteCount = await getInviteCountForUser(inter.guild, inter.user.id)
            if (inviteCount < giveaway.minInvites) return inter.editReply(`You need at least ${giveaway.minInvites} invite(s) to enter. You have ${Math.max(0, inviteCount)}.`)
          }
          giveaway.participants.push(inter.user.id)
          saveState()
          await refreshGiveawayMessage(giveaway)
          return inter.editReply(`You joined **${giveaway.title || 'this giveaway'}**! Good luck!`)
        }
        if (action === 'leave') {
          await inter.deferReply({ ephemeral: true })
          giveaway.participants = Array.isArray(giveaway.participants) ? giveaway.participants : []
          if (!giveaway.participants.includes(inter.user.id)) return inter.editReply('You are not entered in this giveaway.')
          giveaway.participants = giveaway.participants.filter(id => id !== inter.user.id)
          saveState()
          await refreshGiveawayMessage(giveaway)
          return inter.editReply('You left the giveaway.')
        }
        if (action === 'reroll') {
          const canManage = isAdmin(inter.member) || hasSupport(inter.member) || giveaway.hostId === inter.user.id || isKeyManagerUser(inter)
          if (!canManage) return inter.reply({ content: 'Permission required to reroll.', ephemeral: true })
          await inter.deferReply({ ephemeral: true })
          const updated = await rerollGiveaway(giveaway.id, inter.user.id)
          const winners = Array.isArray(updated?.winners) ? updated.winners : []
          if (!winners.length) return inter.editReply('Reroll complete, but no eligible replacements found.')
          return inter.editReply(`Rerolled. New winner(s): ${winners.map(id => `<@${id}>`).join(', ')}`)
        }
        return inter.reply({ content: 'Unknown giveaway action.', ephemeral: true })
      }
      if (scope === 'keypanel') {
        if (!isKeyManagerUser(inter)) {
          return inter.reply({ content: 'Only the configured key manager can use this panel.', ephemeral: true })
        }
        if (action === 'list') {
          await inter.deferReply({ ephemeral: true })
          const payload = await buildKeyListReplyPayload({ view: 'all', accessFilter: 'any', limitOpt: 50, showNotes: true })
          return inter.editReply(payload)
        }
        if (action === 'create') {
          const modal = new ModalBuilder()
            .setCustomId('keypanel:create_modal')
            .setTitle('Create Key')
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('access').setLabel('Access (monthly or lifetime)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(16)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('days').setLabel('Days (monthly only, optional)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('30').setMaxLength(4)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('note').setLabel('Note (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('email').setLabel('Email (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(254)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('discord_id').setLabel('Discord ID (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(64)
              )
            )
          return inter.showModal(modal)
        }
        if (action === 'lookup') {
          const modal = new ModalBuilder()
            .setCustomId('keypanel:lookup_modal')
            .setTitle('Lookup Key')
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('key').setLabel('License key').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(96)
              )
            )
          return inter.showModal(modal)
        }
        if (action === 'update') {
          const modal = new ModalBuilder()
            .setCustomId('keypanel:update_modal')
            .setTitle('Update Key')
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('key').setLabel('License key').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(96)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('access').setLabel('Access (monthly/lifetime, optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(16)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('days').setLabel('Days to extend (or "clear")').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(16)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('active').setLabel('Active? (true/false, optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(16)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('note').setLabel('Note (optional, "clear" to remove)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300)
              )
            )
          return inter.showModal(modal)
        }
        if (action === 'extend') {
          const modal = new ModalBuilder()
            .setCustomId('keypanel:extend_modal')
            .setTitle('Extend Key')
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('key').setLabel('License key').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(96)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('days').setLabel('Days to extend').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('30').setMaxLength(4)
              )
            )
          return inter.showModal(modal)
        }
        if (action === 'reset') {
          const modal = new ModalBuilder()
            .setCustomId('keypanel:reset_modal')
            .setTitle('Reset HWID')
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('key').setLabel('License key').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(96)
              )
            )
          return inter.showModal(modal)
        }
        if (action === 'toggle') {
          const modal = new ModalBuilder()
            .setCustomId('keypanel:toggle_modal')
            .setTitle('Toggle Key Active State')
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('key').setLabel('License key').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(96)
              )
            )
          return inter.showModal(modal)
        }
        if (action === 'delete') {
          const modal = new ModalBuilder()
            .setCustomId('keypanel:delete_modal')
            .setTitle('Delete Key')
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('key').setLabel('License key').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(96)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('confirm').setLabel('Type DELETE to confirm').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(12)
              )
            )
          return inter.showModal(modal)
        }
        if (action === 'note') {
          const modal = new ModalBuilder()
            .setCustomId('keypanel:note_modal')
            .setTitle('View or Set Note')
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('key').setLabel('License key').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(96)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('note').setLabel('Leave empty to view, or set note ("clear" to remove)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(300)
              )
            )
          return inter.showModal(modal)
        }
        return inter.reply({ content: 'Unknown key panel action.', ephemeral: true })
      }

      // ── userinfo action buttons ─────────────────────────────────────────
      if (scope === 'ui') {
        if (!isKeyManagerUser(inter)) return inter.reply({ content: 'Only the configured key manager can use these buttons.', ephemeral: true })
        const discordId = value  // third segment of customId: ui:action:discordId

        // Fetch the user's primary key to pre-populate modals
        let prefillKey = ''
        try {
          const r = await botApiGet(`/api/bot/discord/licenses?discord_id=${encodeURIComponent(discordId)}`)
          const lics = Array.isArray(r?.licenses) ? r.licenses : []
          const active = lics.filter(l => l.active && !keyExpired(l))
          const primary = active.find(l => l.access === 'lifetime') || active[0] || lics[0]
          prefillKey = primary?.key || ''
        } catch (_) {}

        const multiHint = prefillKey ? '' : '(no key found — enter manually)'

        if (action === 'reset_hwid') {
          return inter.showModal(
            new ModalBuilder().setCustomId(`ui:reset_hwid_modal:${discordId}`).setTitle('Reset HWID').addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('key').setLabel('License key').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(96).setValue(prefillKey)
              )
            )
          )
        }
        if (action === 'extend') {
          return inter.showModal(
            new ModalBuilder().setCustomId(`ui:extend_modal:${discordId}`).setTitle('Extend Key').addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('key').setLabel('License key').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(96).setValue(prefillKey)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('days').setLabel('Days to extend').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('30').setMaxLength(4)
              )
            )
          )
        }
        if (action === 'revoke') {
          return inter.showModal(
            new ModalBuilder().setCustomId(`ui:revoke_modal:${discordId}`).setTitle('Revoke Key').addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('key').setLabel(`License key ${multiHint}`).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(96).setValue(prefillKey)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('confirm').setLabel('Type REVOKE to confirm').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(16)
              )
            )
          )
        }
        if (action === 'new_key') {
          return inter.showModal(
            new ModalBuilder().setCustomId(`ui:new_key_modal:${discordId}`).setTitle('Create New Key').addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('access').setLabel('Access (monthly or lifetime)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(16).setValue('monthly')
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('days').setLabel('Days (monthly only)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('30').setMaxLength(4)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('note').setLabel('Note (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300)
              )
            )
          )
        }
        if (action === 'unblock') {
          return inter.showModal(
            new ModalBuilder().setCustomId(`ui:unblock_modal:${discordId}`).setTitle('Unblock IP').addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('ip').setLabel("User's IP address").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(45).setPlaceholder('e.g. 123.45.67.89')
              )
            )
          )
        }
        return inter.reply({ content: 'Unknown action.', ephemeral: true })
      }

      if (scope !== 'ticket') return

      // ── Stripe info (no ticket, just redirect) ──────────────────────────
      if (action === 'stripe_info') {
        return inter.reply({
          embeds: [new EmbedBuilder()
            .setColor(0x8b5cf6)
            .setTitle('💳 Purchase via Stripe')
            .setDescription('All card, bank, Apple Pay, Google Pay, and iDEAL payments are processed instantly through **Stripe**.\n\n**Head to our pricing page to get started:**\n> 🛒 **https://zenithmacros.store/#pricing**\n\nAfter purchasing, your license key and download link will be available in your dashboard on the website.')
            .setFooter({ text: 'Zenith Macros • Powered by Stripe' })],
          ephemeral: true
        })
      }

      // ── Refund info (no ticket, just redirect) ───────────────────────────
      if (action === 'refund_info') {
        return inter.reply({
          embeds: [new EmbedBuilder()
            .setColor(0xef4444)
            .setTitle('💰 Refund Policy')
            .setDescription('Before opening a ticket, please review our refund policy.\n\n**Our refund page:**\n> 🔗 **https://zenithmacros.store/refund.html**\n\nIf you\'ve read the policy and still need to request a refund, open a ticket and a staff member will assist you.')
            .setFooter({ text: 'Zenith Macros • Support' })],
          ephemeral: true
        })
      }

      // ── PayPal purchase → modal ──────────────────────────────────────────
      if (action === 'paypal_open') {
        const modal = new ModalBuilder()
          .setCustomId('ticket:paypal_modal')
          .setTitle('PayPal Purchase')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('plan')
                .setLabel('Which plan are you looking to purchase?')
                .setPlaceholder('Monthly or Lifetime')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(50)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('paypal_email')
                .setLabel('Your PayPal email address')
                .setPlaceholder('e.g. yourname@email.com')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(100)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('extra')
                .setLabel('Anything else we should know? (optional)')
                .setPlaceholder('e.g. have questions about the product, etc.')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(false)
                .setMaxLength(300)
            )
          )
        return inter.showModal(modal)
      }

      // ── Bug report → modal ───────────────────────────────────────────────
      if (action === 'bug_open') {
        const modal = new ModalBuilder()
          .setCustomId('ticket:bug_modal')
          .setTitle('Bug Report')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('category')
                .setLabel('Which feature is affected?')
                .setPlaceholder('e.g. Triggerbot / Hit Crystal / Single Anchor / Other')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(80)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('description')
                .setLabel('Describe the bug in detail')
                .setPlaceholder('What happened? What did you expect? Include your game and any settings.')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(900)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('repro')
                .setLabel('How do you reproduce it? (steps)')
                .setPlaceholder('1. Open the app  2. Enable X  3. ...')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(false)
                .setMaxLength(400)
            )
          )
        return inter.showModal(modal)
      }

      // ── Account issues → modal ───────────────────────────────────────────
      if (action === 'account_open') {
        const modal = new ModalBuilder()
          .setCustomId('ticket:account_modal')
          .setTitle('Account Issues')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('issue_type')
                .setLabel('What type of issue are you experiencing?')
                .setPlaceholder('e.g. License not working / HWID Reset / Lost key / Login issue / Other')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(100)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('description')
                .setLabel('Describe your issue in detail')
                .setPlaceholder('Include your license key (if you have it), what error you see, and when it started.')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(900)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('discord_or_email')
                .setLabel('Email or Discord linked to your account')
                .setPlaceholder('e.g. yourname@email.com or YourDiscordTag')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setMaxLength(100)
            )
          )
        return inter.showModal(modal)
      }

      if (action === 'create') return createTicket(inter, value || 'support')
      if (!isTicket(inter.channel)) return inter.reply({ content: 'Not a ticket channel.', ephemeral: true })
      if (action === 'claim') {
        if (!(isAdmin(inter.member) || hasSupport(inter.member))) return inter.reply({ content: 'Support permission required.', ephemeral: true })
        const t = parseTicket(inter.channel)
        t.owner = inter.user.id
        await inter.channel.setTopic(ticketTopic(t))
        const meta = ticketMeta(inter.channel.id)
        meta.claimedBy = inter.user.id
        meta.lastUpdatedAt = Date.now()
        saveState()
        return inter.reply({ content: `Claimed by ${inter.user}.` })
      }
      if (action === 'transcript') {
        if (!canTicket(inter.member, inter.channel)) return inter.reply({ content: 'No permission.', ephemeral: true })
        await transcript(inter.channel, inter.user.id, 'Button export')
        return inter.reply({ content: 'Transcript sent.', ephemeral: true })
      }
      if (action === 'urgent') {
        if (!canTicket(inter.member, inter.channel)) return inter.reply({ content: 'No permission.', ephemeral: true })
        const t = parseTicket(inter.channel)
        t.prio = 'urgent'
        await inter.channel.setTopic(ticketTopic(t))
        const meta = ticketMeta(inter.channel.id)
        meta.urgent = true
        if (meta.status === 'resolved') meta.status = 'open'
        meta.lastUpdatedAt = Date.now()
        saveState()
        return inter.reply({ content: 'Ticket marked as urgent.' })
      }
      if (action === 'close') {
        if (!canTicket(inter.member, inter.channel)) return inter.reply({ content: 'No permission.', ephemeral: true })
        const closeEmbed = new EmbedBuilder()
          .setColor(0xef4444)
          .setTitle('🔒 Close Ticket?')
          .setDescription(`${inter.user} has requested to close this ticket.\n\nPress **Confirm Close** to close and save the transcript, or **Cancel** to keep it open.`)
          .setTimestamp()
        const closeRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`ticket:close_confirm:${inter.user.id}`).setLabel('Confirm Close').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
          new ButtonBuilder().setCustomId(`ticket:close_cancel:${inter.user.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('✖️')
        )
        return inter.reply({ embeds: [closeEmbed], components: [closeRow] })
      }
    }
    if (inter.isModalSubmit() && inter.customId.startsWith('keypanel:')) {
      if (!isKeyManagerUser(inter)) return inter.reply({ content: 'Only the configured key manager can use this panel.', ephemeral: true })
      const action = inter.customId.split(':')[1] || ''
      await inter.deferReply({ ephemeral: true })

      if (action === 'create_modal') {
        const accessRaw = String(inter.fields.getTextInputValue('access') || '').trim().toLowerCase()
        const access = accessRaw === 'lifetime' ? 'lifetime' : (accessRaw === 'monthly' ? 'monthly' : '')
        if (!access) return inter.editReply('Access must be `monthly` or `lifetime`.')
        const daysField = parseDaysText(inter.fields.getTextInputValue('days') || '')
        if (!daysField.ok) return inter.editReply('Days must be a positive number (or blank).')
        if (daysField.clearExpiry) return inter.editReply('For create, days must be blank or a number.')
        const days = daysField.hasValue ? daysField.days : 30
        const noteRaw = normalizeClearableText(inter.fields.getTextInputValue('note') || '')
        const emailRaw = normalizeClearableText(inter.fields.getTextInputValue('email') || '')
        const discordRaw = normalizeClearableText(inter.fields.getTextInputValue('discord_id') || '')
        const expiresAt = access === 'lifetime' ? null : new Date(Date.now() + days * 86400000).toISOString()
        const created = await createKeyWithFallback({
          access,
          expiresAt,
          note: noteRaw.hasValue ? noteRaw.value : '',
          email: emailRaw.hasValue ? emailRaw.value : '',
          discordId: discordRaw.hasValue ? discordRaw.value : ''
        })
        if (!created?.ok || !created?.key) return inter.editReply(created?.error || 'Failed to create key.')
        const lookup = await lookupKeyByInput(created.key)
        if (!lookup.found) return inter.editReply(`Created key: \`${created.key}\``)
        return inter.editReply({
          content: 'Key created successfully.',
          embeds: [keyInfoEmbed(lookup.found, { title: 'Created Key' })]
        })
      }

      if (action === 'lookup_modal') {
        const key = inter.fields.getTextInputValue('key')
        const lookup = await lookupKeyByInput(key)
        if (!lookup.found) return inter.editReply('Key not found.')
        return inter.editReply({ embeds: [keyInfoEmbed(lookup.found)] })
      }

      if (action === 'update_modal') {
        const payload = { key: inter.fields.getTextInputValue('key') }
        const accessRaw = String(inter.fields.getTextInputValue('access') || '').trim().toLowerCase()
        if (accessRaw) {
          if (!['monthly', 'lifetime'].includes(accessRaw)) return inter.editReply('Access must be `monthly` or `lifetime`.')
          payload.access = accessRaw
        }
        const daysField = parseDaysText(inter.fields.getTextInputValue('days') || '')
        if (!daysField.ok) return inter.editReply('Days must be a positive number, blank, or `clear`.')
        if (daysField.hasValue) {
          if (daysField.clearExpiry) payload.clearExpiry = true
          else payload.days = daysField.days
        }
        const activeField = parseToggleText(inter.fields.getTextInputValue('active') || '')
        if (!activeField.ok) return inter.editReply('Active must be true/false (or blank).')
        if (activeField.hasValue) payload.active = activeField.value

        const noteField = normalizeClearableText(inter.fields.getTextInputValue('note') || '')
        if (noteField.hasValue) payload.note = noteField.value

        const updated = await botApiPost('/api/bot/key-update', payload)
        if (!updated?.ok) return inter.editReply(updated?.error || 'Failed to update key.')
        const keyData = updated.license || (await lookupKeyByInput(payload.key)).found
        if (!keyData) return inter.editReply(`Updated \`${normKey(payload.key)}\`.`)
        return inter.editReply({
          content: 'Key updated successfully.',
          embeds: [keyInfoEmbed(keyData, { title: 'Updated Key' })]
        })
      }

      if (action === 'extend_modal') {
        const key = inter.fields.getTextInputValue('key')
        const days = Number(inter.fields.getTextInputValue('days') || 0)
        if (!Number.isFinite(days) || days < 1) return inter.editReply('Days must be a positive number.')
        const result = await botApiPost('/api/bot/key-extend', { key, days: Math.floor(days) })
        if (!result?.ok) return inter.editReply(result?.error || 'Failed to extend key.')
        const lookup = await lookupKeyByInput(key)
        if (!lookup.found) return inter.editReply(`Extended key. New expiry: ${result.expiresAt}`)
        return inter.editReply({
          content: `Extended key by ${Math.floor(days)} day(s).`,
          embeds: [keyInfoEmbed(lookup.found, { title: 'Extended Key' })]
        })
      }

      if (action === 'reset_modal') {
        const key = inter.fields.getTextInputValue('key')
        const result = await botApiPost('/api/bot/key-reset-hwid', { key })
        if (!result?.ok) return inter.editReply(result?.error || 'Failed to reset HWID.')
        const lookup = await lookupKeyByInput(key)
        if (!lookup.found) return inter.editReply('HWID reset.')
        return inter.editReply({
          content: 'HWID reset successfully.',
          embeds: [keyInfoEmbed(lookup.found, { title: 'HWID Reset' })]
        })
      }

      if (action === 'toggle_modal') {
        const key = inter.fields.getTextInputValue('key')
        const result = await botApiPost('/api/bot/key-toggle', { key })
        if (!result?.ok) return inter.editReply(result?.error || 'Failed to toggle key.')
        const lookup = await lookupKeyByInput(key)
        if (!lookup.found) return inter.editReply(`Key is now ${result.active ? 'active' : 'inactive'}.`)
        return inter.editReply({
          content: `Key is now ${result.active ? 'active' : 'inactive'}.`,
          embeds: [keyInfoEmbed(lookup.found, { title: 'Toggled Key' })]
        })
      }

      if (action === 'delete_modal') {
        const key = inter.fields.getTextInputValue('key')
        const confirm = String(inter.fields.getTextInputValue('confirm') || '').trim().toUpperCase()
        if (confirm !== 'DELETE') return inter.editReply('Deletion cancelled. Type `DELETE` exactly to confirm.')
        const result = await botApiPost('/api/bot/key-delete', { key })
        return inter.editReply(result?.ok ? `Deleted key \`${normKey(key)}\`.` : (result?.error || 'Failed to delete key.'))
      }

      if (action === 'note_modal') {
        const key = inter.fields.getTextInputValue('key')
        const noteInput = inter.fields.getTextInputValue('note') || ''
        const noteField = normalizeClearableText(noteInput)
        if (!noteField.hasValue) {
          const lookup = await lookupKeyByInput(key)
          if (!lookup.found) return inter.editReply('Key not found.')
          return inter.editReply({
            content: `Current note: ${lookup.found.note ? `\`${String(lookup.found.note).slice(0, 300)}\`` : '`-`'}`,
            embeds: [keyInfoEmbed(lookup.found, { title: 'Key Note' })]
          })
        }
        const updated = await botApiPost('/api/bot/key-update', { key, note: noteField.value })
        if (!updated?.ok) return inter.editReply(updated?.error || 'Failed to update note.')
        const keyData = updated.license || (await lookupKeyByInput(key)).found
        if (!keyData) return inter.editReply('Note updated.')
        return inter.editReply({
          content: 'Note updated successfully.',
          embeds: [keyInfoEmbed(keyData, { title: 'Updated Note' })]
        })
      }

      return inter.editReply('Unknown key panel modal action.')
    }

    if (inter.isModalSubmit() && inter.customId.startsWith('ui:')) {
      if (!isKeyManagerUser(inter)) return inter.reply({ content: 'Only the configured key manager can use these actions.', ephemeral: true })
      const parts = inter.customId.split(':')
      const uiAction = parts[1]
      await inter.deferReply({ ephemeral: true })

      if (uiAction === 'reset_hwid_modal') {
        const key = inter.fields.getTextInputValue('key')
        const result = await botApiPost('/api/bot/key-reset-hwid', { key })
        if (!result?.ok) return inter.editReply(result?.error || 'Failed to reset HWID.')
        const lookup = await lookupKeyByInput(key)
        return inter.editReply({
          content: 'HWID reset successfully.',
          embeds: lookup.found ? [keyInfoEmbed(lookup.found, { title: 'HWID Reset' })] : []
        })
      }

      if (uiAction === 'extend_modal') {
        const key = inter.fields.getTextInputValue('key')
        const days = Number(inter.fields.getTextInputValue('days') || 0)
        if (!Number.isFinite(days) || days < 1) return inter.editReply('Days must be a positive number.')
        const result = await botApiPost('/api/bot/key-extend', { key, days: Math.floor(days) })
        if (!result?.ok) return inter.editReply(result?.error || 'Failed to extend key.')
        const lookup = await lookupKeyByInput(key)
        return inter.editReply({
          content: `Extended by ${Math.floor(days)} day(s).`,
          embeds: lookup.found ? [keyInfoEmbed(lookup.found, { title: 'Extended Key' })] : []
        })
      }

      if (uiAction === 'revoke_modal') {
        const key = inter.fields.getTextInputValue('key')
        const confirm = String(inter.fields.getTextInputValue('confirm') || '').trim().toUpperCase()
        if (confirm !== 'REVOKE') return inter.editReply('Cancelled. Type `REVOKE` exactly to confirm.')
        const result = await botApiPost('/api/bot/key-update', { key, active: false })
        if (!result?.ok) return inter.editReply(result?.error || 'Failed to revoke key.')
        return inter.editReply(`Key \`${normKey(key)}\` has been revoked.`)
      }

      if (uiAction === 'new_key_modal') {
        const discordId = parts[2] || ''
        const accessRaw = String(inter.fields.getTextInputValue('access') || '').trim().toLowerCase()
        const access = accessRaw === 'lifetime' ? 'lifetime' : (accessRaw === 'monthly' ? 'monthly' : '')
        if (!access) return inter.editReply('Access must be `monthly` or `lifetime`.')
        const daysRaw = Number(inter.fields.getTextInputValue('days') || 30)
        const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.floor(daysRaw) : 30
        const noteRaw = String(inter.fields.getTextInputValue('note') || '').trim()
        const expiresAt = access === 'lifetime' ? null : new Date(Date.now() + days * 86400000).toISOString()
        const created = await createKeyWithFallback({ access, expiresAt, note: noteRaw, discordId })
        if (!created?.ok || !created?.key) return inter.editReply(created?.error || 'Failed to create key.')
        const lookup = await lookupKeyByInput(created.key)
        return inter.editReply({
          content: `New key created${discordId ? ` and linked to <@${discordId}>` : ''}.`,
          embeds: lookup.found ? [keyInfoEmbed(lookup.found, { title: 'New Key' })] : []
        })
      }

      if (uiAction === 'unblock_modal') {
        const ip = String(inter.fields.getTextInputValue('ip') || '').trim()
        if (!ip) return inter.editReply('IP address is required.')
        const result = await botApiPost('/v1/admin/anomaly/clear', { ip })
        if (!result?.ok) return inter.editReply(result?.error || 'Failed to unblock IP.')
        return inter.editReply(`IP \`${ip}\` has been unblocked. The user can now retry their key.`)
      }

      return inter.editReply('Unknown action.')
    }

    if (inter.isModalSubmit() && inter.customId.startsWith('rating:submit:')) {
      const plan = inter.customId.split(':')[2] === 'lifetime' ? 'Lifetime' : 'Monthly'
      const starsRaw = String(inter.fields.getTextInputValue('stars') || '').trim()
      const review = fmt(inter.fields.getTextInputValue('review') || '')
      const stars = Number(starsRaw)
      if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
        return inter.reply({ content: 'Stars must be a number from 1 to 5.', ephemeral: true })
      }
      const wordCount = review.split(/\s+/).filter(Boolean).length
      if (wordCount < 3) return inter.reply({ content: 'Your review must be at least 3 words.', ephemeral: true })

      const ch = await client.channels.fetch(CFG.ratingsChannel).catch(() => null)
      if (!ch || ch.type !== ChannelType.GuildText) {
        return inter.reply({ content: 'Ratings channel is not configured correctly.', ephemeral: true })
      }
      const starsText = '*'.repeat(stars) + '.'.repeat(5 - stars)
      const emb = new EmbedBuilder()
        .setColor(0xf59e0b)
        .setTitle('Anonymous Client Rating')
        .addFields(
          { name: 'Plan', value: plan, inline: true },
          { name: 'Stars', value: `${starsText} (${stars}/5)`, inline: true },
          { name: 'Review', value: review }
        )
        .setTimestamp(new Date())
      await ch.send({ embeds: [emb] })
      return inter.reply({ content: 'Thank you. Your anonymous rating was submitted.', ephemeral: true })
    }
    if (inter.isModalSubmit() && inter.customId.startsWith('embedmodal:')) {
      if (!isAdmin(inter.member) && !isKeyManagerUser(inter)) return inter.reply({ content: 'Admin permission required.', ephemeral: true })
      const channelId = inter.customId.split(':')[1]
      const ch = await inter.guild.channels.fetch(channelId).catch(() => null)
      if (!ch || ch.type !== ChannelType.GuildText) return inter.reply({ content: 'Target channel not found.', ephemeral: true })
      const title = fmt(inter.fields.getTextInputValue('title') || '')
      const description = fmt(inter.fields.getTextInputValue('description') || '')
      const colorInput = fmt(inter.fields.getTextInputValue('color') || '').replace('#', '')
      const e = new EmbedBuilder().setColor(col(colorInput)).setTitle(title || 'Update').setDescription(description || ' ')
      await ch.send({ embeds: [e] })
      return inter.reply({ content: 'Embed sent.', ephemeral: true })
    }
    if (inter.isModalSubmit() && inter.customId.startsWith('saymodal:')) {
      if (!isAdmin(inter.member) && !isKeyManagerUser(inter)) return inter.reply({ content: 'Admin permission required.', ephemeral: true })
      const channelId = inter.customId.split(':')[1]
      const ch = await inter.guild.channels.fetch(channelId).catch(() => null)
      if (!ch || ch.type !== ChannelType.GuildText) return inter.reply({ content: 'Target channel not found.', ephemeral: true })
      const message = fmt(inter.fields.getTextInputValue('message') || '')
      await ch.send({ content: message || ' ' })
      return inter.reply({ content: 'Message sent.', ephemeral: true })
    }
    if (inter.isModalSubmit() && inter.customId === 'ticket:donutsmp_modal') {
      const plan = inter.fields.getTextInputValue('plan') || ''
      const username = inter.fields.getTextInputValue('donut_username') || ''
      const discordTag = inter.fields.getTextInputValue('discord_tag') || ''
      const extra = inter.fields.getTextInputValue('extra') || ''
      const fields = [
        { name: '🍩 DonutSMP Username', value: username || '—', inline: true },
        { name: '📦 License Wanted', value: plan || '—', inline: true },
        { name: '💰 Price', value: plan.toLowerCase().includes('lifetime') ? '**$800M**' : '**$400M** (30 days)', inline: true },
        { name: '🏷️ Discord', value: discordTag || '—', inline: true },
        ...(extra ? [{ name: '💬 Extra Info', value: extra, inline: false }] : [])
      ]
      return createTicket(inter, 'donutsmp', { fields })
    }

    if (inter.isModalSubmit() && inter.customId === 'ticket:media_modal') {
      const channelLink = inter.fields.getTextInputValue('channel_link') || ''
      const videoLinks = inter.fields.getTextInputValue('video_links') || ''
      const totalViews = inter.fields.getTextInputValue('total_views') || ''
      const licenseType = inter.fields.getTextInputValue('license_type') || ''
      const understand = inter.fields.getTextInputValue('understand') || ''
      const fields = [
        { name: '📺 Channel', value: channelLink || '—', inline: false },
        { name: '🎬 Video Links', value: videoLinks || '—', inline: false },
        { name: '👀 Combined Views', value: totalViews || '—', inline: true },
        { name: '🔑 License Type', value: licenseType || '—', inline: true },
        { name: '✅ Understands Responsibilities', value: understand || '—', inline: false },
      ]
      return createTicket(inter, 'media', { fields })
    }
    if (inter.isModalSubmit() && inter.customId === 'ticket:paypal_modal') {
      const plan = inter.fields.getTextInputValue('plan') || ''
      const email = inter.fields.getTextInputValue('paypal_email') || ''
      const extra = inter.fields.getTextInputValue('extra') || ''
      const fields = [
        { name: '📦 Plan Requested', value: plan || 'Not specified', inline: true },
        { name: '📧 PayPal Email', value: email || 'Not provided', inline: true }
      ]
      if (extra) fields.push({ name: '📝 Additional Info', value: extra, inline: false })
      return createTicket(inter, 'paypal', { fields })
    }

    if (inter.isModalSubmit() && inter.customId === 'ticket:bug_modal') {
      const category = inter.fields.getTextInputValue('category') || ''
      const description = inter.fields.getTextInputValue('description') || ''
      const repro = inter.fields.getTextInputValue('repro') || ''
      const fields = [
        { name: '🗂️ Affected Feature', value: category || 'Not specified', inline: false },
        { name: '🐛 Bug Description', value: description || 'Not provided', inline: false }
      ]
      if (repro) fields.push({ name: '🔁 Steps to Reproduce', value: repro, inline: false })
      return createTicket(inter, 'bug', { fields })
    }

    if (inter.isModalSubmit() && inter.customId === 'ticket:account_modal') {
      const issueType = inter.fields.getTextInputValue('issue_type') || ''
      const description = inter.fields.getTextInputValue('description') || ''
      const contact = inter.fields.getTextInputValue('discord_or_email') || ''
      const fields = [
        { name: '⚠️ Issue Type', value: issueType || 'Not specified', inline: false },
        { name: '📋 Description', value: description || 'Not provided', inline: false }
      ]
      if (contact) fields.push({ name: '📧 Account Email / Discord', value: contact, inline: false })
      return createTicket(inter, 'account', { fields })
    }

    // ── Ticket close confirm/cancel buttons ─────────────────────────────────
    if (inter.isButton() && inter.customId.startsWith('ticket:close_confirm:')) {
      if (!isTicket(inter.channel)) return inter.reply({ content: 'Not a ticket channel.', ephemeral: true })
      const closingChannel = inter.channel
      await inter.update({ embeds: [new EmbedBuilder().setColor(0xef4444).setTitle('🔒 Closing ticket...').setDescription('Saving transcript and closing. See you next time!')], components: [] })
      await transcript(closingChannel, inter.user.id, '')
      delete state.tickets[closingChannel.id]
      saveState()
      setTimeout(() => closingChannel.delete().catch(() => {}), 2000)
      return
    }
    if (inter.isButton() && inter.customId.startsWith('ticket:close_cancel:')) {
      if (!isTicket(inter.channel)) return inter.reply({ content: 'Not a ticket channel.', ephemeral: true })
      // Anyone in the ticket can cancel
      await inter.update({ embeds: [new EmbedBuilder().setColor(0x22c55e).setTitle('✅ Close Cancelled').setDescription(`${inter.user} cancelled the close request. The ticket remains open.`)], components: [] })
      return
    }
    if (!inter.isChatInputCommand()) return
    const n = inter.commandName

    // ── Cooldown check ──────────────────────────────────────────────────────
    const subCmd = inter.options.getSubcommand(false)
    const cooldownKey = subCmd ? `${n} ${subCmd}` : n
    const cooldownRemaining = cooldowns.checkAndRecord(inter.user.id, cooldownKey)
    if (cooldownRemaining > 0) {
      return inter.reply({
        content: `⏳ Please wait **${cooldownRemaining}s** before using this command again.`,
        ephemeral: true
      })
    }

    // ── /rating ──────────────────────────────────────────────────────────────
    if (n === 'rating') {
      // Customers only
      const hasCustomerRole = CFG.customerRoleId && inter.member?.roles?.cache?.has(CFG.customerRoleId)
      if (!hasCustomerRole) {
        return inter.reply({
          content: '❌ Only verified customers can leave a rating. Purchase a license at <https://zenithmacros.store> to get access.',
          ephemeral: true
        })
      }

      const stars       = inter.options.getInteger('stars', true)
      const description = (inter.options.getString('description') || '').trim()
      const anonymous   = inter.options.getBoolean('anonymous') ?? false

      // Ratings under 4★ require a meaningful description (min 8 words)
      if (stars < 4) {
        const wordCount = description.split(/\s+/).filter(Boolean).length
        if (wordCount < 8) {
          // Ban the user — no short low-star reviews allowed
          try {
            await inter.guild.members.ban(inter.user.id, {
              reason: `Submitted a ${stars}★ rating without sufficient explanation. Low ratings must describe a genuine macro performance issue.`
            })
          } catch (_) {}
          return inter.reply({
            content: `⛔ Ratings under **4★** require a detailed description (at least 8 words) explaining a **genuine macro performance issue**.\n\nIf you need help using the client, open an Account Issues ticket. If you found a bug, open a Bug Report ticket.\n\nYou have been removed from the server.`,
            ephemeral: true
          }).catch(() => {})
        }
      }

      const ch = await client.channels.fetch(CFG.ratingsChannel).catch(() => null)
      if (!ch || ch.type !== ChannelType.GuildText) {
        return inter.reply({ content: '⚠️ Ratings channel is not set up correctly. Please contact an admin.', ephemeral: true })
      }

      // Fetch plan from license API
      let plan = 'Customer'
      try {
        const apiRes = await botApiGet(`/api/bot/discord/licenses?discord_id=${inter.user.id}`)
        const licenses = apiRes?.licenses || []
        const active = licenses.find(l => l.active)
        if (active?.tier) plan = active.tier.charAt(0).toUpperCase() + active.tier.slice(1)
      } catch (_) {}

      // Build star display (⭐ filled, ☆ empty)
      const starFilled = '⭐'.repeat(stars)

      // Build embed matching the screenshot style
      const authorName = anonymous ? 'Anonymous' : inter.user.displayName || inter.user.username
      const emb = new EmbedBuilder()
        .setColor(0x5865f2)
        .setAuthor({
          name: `${authorName} reviewed Zenith Macros`,
          iconURL: anonymous ? null : inter.user.displayAvatarURL({ size: 64 })
        })
        .addFields(
          { name: 'Rating', value: starFilled, inline: true },
          { name: 'Plan',   value: plan,       inline: true },
          { name: 'Discord', value: anonymous ? '*Anonymous*' : `${inter.user.username} (${inter.user.id})`, inline: true }
        )
        .setFooter({ text: 'Zenith Macros Reviews' })
        .setTimestamp(new Date())

      if (description) emb.setDescription(description)

      await ch.send({ embeds: [emb] })
      return inter.reply({ content: `✅ Your ${starFilled} rating has been submitted. Thank you!`, ephemeral: true })
    }

    if (n === 'ping') return inter.reply({ content: `Pong. ${client.ws.ping}ms`, ephemeral: true })
    if (n === 'help') {
      const e = new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setTitle('Zenith Bot — Command Reference')
        .addFields(
          { name: '🎁 For Everyone', value: '`/claim_boost` — claim 7 free days for boosting the server\n`/download` — get your secure download link (customers only)' },
          { name: '👤 User Management', value: '`/user lookup` — full profile + all keys\n`/user grant` — create & send a new license\n`/user revoke` — revoke license(s)\n`/user hwid_reset` — reset hardware ID\n`/user upgrade` — upgrade to lifetime\n`/user extend` — add days to monthly\n`/user toggle` — activate / deactivate license\n`/user note` — view or set internal note' },
          { name: '⚙️ Raw Key Ops', value: '`/key create` — generate an unbound key\n`/key extend` — add days by key string\n`/key delete` — permanently delete a key' },
          { name: '🎮 Macro Grant', value: '`/macro grant` — give a user access to a specific standalone macro (use the dropdown to pick the macro)' },
          { name: '🤝 Affiliate', value: '`/affiliate info|set|clear`' },
          { name: '🎉 Giveaways', value: '`/giveaway create|end|reroll|list`' },
          { name: '🛡️ Moderation', value: '`/mod timeout|untimeout|kick|ban|unban|warn|nick|role`' },
          { name: '📢 Messaging', value: '`/say message|embed` — send via modal\n`/announce` — embed with role ping\n`/dm` — DM a user' },
          { name: '🔧 Channel Tools', value: '`/purge` `/slowmode` `/lockdown lock|unlock`' },
          { name: '📊 Info', value: '`/serverinfo` `/userinfo` `/avatar` `/roleinfo` `/poll`' },
          { name: '🎫 Tickets', value: '`/ticket_panel` `/ticket_close|add|remove|priority|claim|status|note|notes|info|move_type`' },
          { name: '🛡️ Automod', value: '`/automod_status` `/automod_toggle` `/automod_limits` `/automod_badword_*` `/automod_domain_*`' },
          { name: '🤖 Bot Admin', value: '`/bot_access add|remove|list` `/bot_channels` `/bot_config`' }
        )
      return inter.reply({ embeds: [e], ephemeral: true })
    }
    if (n === 'ticket_panel') {
      if (!isAdmin(inter.member)) return inter.reply({ content: 'Admin permission required.', ephemeral: true })
      const ch = inter.options.getChannel('channel', true); if (ch.type !== ChannelType.GuildText) return inter.reply({ content: 'Select text channel.', ephemeral: true })
      const panelEmb = new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setTitle(CFG.panelTitle)
        .setDescription(CFG.panelDescription + '\n\n**💳 Card / Bank / Apple Pay / Google Pay**\nStripe payments are handled instantly on our website — selecting this will redirect you.\n\n**💸 PayPal Purchase**\nWant to pay via PayPal? Open a ticket and we\'ll sort it out manually.\n\n**🍩 DonutSMP Pay**\nPay with DonutSMP money — **$400M = 30 Days**, **$800M = Lifetime**.\n\n**🐛 Bug Report**\nEncountered something broken? Let us know exactly what\'s happening so we can fix it fast.\n\n**👤 Account Issues**\nProblems with your license, HWID, or account access? We\'ll get you sorted.\n\n**💰 Refund Request**\nSelecting this will link you to our refund policy page. If you still need help, we\'re here.\n\n**🎬 Media Application**\nApply for the Media role and a free monthly license for a friend. Requirements: 2 videos on any platform (YouTube, TikTok, etc. — does not have to be about Zenith), 8k+ combined views. Must already hold a Monthly or Lifetime license. Only apply after hitting requirements.')
        .setFooter({ text: 'Only open a ticket if you truly need help — our team responds as fast as possible.' })
      await ch.send({ embeds: [panelEmb], components: panelRows() })
      return inter.reply({ content: 'Ticket panel posted.', ephemeral: true })
    }
    if (n === 'key') {
      if (!isKeyManagerUser(inter)) return inter.reply({ content: 'Only the configured key manager can use this command.', ephemeral: true })
      const sub = inter.options.getSubcommand(true)
      await inter.deferReply({ ephemeral: true })

      if (sub === 'create') {
        const access = inter.options.getString('access', true)
        const days = clamp(inter.options.getInteger('days') || 30, 1, 3650)
        const note = inter.options.getString('note') || ''
        const email = inter.options.getString('email') || ''
        const discordId = inter.options.getString('discord_id') || ''
        const expiresAt = access === 'lifetime' ? null : new Date(Date.now() + days * 86400000).toISOString()
        const r = await createKeyWithFallback({ access, expiresAt, note, email, discordId })
        if (!r?.ok || !r?.key) return inter.editReply(r?.error || 'Failed to create key.')
        const lookup = await lookupKeyByInput(r.key)
        if (!lookup.found) return inter.editReply(`Created key: \`${r.key}\``)
        return inter.editReply({ content: 'Key created successfully.', embeds: [keyInfoEmbed(lookup.found, { title: 'Created Key' })] })
      }

      if (sub === 'extend') {
        const key = inter.options.getString('key', true)
        const days = inter.options.getInteger('days', true)
        const r = await botApiPost('/api/bot/key-extend', { key, days })
        if (!r?.ok) return inter.editReply(r?.error || 'Failed to extend key.')
        const lookup = await lookupKeyByInput(key)
        if (!lookup.found) return inter.editReply(`Extended key to ${r.expiresAt}`)
        return inter.editReply({ content: `Extended by ${days} day(s).`, embeds: [keyInfoEmbed(lookup.found, { title: 'Extended Key' })] })
      }

      if (sub === 'delete') {
        const key = inter.options.getString('key', true)
        const r = await botApiPost('/api/bot/key-delete', { key })
        return inter.editReply(r?.ok ? `Deleted key \`${normKey(key)}\`.` : (r?.error || 'Failed to delete key.'))
      }

      return inter.editReply('Unknown key subcommand.')
    }
    if (n === 'bot_access') {
      if (!isBotOwnerUser(inter)) return inter.reply({ content: 'Only the configured bot owner can manage access.', ephemeral: true })
      const sub = inter.options.getSubcommand(true)
      if (sub === 'list') {
        const ids = [...state.botAccessUserIds]
        if (!ids.length) return inter.reply({ content: 'No extra users are allowed yet. Only the bot owner has access.', ephemeral: true })
        const lines = ids.map((id, idx) => `${idx + 1}. <@${id}> (\`${id}\`)`)
        return inter.reply({ content: `Allowed users:\n${lines.join('\n').slice(0, 1800)}`, ephemeral: true })
      }
      const target = inter.options.getUser('user', true)
      const uid = normalizeDiscordId(target.id)
      if (!uid) return inter.reply({ content: 'Invalid user selected.', ephemeral: true })
      if (sub === 'add') {
        if (CFG.ownerUserId && uid === CFG.ownerUserId) {
          return inter.reply({ content: 'That user is already the configured owner.', ephemeral: true })
        }
        if (state.botAccessUserIds.includes(uid)) {
          return inter.reply({ content: `${target} already has bot access.`, ephemeral: true })
        }
        state.botAccessUserIds.push(uid)
        state.botAccessUserIds = [...new Set(state.botAccessUserIds)]
        saveState()
        return inter.reply({ content: `Added ${target} to bot access.`, ephemeral: true })
      }
      if (sub === 'remove') {
        const before = state.botAccessUserIds.length
        state.botAccessUserIds = state.botAccessUserIds.filter(id => id !== uid)
        saveState()
        if (state.botAccessUserIds.length === before) {
          return inter.reply({ content: `${target} was not in bot access.`, ephemeral: true })
        }
        return inter.reply({ content: `Removed ${target} from bot access.`, ephemeral: true })
      }
    }
    if (['ticket_add', 'ticket_remove', 'ticket_rename', 'ticket_priority', 'ticket_transcript', 'ticket_close', 'ticket_claim', 'ticket_unclaim', 'ticket_status', 'ticket_note', 'ticket_notes', 'ticket_move_type', 'ticket_info'].includes(n)) {
      if (!isTicket(inter.channel)) return inter.reply({ content: 'Use in a ticket channel.', ephemeral: true })
      if (!canTicket(inter.member, inter.channel)) return inter.reply({ content: 'No permission.', ephemeral: true })
      const supportOnly = ['ticket_claim', 'ticket_unclaim', 'ticket_status', 'ticket_note', 'ticket_move_type']
      if (supportOnly.includes(n) && !(isAdmin(inter.member) || hasSupport(inter.member))) {
        return inter.reply({ content: 'Support permission required.', ephemeral: true })
      }
      if (n === 'ticket_add') {
        const u = inter.options.getUser('user', true); await inter.channel.permissionOverwrites.edit(u.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true }); return inter.reply({ content: `Added ${u}.` })
      }
      if (n === 'ticket_remove') {
        const u = inter.options.getUser('user', true); await inter.channel.permissionOverwrites.delete(u.id).catch(() => {}); return inter.reply({ content: `Removed ${u}.` })
      }
      if (n === 'ticket_rename') {
        const nm = inter.options.getString('name', true).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 90); await inter.channel.setName(nm || inter.channel.name); return inter.reply({ content: `Renamed to ${nm}.` })
      }
      if (n === 'ticket_priority') {
        const level = inter.options.getString('level', true)
        const t = parseTicket(inter.channel)
        t.prio = level
        await inter.channel.setTopic(ticketTopic(t))
        const meta = ticketMeta(inter.channel.id)
        meta.urgent = level === 'urgent'
        meta.lastUpdatedAt = Date.now()
        saveState()
        return inter.reply({ content: `Priority: ${level}.` })
      }
      if (n === 'ticket_transcript') { await transcript(inter.channel, inter.user.id, 'Manual export'); return inter.reply({ content: 'Transcript sent.', ephemeral: true }) }
      if (n === 'ticket_claim') {
        const claimTarget = inter.options.getUser('user') || inter.user
        const t = parseTicket(inter.channel)
        t.owner = claimTarget.id
        await inter.channel.setTopic(ticketTopic(t))
        const meta = ticketMeta(inter.channel.id)
        meta.claimedBy = claimTarget.id
        meta.lastUpdatedAt = Date.now()
        saveState()
        return inter.reply({ content: `Ticket claimed by <@${claimTarget.id}>.` })
      }
      if (n === 'ticket_unclaim') {
        const t = parseTicket(inter.channel)
        t.owner = ''
        await inter.channel.setTopic(ticketTopic(t))
        const meta = ticketMeta(inter.channel.id)
        meta.claimedBy = ''
        meta.lastUpdatedAt = Date.now()
        saveState()
        return inter.reply({ content: 'Ticket is now unclaimed.' })
      }
      if (n === 'ticket_status') {
        const status = inter.options.getString('status', true)
        const meta = ticketMeta(inter.channel.id)
        meta.status = status
        meta.lastUpdatedAt = Date.now()
        if (status === 'resolved') meta.urgent = false
        saveState()
        return inter.reply({ content: `Ticket status updated to \`${status}\`.` })
      }
      if (n === 'ticket_note') {
        const note = fmt(inter.options.getString('note', true))
        if (!note) return inter.reply({ content: 'Note cannot be empty.', ephemeral: true })
        const meta = ticketMeta(inter.channel.id)
        meta.notes.push(`[${new Date().toISOString()}] ${inter.user.tag}: ${note}`)
        if (meta.notes.length > 30) meta.notes = meta.notes.slice(-30)
        meta.lastUpdatedAt = Date.now()
        saveState()
        return inter.reply({ content: 'Ticket note added.', ephemeral: true })
      }
      if (n === 'ticket_notes') {
        const meta = ticketMeta(inter.channel.id)
        if (!meta.notes.length) return inter.reply({ content: 'No notes yet.', ephemeral: true })
        const noteText = meta.notes.slice(-10).join('\n').slice(0, 1900)
        return inter.reply({ content: `Recent notes:\n${noteText}`, ephemeral: true })
      }
      if (n === 'ticket_move_type') {
        const nextType = inter.options.getString('type', true)
        const typeCfg = CFG.ticketTypes.find(t => t.id === nextType)
        if (!typeCfg) return inter.reply({ content: 'Invalid ticket type.', ephemeral: true })
        const t = parseTicket(inter.channel)
        t.type = nextType
        await inter.channel.setTopic(ticketTopic(t))
        const newCat = CFG.ticketCatMap[nextType] || CFG.ticketCategory || null
        if (newCat && inter.channel.parentId !== newCat) await inter.channel.setParent(newCat).catch(() => {})
        const meta = ticketMeta(inter.channel.id)
        meta.typeMoves = Number(meta.typeMoves || 0) + 1
        meta.lastUpdatedAt = Date.now()
        saveState()
        return inter.reply({ content: `Ticket type moved to **${typeCfg.label}**.` })
      }
      if (n === 'ticket_info') {
        const t = parseTicket(inter.channel)
        const meta = ticketMeta(inter.channel.id)
        const e = new EmbedBuilder()
          .setColor(0x8b5cf6)
          .setTitle(`Ticket Info: ${inter.channel.name}`)
          .addFields(
            { name: 'Owner', value: t.uid ? `<@${t.uid}>` : 'Unknown', inline: true },
            { name: 'Claimed By', value: meta.claimedBy ? `<@${meta.claimedBy}>` : 'Unclaimed', inline: true },
            { name: 'Type', value: t.type || 'support', inline: true },
            { name: 'Priority', value: t.prio || 'normal', inline: true },
            { name: 'Status', value: meta.status || 'open', inline: true },
            { name: 'Urgent', value: meta.urgent ? 'Yes' : 'No', inline: true },
            { name: 'Notes', value: String((meta.notes || []).length), inline: true },
            { name: 'Type Moves', value: String(meta.typeMoves || 0), inline: true }
          )
          .setTimestamp(new Date(meta.lastUpdatedAt || Date.now()))
        return inter.reply({ embeds: [e], ephemeral: true })
      }
      if (n === 'ticket_close') {
        const closeEmbed = new EmbedBuilder()
          .setColor(0xef4444)
          .setTitle('🔒 Close Ticket?')
          .setDescription(`${inter.user} has requested to close this ticket.\n\nPress **Confirm Close** to close and save the transcript, or **Cancel** to keep it open.`)
          .setTimestamp()
        const closeRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`ticket:close_confirm:${inter.user.id}`).setLabel('Confirm Close').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
          new ButtonBuilder().setCustomId(`ticket:close_cancel:${inter.user.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('✖️')
        )
        return inter.reply({ embeds: [closeEmbed], components: [closeRow] })
      }
    }
    // ── /claim_boost ─────────────────────────────────────────────────────────
    if (n === 'claim_boost') {
      await inter.deferReply({ ephemeral: true })

      // Must be boosting the server right now
      const member = inter.member
      if (!member?.premiumSince) {
        return inter.editReply({
          embeds: [new EmbedBuilder()
            .setColor(0xef4444)
            .setTitle('Not Boosting')
            .setDescription('You need to be actively boosting the **Zenith Macros** server to claim this reward.\n\nBoost the server and then run `/claim_boost` again!')
            .setFooter({ text: 'Zenith Macros • Boost Rewards' })]
        })
      }

      let result
      try {
        result = await botApiPost('/api/bot/boost-extend', { discord_id: inter.user.id })
      } catch (err) {
        return inter.editReply('❌ Could not reach the license server. Please try again in a moment.')
      }

      if (!result?.ok) {
        if (result?.reason === 'lifetime') {
          return inter.editReply({
            embeds: [new EmbedBuilder()
              .setColor(0x8b5cf6)
              .setTitle('Lifetime Access')
              .setDescription('You have a **Lifetime** license — it never expires, so there\'s nothing to extend. Thanks for boosting either way! 💜')
              .setFooter({ text: 'Zenith Macros • Boost Rewards' })]
          })
        }
        if (result?.reason === 'max_reached') {
          const expiresAt = result.expiresAt ? new Date(result.expiresAt) : null
          const expiresStr = expiresAt
            ? expiresAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
            : 'N/A'
          return inter.editReply({
            embeds: [new EmbedBuilder()
              .setColor(0xf59e0b)
              .setTitle('Already Claimed')
              .setDescription('You\'ve already claimed the **maximum 2 boost rewards** for your account. Thank you so much for your support! 💜')
              .addFields({ name: '📅 License Expires', value: `**${expiresStr}**`, inline: true })
              .setFooter({ text: 'Zenith Macros • Boost Rewards' })]
          })
        }
        if (result?.reason === 'no_license') {
          return inter.editReply({
            embeds: [new EmbedBuilder()
              .setColor(0xef4444)
              .setTitle('No License Found')
              .setDescription('No active monthly license was found linked to your Discord account.\n\nMake sure you have purchased a license at <https://zenithmacros.store> and logged into your dashboard.')
              .setFooter({ text: 'Zenith Macros • Boost Rewards' })]
          })
        }
        return inter.editReply(`❌ ${result?.error || 'Something went wrong. Please try again.'}`)
      }

      const boostCount = result.boost_count || 1
      const expiresAt = result.expiresAt ? new Date(result.expiresAt) : null
      const expiresStr = expiresAt
        ? expiresAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
        : 'N/A'
      const isSecond = boostCount === 2

      const embed = new EmbedBuilder()
        .setColor(isSecond ? 0xf472b6 : 0x8b5cf6)
        .setTitle(isSecond ? '💖 Double Boost — Thank You!' : '🚀 Boost Reward Applied!')
        .setDescription(
          isSecond
            ? `You've boosted **Zenith Macros** twice — we really appreciate the extra support! 💜\n\nAnother **7 days** have been added to your license.`
            : `Thanks for boosting **Zenith Macros**! **7 days** have been added to your license as a thank you. 💜`
        )
        .addFields(
          { name: '⏱️ Days Added', value: '**+7 days**', inline: true },
          { name: '📅 New Expiry', value: `**${expiresStr}**`, inline: true },
          { name: '🎯 Rewards Used', value: `**${boostCount} / 2**`, inline: true }
        )
        .setFooter({ text: boostCount < 2 ? 'Boost again to earn another 7 days!' : 'Maximum boost rewards claimed. Thank you! 💜' })
        .setTimestamp()

      // Also send a DM so it's saved in their inbox
      try { await inter.user.send({ embeds: [embed] }).catch(() => {}) } catch (_) {}

      return inter.editReply({ embeds: [embed] })
    }

    if (n === 'download') {
      // Restrict to customers role
      const hasRole = CFG.customerRoleId && inter.member?.roles?.cache?.has(CFG.customerRoleId)
      const isManager = isKeyManagerUser(inter)
      if (!hasRole && !isManager) {
        return inter.reply({ content: 'You need the **Customer** role to use this command. Purchase a license at <https://zenithmacros.store> to get access.', ephemeral: true })
      }
      await inter.deferReply({ ephemeral: true })
      let dlData
      try {
        dlData = await botApiGet(`/api/bot/download-link?discord_id=${encodeURIComponent(inter.user.id)}`)
      } catch (err) {
        if (err?.status === 403 || (err?.message || '').includes('standalone_only')) {
          return inter.editReply('❌ Your key is for **standalone macros only** and does not include the full Zenith Macros client.\n\nHead to <https://zenithmacros.store/dashboard.html> → **Individual Macros** to download your standalone macros.\n\nTo access the full client, purchase a subscription at <https://zenithmacros.store>.')
        }
        return inter.editReply('Could not fetch download link right now. Try again in a moment or check <https://zenithmacros.store>.')
      }
      if (!dlData?.ok || !dlData?.url) {
        return inter.editReply('No release is available yet. Check back soon!')
      }
      const e = new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setTitle('Zenith Macros — Download')
        .setDescription(`**Version:** \`${dlData.version || 'latest'}\`\n\nYour secure download link is ready. It expires in 15 minutes.`)
        .addFields({ name: '⬇️ Download', value: `[${dlData.assetName || 'ZenithMacros.exe'}](${dlData.url})` })
        .setFooter({ text: 'Link is personal and expires — do not share it.' })
      return inter.editReply({ embeds: [e] })
    }
    if (n === 'user') {
      if (!isKeyManagerUser(inter)) return inter.reply({ content: 'Admin/manager permission required.', ephemeral: true })
      const sub = inter.options.getSubcommand(true)
      await inter.deferReply({ ephemeral: true })

      // Resolve discord_id from user mention or string option
      const resolveDiscordId = () => {
        const u = inter.options.getUser('user')
        if (u) return u.id
        const raw = String(inter.options.getString('discord_id') || '').trim().replace(/[^\d]/g, '')
        return raw || null
      }

      if (sub === 'lookup') {
        const discordId = resolveDiscordId()
        if (!discordId) return inter.editReply('Provide a Discord user or discord_id.')
        const result = await botApiGet(`/api/bot/discord/licenses?discord_id=${encodeURIComponent(discordId)}`)
        if (!result?.ok) return inter.editReply(result?.error || 'Failed to fetch licenses.')
        const licenses = Array.isArray(result.licenses) ? result.licenses : []

        // Resolve Discord member for avatar/username
        let discordUser = null
        try { discordUser = await inter.client.users.fetch(discordId) } catch (_) {}
        const displayName = discordUser ? `${discordUser.username}` : discordId

        if (!licenses.length) {
          const e = new EmbedBuilder()
            .setColor(0x4a4a6a)
            .setTitle(`Customer Profile — ${displayName}`)
            .setDescription(`<@${discordId}> has no licenses on record.`)
            .addFields(
              { name: '💳 Membership', value: 'None', inline: true },
              { name: '🏷️ Affiliate Code', value: 'Not set', inline: true },
              { name: '🛒 Purchases', value: '0', inline: true }
            )
          if (discordUser) e.setThumbnail(discordUser.displayAvatarURL({ size: 256 }))
          return inter.editReply({ embeds: [e] })
        }

        // Determine best active license
        const activeLicenses = licenses.filter(l => l.active && !keyExpired(l))
        const primaryLic = activeLicenses.find(l => l.access === 'lifetime')
          || activeLicenses.find(l => l.access === 'monthly')
          || licenses[0]

        // Membership status
        const isActive = primaryLic?.active && !keyExpired(primaryLic)
        const plan = primaryLic?.access || 'none'
        const expiresAt = primaryLic?.expires_at
        let membershipValue = ''
        let embedColor = 0x4a4a6a
        if (!isActive) {
          membershipValue = `❌ **Inactive / Expired**\nPlan: ${plan}`
          embedColor = 0xef4444
        } else if (plan === 'lifetime') {
          membershipValue = `✅ **Lifetime — Active**`
          embedColor = 0x8b5cf6
        } else if (plan === 'monthly') {
          embedColor = 0x22c55e
          if (expiresAt) {
            const msLeft = new Date(expiresAt).getTime() - Date.now()
            const daysLeft = Math.max(0, Math.floor(msLeft / 86400000))
            const hoursLeft = Math.max(0, Math.floor((msLeft % 86400000) / 3600000))
            const expStr = `<t:${Math.floor(new Date(expiresAt).getTime() / 1000)}:D>`
            if (daysLeft <= 3) embedColor = 0xf59e0b
            membershipValue = `✅ **Monthly — Active**\nExpires: ${expStr} (${daysLeft}d ${hoursLeft}h remaining)`
          } else {
            membershipValue = `✅ **Monthly — Active**\nNo expiry set`
          }
        }

        // Affiliate code (from any license)
        const affiliateCode = licenses.map(l => l.affiliate_code).find(c => c && String(c).trim()) || null

        // Key lines
        const keyLines = licenses.slice(0, 8).map(l => {
          const st = keyStatus(l)
          const stIcon = { available: '🟢', active: '🟢', used: '🔵', inactive: '⚫', expired: '🔴' }[st] || '⚫'
          const exp = l.expires_at ? String(l.expires_at).slice(0, 10) : 'never'
          const hwid = l.hwid ? '🔒 HWID bound' : '🔓 No HWID'
          return `${stIcon} \`${l.key}\` — **${l.access}** | exp: ${exp} | ${hwid}`
        })
        if (licenses.length > 8) keyLines.push(`…and ${licenses.length - 8} more`)

        // Build embed
        const e = new EmbedBuilder()
          .setColor(embedColor)
          .setTitle(`Customer Profile — ${displayName}`)
          .setDescription(`<@${discordId}> \`${discordId}\``)
          .addFields(
            { name: '💳 Membership', value: membershipValue || 'None', inline: false },
            { name: '🏷️ Affiliate Code', value: affiliateCode ? `\`${affiliateCode}\`` : 'Not set', inline: true },
            { name: '🛒 Total Licenses', value: String(licenses.length), inline: true },
            { name: '✅ Active Licenses', value: String(activeLicenses.length), inline: true },
          )

        if (keyLines.length) {
          e.addFields({ name: '🔑 Keys', value: keyLines.join('\n').slice(0, 1024), inline: false })
        }

        // Primary key details
        if (primaryLic) {
          const note = String(primaryLic.note || '').trim()
          const email = String(primaryLic.email || '').trim()
          const created = primaryLic.created_at ? `<t:${Math.floor(new Date(primaryLic.created_at).getTime() / 1000)}:D>` : '-'
          const activated = primaryLic.activated_at ? `<t:${Math.floor(new Date(primaryLic.activated_at).getTime() / 1000)}:D>` : 'Never'
          e.addFields(
            { name: '📋 Primary Key Detail', value: `\`${primaryLic.key}\``, inline: false },
            { name: 'Created', value: created, inline: true },
            { name: 'First Activated', value: activated, inline: true },
            { name: 'HWID', value: primaryLic.hwid ? `\`${String(primaryLic.hwid).slice(0, 10)}...\`` : 'Not bound', inline: true },
            { name: 'Email', value: email || 'Not set', inline: true },
            { name: 'Note', value: note || 'None', inline: true },
          )
        }

        if (discordUser) e.setThumbnail(discordUser.displayAvatarURL({ size: 256 }))
        e.setTimestamp(new Date())
        return inter.editReply({ embeds: [e] })
      }

      if (sub === 'grant') {
        const targetUser = inter.options.getUser('user', true)
        const plan = inter.options.getString('plan', true)
        const days = inter.options.getInteger('days') || 30
        const email = inter.options.getString('email') || ''
        const note = inter.options.getString('note') || ''
        const r = await botApiPost('/api/bot/discord/grant', {
          discord_id: targetUser.id,
          plan,
          days: plan === 'monthly' ? days : undefined,
          email: email || undefined,
          notes: note || undefined
        })
        if (!r?.ok) return inter.editReply(r?.error || 'Failed to grant license.')
        // Assign customer role automatically
        if (CFG.customerRoleId && inter.guild) {
          try {
            const member = await inter.guild.members.fetch(targetUser.id)
            await member.roles.add(CFG.customerRoleId)
          } catch (_) {}
        }
        // DM the user with setup instructions
        try {
          const planLabel = plan === 'lifetime' ? 'Lifetime' : plan === '3month' ? '3-Month' : 'Monthly'
          const grantDmEmbed = new EmbedBuilder()
            .setColor(0x8b5cf6)
            .setTitle('🎉 You\'ve Received a Zenith Macros License!')
            .setDescription([
              `You've been granted a **${planLabel}** Zenith Macros license. Here's how to get started:`,
              '',
              '**Step 1** — Go to **https://zenithmacros.store/**',
              '**Step 2** — Click **Log In** and sign in with this Discord account',
              '**Step 3** — Head to your **Dashboard** — your license key will be right there',
              '**Step 4** — On the left sidebar, click **Downloads** to grab the latest version',
              '',
              '📺 **Need a visual walkthrough? Watch these tutorials:**',
              '> https://www.youtube.com/watch?v=dS28782lZn4',
              '> https://www.youtube.com/watch?v=FRY-vCEq9iU&t=48s',
              '',
              '**Questions?** Open a support ticket in our Discord server — we\'re happy to help.',
              '',
              '⭐ Once you\'re set up, please use `/rating` in the server to rate the client — it means a lot to us!'
            ].join('\n'))
            .setFooter({ text: 'Zenith Macros • Welcome aboard!' })
            .setTimestamp()
          await targetUser.send({ embeds: [grantDmEmbed] }).catch(() => {})
        } catch (_) {}
        const e = new EmbedBuilder()
          .setColor(0x22c55e)
          .setTitle('License Granted')
          .addFields(
            { name: 'User', value: `<@${targetUser.id}>`, inline: true },
            { name: 'Key', value: `\`${r.key}\``, inline: true },
            { name: 'Plan', value: plan, inline: true }
          )
        if (plan === 'monthly') e.addFields({ name: 'Days', value: String(days), inline: true })
        return inter.editReply({ content: `License granted to ${targetUser}.`, embeds: [e] })
      }

      if (sub === 'revoke') {
        const discordId = resolveDiscordId()
        if (!discordId) return inter.editReply('Provide a Discord user or discord_id.')
        const key = inter.options.getString('key') || ''
        const r = await botApiPost('/api/bot/discord/revoke', { discord_id: discordId, key: key || undefined })
        if (!r?.ok) return inter.editReply(r?.error || 'Failed to revoke.')
        // Remove customer role automatically
        if (CFG.customerRoleId && inter.guild) {
          try {
            const member = await inter.guild.members.fetch(discordId)
            await member.roles.remove(CFG.customerRoleId)
          } catch (_) {}
        }
        return inter.editReply(`Revoked ${r.revoked} license(s) for <@${discordId}>.`)
      }

      if (sub === 'hwid_reset') {
        const discordId = resolveDiscordId()
        if (!discordId) return inter.editReply('Provide a Discord user or discord_id.')
        const key = inter.options.getString('key') || ''
        const r = await botApiPost('/api/bot/discord/reset-hwid', { discord_id: discordId, key: key || undefined })
        if (!r?.ok) return inter.editReply(r?.error || 'Failed to reset HWID.')
        return inter.editReply(`Reset HWID for ${r.reset} license(s) for <@${discordId}>.`)
      }

      if (sub === 'upgrade') {
        const discordId = resolveDiscordId()
        if (!discordId) return inter.editReply('Provide a Discord user or discord_id.')
        const key = inter.options.getString('key') || ''
        const r = await botApiPost('/api/bot/discord/upgrade', { discord_id: discordId, key: key || undefined })
        if (!r?.ok) return inter.editReply(r?.error || 'Failed to upgrade.')
        if (!r.upgraded) return inter.editReply(`No eligible licenses found to upgrade for <@${discordId}>.`)
        const keys = Array.isArray(r.licenses) ? r.licenses.map(l => `\`${l.key}\``).join(', ') : ''
        return inter.editReply(`Upgraded ${r.upgraded} license(s) to **lifetime** for <@${discordId}>.\n${keys}`)
      }

      if (sub === 'extend') {
        const discordId = resolveDiscordId()
        if (!discordId) return inter.editReply('Provide a Discord user or discord_id.')
        const days = clamp(inter.options.getInteger('days', true), 1, 3650)
        const key = inter.options.getString('key') || ''
        // Resolve key to extend — use provided key or find primary active key for this user
        let targetKey = key
        if (!targetKey) {
          const result = await botApiGet(`/api/bot/discord/licenses?discord_id=${encodeURIComponent(discordId)}`)
          if (!result?.ok) return inter.editReply(result?.error || 'Failed to fetch licenses.')
          const licenses = Array.isArray(result.licenses) ? result.licenses : []
          const active = licenses.filter(l => l.active && !keyExpired(l)).find(l => l.access === 'monthly')
            || licenses.find(l => l.active && !keyExpired(l))
          if (!active) return inter.editReply(`No active license found for <@${discordId}>.`)
          targetKey = active.key
        }
        const r = await botApiPost('/api/bot/key-extend', { key: targetKey, days })
        if (!r?.ok) return inter.editReply(r?.error || 'Failed to extend license.')
        const lookup = await lookupKeyByInput(targetKey)
        const e = new EmbedBuilder()
          .setColor(0x22c55e)
          .setTitle('License Extended')
          .addFields(
            { name: 'User', value: `<@${discordId}>`, inline: true },
            { name: 'Days Added', value: `+${days}`, inline: true },
            { name: 'Key', value: `\`${normKey(targetKey)}\``, inline: false },
            { name: 'New Expiry', value: lookup.found?.expires_at ? `<t:${Math.floor(new Date(lookup.found.expires_at).getTime() / 1000)}:D>` : r.expiresAt || 'N/A', inline: true }
          )
        return inter.editReply({ embeds: [e] })
      }

      if (sub === 'toggle') {
        const discordId = resolveDiscordId()
        if (!discordId) return inter.editReply('Provide a Discord user or discord_id.')
        const active = inter.options.getBoolean('active', true)
        const key = inter.options.getString('key') || ''
        // Toggle via key-update — target specific key or all user keys
        if (key) {
          const r = await botApiPost('/api/bot/key-update', { key, active })
          if (!r?.ok) return inter.editReply(r?.error || 'Failed to update license.')
          return inter.editReply(`License \`${normKey(key)}\` is now **${active ? 'active' : 'inactive'}** for <@${discordId}>.`)
        }
        // No specific key — toggle all licenses for this user
        const result = await botApiGet(`/api/bot/discord/licenses?discord_id=${encodeURIComponent(discordId)}`)
        if (!result?.ok) return inter.editReply(result?.error || 'Failed to fetch licenses.')
        const licenses = Array.isArray(result.licenses) ? result.licenses : []
        if (!licenses.length) return inter.editReply(`No licenses found for <@${discordId}>.`)
        let toggled = 0
        for (const lic of licenses) {
          const r = await botApiPost('/api/bot/key-update', { key: lic.key, active })
          if (r?.ok) toggled++
        }
        return inter.editReply(`Set ${toggled} license(s) to **${active ? 'active' : 'inactive'}** for <@${discordId}>.`)
      }

      if (sub === 'note') {
        const discordId = resolveDiscordId()
        if (!discordId) return inter.editReply('Provide a Discord user or discord_id.')
        const noteRaw = inter.options.getString('note')
        const key = inter.options.getString('key') || ''
        // Resolve which key to update/view
        let targetKey = key
        if (!targetKey) {
          const result = await botApiGet(`/api/bot/discord/licenses?discord_id=${encodeURIComponent(discordId)}`)
          if (!result?.ok) return inter.editReply(result?.error || 'Failed to fetch licenses.')
          const licenses = Array.isArray(result.licenses) ? result.licenses : []
          const active = licenses.find(l => l.active && !keyExpired(l)) || licenses[0]
          if (!active) return inter.editReply(`No license found for <@${discordId}>.`)
          targetKey = active.key
        }
        if (noteRaw == null) {
          // View mode
          const lookup = await lookupKeyByInput(targetKey)
          if (!lookup.found) return inter.editReply('Key not found.')
          const note = String(lookup.found.note || '').trim()
          const e = new EmbedBuilder()
            .setColor(0x8b5cf6)
            .setTitle('License Note')
            .addFields(
              { name: 'User', value: `<@${discordId}>`, inline: true },
              { name: 'Key', value: `\`${normKey(targetKey)}\``, inline: true },
              { name: 'Note', value: note || '*No note set*', inline: false }
            )
          return inter.editReply({ embeds: [e] })
        }
        // Update mode
        const txt = String(noteRaw)
        const note = ['clear', 'none', 'null', '-'].includes(txt.trim().toLowerCase()) ? '' : txt
        const r = await botApiPost('/api/bot/key-update', { key: targetKey, note })
        if (!r?.ok) return inter.editReply(r?.error || 'Failed to update note.')
        return inter.editReply(`Note ${note ? `set to: *${note}*` : 'cleared'} for \`${normKey(targetKey)}\` (<@${discordId}>).`)
      }

      return inter.editReply('Unknown user subcommand.')
    }
    if (n === 'macro') {
      if (!isKeyManagerUser(inter)) return inter.reply({ content: 'Admin/manager permission required.', ephemeral: true })
      const sub = inter.options.getSubcommand(true)
      await inter.deferReply({ ephemeral: true })

      if (sub === 'grant') {
        const targetUser = inter.options.getUser('user', true)
        const rawInput   = inter.options.getString('product_id', true).trim()
        const note       = inter.options.getString('note') || ''

        // Fuzzy-resolve product name → product_id by fetching the product list
        let productId = rawInput.toLowerCase().replace(/\s+/g, '-')
        try {
          const prodList = await botApiGet('/api/products')
          if (prodList?.items?.length) {
            const q = rawInput.toLowerCase()
            const match = prodList.items.find(p =>
              p.id === q ||
              p.id === 'zenith-' + q.replace(/\s+/g, '-') ||
              p.name.toLowerCase() === q ||
              p.name.toLowerCase().replace(/\s+/g, '-') === q.replace(/\s+/g, '-') ||
              p.name.toLowerCase().includes(q) ||
              p.id.includes(q.replace(/\s+/g, '-'))
            )
            if (match) productId = match.id
          }
        } catch (_) {}

        const r = await botApiPost('/api/bot/entitlement/grant', {
          discord_id: targetUser.id,
          product_id: productId,
          note: note || undefined,
        })
        if (!r?.ok) return inter.editReply(`❌ ${r?.error || 'Failed to grant entitlement.'}`)
        const e = new EmbedBuilder()
          .setColor(0x22c55e)
          .setTitle('Macro Entitlement Granted')
          .addFields(
            { name: 'User', value: `<@${targetUser.id}>`, inline: true },
            { name: 'Macro', value: r.product_name || productId, inline: true },
            { name: 'Key', value: `\`${r.license_key}\``, inline: false },
          )
        if (r.new_license) e.addFields({ name: 'Note', value: 'New standalone-only license created (user had no existing key)', inline: false })
        if (r.bundle_items_granted?.length) e.addFields({ name: 'Bundle Items Also Granted', value: r.bundle_items_granted.join(', '), inline: false })
        return inter.editReply({ content: `Macro granted to ${targetUser}.`, embeds: [e] })
      }

      return inter.editReply('Unknown macro subcommand.')
    }
    if (n === 'affiliate') {
      if (!isKeyManagerUser(inter)) return inter.reply({ content: 'Admin/manager permission required.', ephemeral: true })
      const sub = inter.options.getSubcommand(true)
      await inter.deferReply({ ephemeral: true })

      const resolveDiscordId = () => {
        const u = inter.options.getUser('user')
        if (u) return u.id
        const raw = String(inter.options.getString('discord_id') || '').trim().replace(/[^\d]/g, '')
        return raw || null
      }

      if (sub === 'info') {
        const discordId = resolveDiscordId()
        if (!discordId) return inter.editReply('Provide a Discord user or discord_id.')
        const result = await botApiGet(`/api/bot/discord/licenses?discord_id=${encodeURIComponent(discordId)}`)
        if (!result?.ok) return inter.editReply(result?.error || 'Failed to fetch licenses.')
        const licenses = Array.isArray(result.licenses) ? result.licenses : []
        if (!licenses.length) return inter.editReply(`No licenses found for <@${discordId}>.`)
        const active = licenses.find(l => l.active && !keyExpired(l)) || licenses[0]
        const code = active?.affiliate_code || ''
        const e = new EmbedBuilder()
          .setColor(0x8b5cf6)
          .setTitle('Affiliate Info')
          .addFields(
            { name: 'User', value: `<@${discordId}>`, inline: true },
            { name: 'Plan', value: active?.access || '-', inline: true },
            { name: 'Affiliate Code', value: code ? `\`${code}\`` : 'Not set', inline: true },
            { name: 'License Key', value: active ? `\`${active.key}\`` : 'None', inline: true }
          )
        if (code) {
          e.addFields({ name: 'Referral Link', value: `https://zenithmacros.store/?ref=${code}`, inline: false })
        }
        return inter.editReply({ embeds: [e] })
      }

      if (sub === 'set') {
        const discordId = resolveDiscordId()
        if (!discordId) return inter.editReply('Provide a Discord user or discord_id.')
        const code = String(inter.options.getString('code', true) || '').trim().toLowerCase()
        if (!code) return inter.editReply('Code cannot be empty.')
        const r = await botApiPost('/api/bot/discord/set-affiliate', { discord_id: discordId, affiliate_code: code })
        if (!r?.ok) return inter.editReply(r?.error || 'Failed to set affiliate code.')
        if (!r.updated) return inter.editReply(`No active license found for <@${discordId}> to set affiliate code on.`)
        return inter.editReply(`Set affiliate code \`${code}\` for <@${discordId}> on ${r.updated} license(s).`)
      }

      if (sub === 'clear') {
        const discordId = resolveDiscordId()
        if (!discordId) return inter.editReply('Provide a Discord user or discord_id.')
        const r = await botApiPost('/api/bot/discord/set-affiliate', { discord_id: discordId, affiliate_code: '' })
        if (!r?.ok) return inter.editReply(r?.error || 'Failed to clear affiliate code.')
        return inter.editReply(`Cleared affiliate code for <@${discordId}>.`)
      }

      return inter.editReply('Unknown affiliate subcommand.')
    }
    if (n === 'giveaway') {
      const canManage = isAdmin(inter.member) || hasSupport(inter.member) || isKeyManagerUser(inter)
      if (!canManage) return inter.reply({ content: 'Admin or support permission required.', ephemeral: true })
      const sub = inter.options.getSubcommand(true)
      if (sub === 'create') {
        const targetChannel = inter.options.getChannel('channel') || inter.channel
        if (!targetChannel || targetChannel.type !== ChannelType.GuildText) return inter.reply({ content: 'Giveaway channel must be a text channel.', ephemeral: true })
        const durationInput = inter.options.getString('duration', true)
        const durationMs = parseDurationMs(durationInput)
        if (durationMs < 15000 || durationMs > 1000 * 60 * 60 * 24 * 30) return inter.reply({ content: 'Duration must be between 15 seconds and 30 days.', ephemeral: true })
        const winnerCount = clamp(inter.options.getInteger('winners', true), 1, 20)
        const minInvites = clamp(inter.options.getInteger('min_invites') || 0, 0, 5000)
        const rewardEnabled = !!inter.options.getBoolean('reward_key')
        if (rewardEnabled && !isKeyManagerUser(inter)) return inter.reply({ content: 'Only key managers can set key rewards.', ephemeral: true })
        const rewardAccess = inter.options.getString('reward_access') === 'lifetime' ? 'lifetime' : 'monthly'
        const rewardDays = clamp(inter.options.getInteger('reward_days') || 30, 1, 3650)
        const now = Date.now()
        const id = `gw-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
        const giveaway = {
          id, guildId: inter.guildId, channelId: targetChannel.id, messageId: '', hostId: inter.user.id, hostTag: inter.user.tag,
          title: fmt(inter.options.getString('title', true)),
          description: fmt(inter.options.getString('description') || 'Click **Join Giveaway** below to enter.'),
          prize: fmt(inter.options.getString('prize', true)),
          winnerCount, minInvites, participants: [], winners: [],
          createdAt: now, endsAt: now + durationMs, ended: false,
          reward: { enabled: rewardEnabled, access: rewardAccess, days: rewardDays, note: fmt(inter.options.getString('reward_note') || `discord-giveaway:${id}`) }
        }
        const sent = await targetChannel.send({ embeds: [giveawayEmbed(giveaway)], components: giveawayButtons(giveaway, false) })
        giveaway.messageId = sent.id
        state.giveaways[id] = giveaway
        saveState()
        return inter.reply({ content: `Giveaway created in ${targetChannel}.\nID: \`${id}\`\nEnds in ${prettyDuration(durationMs)}.`, ephemeral: true })
      }
      if (sub === 'end') {
        await inter.deferReply({ ephemeral: true })
        const id = inter.options.getString('id', true).trim()
        if (!state.giveaways[id]) return inter.editReply('Giveaway ID not found.')
        const ended = await endGiveaway(id, inter.user.id)
        if (!ended) return inter.editReply('Could not end giveaway.')
        return inter.editReply(`Giveaway \`${id}\` ended.`)
      }
      if (sub === 'reroll') {
        await inter.deferReply({ ephemeral: true })
        const id = inter.options.getString('id', true).trim()
        if (!state.giveaways[id]) return inter.editReply('Giveaway ID not found.')
        const updated = await rerollGiveaway(id, inter.user.id)
        if (!updated.winners?.length) return inter.editReply(`Rerolled \`${id}\`, but no eligible replacements found.`)
        return inter.editReply(`Rerolled \`${id}\`. New winner(s): ${updated.winners.map(w => `<@${w}>`).join(', ')}`)
      }
      if (sub === 'list') {
        const all = Object.values(state.giveaways || {}).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)).slice(0, 15)
        if (!all.length) return inter.reply({ content: 'No giveaways found.', ephemeral: true })
        const lines = all.map(g => {
          const status = g.ended ? 'ended' : 'live'
          const entries = Array.isArray(g.participants) ? g.participants.length : 0
          const endTs = Math.floor(Number(g.endsAt || Date.now()) / 1000)
          return `\`${g.id}\` — **${g.title || 'Giveaway'}** | ${status} | ${entries} entries | ends <t:${endTs}:R>`
        })
        return inter.reply({ content: lines.join('\n').slice(0, 1900), ephemeral: true })
      }
    }
    if (n === 'mod') {
      if (!isAdmin(inter.member) && !isKeyManagerUser(inter)) return inter.reply({ content: 'Admin permission required.', ephemeral: true })
      const sub = inter.options.getSubcommand(true)
      await inter.deferReply({ ephemeral: true })

      // Moderation audit log helper
      const logMod = async (action, targetTag, targetId, reason, extra = '') => {
        const logChId = modLogChannelId || state.channels?.modlog || ''
        if (!logChId) return
        try {
          const ch = await inter.guild.channels.fetch(logChId).catch(() => null)
          if (!ch) return
          const e = new EmbedBuilder()
            .setColor(action === 'unban' || action === 'untimeout' ? 0x22c55e : action === 'warn' ? 0xf59e0b : 0xef4444)
            .setTitle(`Mod Action: ${action.toUpperCase()}`)
            .addFields(
              { name: 'Moderator', value: `<@${inter.user.id}> (${inter.user.tag})`, inline: true },
              { name: 'Target', value: `${targetTag} (${targetId})`, inline: true },
              { name: 'Reason', value: String(reason || 'No reason').slice(0, 1024) }
            )
            .setTimestamp(new Date())
          if (extra) e.addFields({ name: 'Details', value: extra })
          await ch.send({ embeds: [e] }).catch(() => {})
        } catch (_) {}
      }

      if (sub === 'timeout') {
        const target = inter.options.getMember('user')
        if (!target) return inter.editReply('User not found in this server.')
        const durationMs = parseDurationMs(inter.options.getString('duration', true))
        if (durationMs < 5000 || durationMs > 2419200000) return inter.editReply('Duration must be between 5 seconds and 28 days.')
        const reason = inter.options.getString('reason') || 'No reason provided'
        if (!target.moderatable) return inter.editReply('Cannot timeout that member (higher role or bot).')
        await target.timeout(durationMs, reason)
        await target.send(`You have been timed out in **${inter.guild.name}** for ${prettyDuration(durationMs)}.\nReason: ${reason}`).catch(() => {})
        await logMod('timeout', target.user.tag, target.user.id, reason, `Duration: ${prettyDuration(durationMs)}`)
        return inter.editReply(`Timed out ${target.user.tag} for ${prettyDuration(durationMs)}.`)
      }
      if (sub === 'untimeout') {
        const target = inter.options.getMember('user')
        if (!target) return inter.editReply('User not found.')
        const reason = inter.options.getString('reason') || 'No reason provided'
        await target.timeout(null, reason)
        await logMod('untimeout', target.user.tag, target.user.id, reason)
        return inter.editReply(`Removed timeout from ${target.user.tag}.`)
      }
      if (sub === 'kick') {
        const target = inter.options.getMember('user')
        if (!target) return inter.editReply('User not found.')
        if (!target.kickable) return inter.editReply('Cannot kick that member.')
        const reason = inter.options.getString('reason') || 'No reason provided'
        await target.send(`You have been kicked from **${inter.guild.name}**.\nReason: ${reason}`).catch(() => {})
        await logMod('kick', target.user.tag, target.user.id, reason)
        await target.kick(reason)
        return inter.editReply(`Kicked ${target.user.tag}.`)
      }
      if (sub === 'ban') {
        const target = inter.options.getUser('user', true)
        const deleteDays = clamp(inter.options.getInteger('delete_days') || 0, 0, 7)
        const reason = inter.options.getString('reason') || 'No reason provided'
        const member = inter.guild.members.cache.get(target.id)
        if (member && !member.bannable) return inter.editReply('Cannot ban that member.')
        await target.send(`You have been banned from **${inter.guild.name}**.\nReason: ${reason}`).catch(() => {})
        await logMod('ban', target.tag, target.id, reason, deleteDays ? `Delete messages: ${deleteDays} day(s)` : '')
        await inter.guild.bans.create(target.id, { deleteMessageDays: deleteDays, reason })
        return inter.editReply(`Banned ${target.tag}.`)
      }
      if (sub === 'unban') {
        const userId = String(inter.options.getString('user_id', true) || '').trim().replace(/[^\d]/g, '')
        if (!userId) return inter.editReply('Invalid user ID.')
        const reason = inter.options.getString('reason') || 'No reason provided'
        await inter.guild.bans.remove(userId, reason).catch(e => { throw new Error(`Could not unban: ${e.message}`) })
        await logMod('unban', userId, userId, reason)
        return inter.editReply(`Unbanned user \`${userId}\`.`)
      }
      if (sub === 'warn') {
        const target = inter.options.getUser('user', true)
        const reason = inter.options.getString('reason', true)
        const sent = await target.send(`⚠️ You have received a warning in **${inter.guild.name}**.\nReason: ${reason}`).catch(() => null)
        await logMod('warn', target.tag, target.id, reason, sent ? 'DM sent' : 'DM failed (closed)')
        if (!sent) return inter.editReply(`Warning issued to ${target.tag} but could not DM them (DMs may be closed).`)
        return inter.editReply(`Warning sent to ${target.tag}.`)
      }
      if (sub === 'nick') {
        const target = inter.options.getMember('user')
        if (!target) return inter.editReply('User not found.')
        const nick = inter.options.getString('nickname') || null
        await target.setNickname(nick)
        await logMod('nick', target.user.tag, target.user.id, nick ? `Set to: ${nick}` : 'Cleared')
        return inter.editReply(nick ? `Nickname set to **${nick}** for ${target.user.tag}.` : `Cleared nickname for ${target.user.tag}.`)
      }
      if (sub === 'role') {
        const action = inter.options.getString('action', true)
        const target = inter.options.getMember('user')
        const role = inter.options.getRole('role', true)
        if (!target) return inter.editReply('User not found.')
        if (action === 'add') {
          await target.roles.add(role.id)
          await logMod('role_add', target.user.tag, target.user.id, `Added role: ${role.name}`)
          return inter.editReply(`Added role **${role.name}** to ${target.user.tag}.`)
        }
        await target.roles.remove(role.id)
        await logMod('role_remove', target.user.tag, target.user.id, `Removed role: ${role.name}`)
        return inter.editReply(`Removed role **${role.name}** from ${target.user.tag}.`)
      }
    }
    if (n === 'say') {
      if (!isAdmin(inter.member) && !isKeyManagerUser(inter)) return inter.reply({ content: 'Admin permission required.', ephemeral: true })
      const sub = inter.options.getSubcommand(true)
      const ch = inter.options.getChannel('channel', true)
      if (ch.type !== ChannelType.GuildText) return inter.reply({ content: 'Select a text channel.', ephemeral: true })
      if (sub === 'message') {
        const modal = new ModalBuilder()
          .setCustomId(`saymodal:${ch.id}`)
          .setTitle('Send Message')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('message').setLabel('Message (\\n for new lines)').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)
            )
          )
        return inter.showModal(modal)
      }
      if (sub === 'embed') {
        const modal = new ModalBuilder()
          .setCustomId(`embedmodal:${ch.id}`)
          .setTitle('Send Embed')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(256)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('description').setLabel('Body (\\n for new lines)').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('color').setLabel('Hex color (optional, e.g. #8b5cf6)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(7)
            )
          )
        return inter.showModal(modal)
      }
    }
    if (n === 'purge') {
      if (!isAdmin(inter.member) && !isKeyManagerUser(inter)) return inter.reply({ content: 'Admin permission required.', ephemeral: true })
      await inter.deferReply({ ephemeral: true })
      const amount = clamp(inter.options.getInteger('amount', true), 1, 100)
      const targetUser = inter.options.getUser('user')
      let messages = await inter.channel.messages.fetch({ limit: targetUser ? 100 : amount })
      if (targetUser) messages = messages.filter(m => m.author.id === targetUser.id).first(amount)
      const deleted = await inter.channel.bulkDelete(messages, true).catch(e => { throw new Error(e.message) })
      return inter.editReply(`Deleted ${deleted.size} message(s)${targetUser ? ` from ${targetUser.tag}` : ''}.`)
    }
    if (n === 'slowmode') {
      if (!isAdmin(inter.member) && !isKeyManagerUser(inter)) return inter.reply({ content: 'Admin permission required.', ephemeral: true })
      const seconds = clamp(inter.options.getInteger('seconds', true), 0, 21600)
      const ch = inter.options.getChannel('channel') || inter.channel
      if (ch.type !== ChannelType.GuildText) return inter.reply({ content: 'Select a text channel.', ephemeral: true })
      await ch.setRateLimitPerUser(seconds)
      return inter.reply({ content: seconds === 0 ? `Slowmode disabled in ${ch}.` : `Slowmode set to ${seconds}s in ${ch}.`, ephemeral: true })
    }
    if (n === 'lockdown') {
      if (!isAdmin(inter.member) && !isKeyManagerUser(inter)) return inter.reply({ content: 'Admin permission required.', ephemeral: true })
      const action = inter.options.getString('action', true)
      const ch = inter.options.getChannel('channel') || inter.channel
      if (ch.type !== ChannelType.GuildText) return inter.reply({ content: 'Select a text channel.', ephemeral: true })
      const reason = inter.options.getString('reason') || undefined
      await ch.permissionOverwrites.edit(inter.guild.roles.everyone.id, { SendMessages: action === 'lock' ? false : null }, { reason })
      return inter.reply({ content: action === 'lock' ? `🔒 ${ch} has been locked.` : `🔓 ${ch} has been unlocked.`, ephemeral: false })
    }
    if (n === 'serverinfo') {
      const g = inter.guild
      await g.fetch()
      const e = new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setTitle(g.name)
        .setThumbnail(g.iconURL())
        .addFields(
          { name: 'Owner', value: `<@${g.ownerId}>`, inline: true },
          { name: 'Members', value: String(g.memberCount), inline: true },
          { name: 'Channels', value: String(g.channels.cache.size), inline: true },
          { name: 'Roles', value: String(g.roles.cache.size), inline: true },
          { name: 'Boosts', value: String(g.premiumSubscriptionCount || 0), inline: true },
          { name: 'Boost Level', value: String(g.premiumTier), inline: true },
          { name: 'Created', value: `<t:${Math.floor(g.createdTimestamp / 1000)}:D>`, inline: true },
          { name: 'ID', value: g.id, inline: true }
        )
        .setTimestamp()
      return inter.reply({ embeds: [e], ephemeral: true })
    }
    if (n === 'userinfo') {
      const target = inter.options.getUser('user') || inter.user
      const member = inter.guild?.members.cache.get(target.id)
      const roles = member?.roles.cache.filter(r => r.id !== inter.guild?.roles.everyone.id).map(r => `<@&${r.id}>`).join(', ') || 'None'
      const userEmbed = new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setTitle(target.username)
        .setThumbnail(target.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: 'ID', value: target.id, inline: true },
          { name: 'Bot', value: target.bot ? 'Yes' : 'No', inline: true },
          { name: 'Account Created', value: `<t:${Math.floor(target.createdTimestamp / 1000)}:D>`, inline: true },
          { name: 'Joined Server', value: member ? `<t:${Math.floor((member.joinedTimestamp || 0) / 1000)}:D>` : 'N/A', inline: true },
          { name: 'Nickname', value: member?.nickname || 'None', inline: true },
          { name: 'Roles', value: roles.slice(0, 1024) || 'None', inline: false }
        )
      const embeds = [userEmbed]
      const components = []

      if (isKeyManagerUser(inter)) {
        try {
          const result = await botApiGet(`/api/bot/discord/licenses?discord_id=${encodeURIComponent(target.id)}`)
          const licenses = Array.isArray(result?.licenses) ? result.licenses : []
          const activeLicenses = licenses.filter(l => l.active && !keyExpired(l))
          const affiliateCode = licenses.map(l => l.affiliate_code).find(c => c && String(c).trim()) || null
          const did = target.id

          // Summary embed
          const primaryLic = activeLicenses.find(l => l.access === 'lifetime')
            || activeLicenses.find(l => l.access === 'monthly')
            || licenses[0] || null
          let summaryColor = 0x4a4a6a
          let summaryStatus = 'No license on file'
          if (primaryLic) {
            const isActive = primaryLic.active && !keyExpired(primaryLic)
            if (!isActive) { summaryColor = 0xef4444; summaryStatus = `❌ Expired/Inactive` }
            else if (primaryLic.access === 'lifetime') { summaryColor = 0x8b5cf6; summaryStatus = '✅ Lifetime — Active' }
            else {
              const daysLeft = primaryLic.expires_at ? Math.max(0, Math.floor((new Date(primaryLic.expires_at).getTime() - Date.now()) / 86400000)) : null
              summaryColor = daysLeft !== null && daysLeft <= 3 ? 0xf59e0b : 0x22c55e
              summaryStatus = daysLeft !== null
                ? `✅ Monthly — Active\nExpires: <t:${Math.floor(new Date(primaryLic.expires_at).getTime() / 1000)}:D> (${daysLeft}d left)`
                : '✅ Monthly — Active'
            }
          }
          const summaryEmbed = new EmbedBuilder()
            .setColor(summaryColor)
            .setTitle('License Summary')
            .addFields(
              { name: '💳 Status', value: summaryStatus, inline: false },
              { name: '🛒 Total Keys', value: String(licenses.length), inline: true },
              { name: '✅ Active', value: String(activeLicenses.length), inline: true },
              { name: '🏷️ Affiliate', value: affiliateCode ? `\`${affiliateCode}\`` : 'Not set', inline: true },
            )
          embeds.push(summaryEmbed)

          // One embed per license (up to 8 to stay within Discord limits)
          for (const lic of licenses.slice(0, 8)) {
            const isActive = lic.active && !keyExpired(lic)
            const plan = lic.access || 'monthly'
            let color = isActive ? (plan === 'lifetime' ? 0x8b5cf6 : 0x22c55e) : 0xef4444
            const statusIcon = isActive ? '✅' : '❌'
            const expValue = lic.expires_at
              ? `<t:${Math.floor(new Date(lic.expires_at).getTime() / 1000)}:D>`
              : 'Never'
            const hwidValue = lic.hwid ? `\`${String(lic.hwid).slice(0, 12)}...\`` : 'Not bound'
            const noteValue = lic.notes ? String(lic.notes).slice(0, 80) : 'None'
            embeds.push(
              new EmbedBuilder()
                .setColor(color)
                .setTitle(`${statusIcon} Key #${licenses.indexOf(lic) + 1} — ${plan.charAt(0).toUpperCase() + plan.slice(1)}`)
                .addFields(
                  { name: '🔑 Key', value: `\`${lic.key}\``, inline: false },
                  { name: 'Status', value: isActive ? 'Active' : 'Inactive/Expired', inline: true },
                  { name: 'Expires', value: expValue, inline: true },
                  { name: 'HWID Changes', value: String(lic.hwid_change_count ?? 0), inline: true },
                  { name: 'HWID', value: hwidValue, inline: true },
                  { name: 'Note', value: noteValue, inline: true },
                )
            )
          }
          if (licenses.length > 8) {
            embeds[embeds.length - 1].setFooter({ text: `…and ${licenses.length - 8} more key(s) not shown` })
          }

          // Action buttons — encode discord_id so handlers know who we're acting on
          const primaryKey = primaryLic?.key || ''
          components.push(
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`ui:reset_hwid:${did}`).setLabel('Reset HWID').setStyle(ButtonStyle.Secondary).setEmoji('🔄'),
              new ButtonBuilder().setCustomId(`ui:extend:${did}`).setLabel('Extend').setStyle(ButtonStyle.Primary).setEmoji('📅'),
              new ButtonBuilder().setCustomId(`ui:revoke:${did}`).setLabel('Revoke').setStyle(ButtonStyle.Danger).setEmoji('🚫'),
              new ButtonBuilder().setCustomId(`ui:new_key:${did}`).setLabel('New Key').setStyle(ButtonStyle.Success).setEmoji('➕'),
              new ButtonBuilder().setCustomId(`ui:unblock:${did}`).setLabel('Unblock IP').setStyle(ButtonStyle.Secondary).setEmoji('🔓'),
            )
          )
        } catch (_) {}
      }
      return inter.reply({ embeds, components, ephemeral: true })
    }
    if (n === 'avatar') {
      const target = inter.options.getUser('user') || inter.user
      const e = new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setTitle(`${target.tag}'s Avatar`)
        .setImage(target.displayAvatarURL({ size: 1024 }))
      return inter.reply({ embeds: [e] })
    }
    if (n === 'roleinfo') {
      const role = inter.options.getRole('role', true)
      const e = new EmbedBuilder()
        .setColor(role.color || 0x8b5cf6)
        .setTitle(`Role: ${role.name}`)
        .addFields(
          { name: 'ID', value: role.id, inline: true },
          { name: 'Color', value: role.hexColor, inline: true },
          { name: 'Mentionable', value: role.mentionable ? 'Yes' : 'No', inline: true },
          { name: 'Hoisted', value: role.hoist ? 'Yes' : 'No', inline: true },
          { name: 'Members', value: String(role.members.size), inline: true },
          { name: 'Position', value: String(role.position), inline: true },
          { name: 'Created', value: `<t:${Math.floor(role.createdTimestamp / 1000)}:D>`, inline: true }
        )
      return inter.reply({ embeds: [e], ephemeral: true })
    }
    if (n === 'poll') {
      if (!isAdmin(inter.member) && !hasSupport(inter.member) && !isKeyManagerUser(inter)) return inter.reply({ content: 'Admin or support permission required.', ephemeral: true })
      const question = inter.options.getString('question', true)
      const opts = [
        inter.options.getString('option1', true),
        inter.options.getString('option2', true),
        inter.options.getString('option3'),
        inter.options.getString('option4'),
        inter.options.getString('option5'),
      ].filter(Boolean)
      const emojis = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣']
      const ch = inter.options.getChannel('channel') || inter.channel
      if (ch.type !== ChannelType.GuildText) return inter.reply({ content: 'Select a text channel.', ephemeral: true })
      const desc = opts.map((o, i) => `${emojis[i]} ${o}`).join('\n')
      const e = new EmbedBuilder().setColor(0x8b5cf6).setTitle('📊 ' + question).setDescription(desc).setFooter({ text: `Poll by ${inter.user.tag}` }).setTimestamp()
      const msg = await ch.send({ embeds: [e] })
      for (let i = 0; i < opts.length; i++) await msg.react(emojis[i]).catch(() => {})
      return inter.reply({ content: `Poll posted in ${ch}.`, ephemeral: true })
    }
    if (n === 'dm') {
      if (!isAdmin(inter.member) && !isKeyManagerUser(inter)) return inter.reply({ content: 'Admin permission required.', ephemeral: true })
      await inter.deferReply({ ephemeral: true })
      const target = inter.options.getUser('user', true)
      const message = inter.options.getString('message', true)
      const sent = await target.send(fmt(message)).catch(() => null)
      if (!sent) return inter.editReply(`Could not DM ${target.tag} — they may have DMs disabled.`)
      return inter.editReply(`DM sent to ${target.tag}.`)
    }
    if (n === 'announce') {
      if (!isAdmin(inter.member) && !isKeyManagerUser(inter)) return inter.reply({ content: 'Admin permission required.', ephemeral: true })
      const ch = inter.options.getChannel('channel', true)
      if (ch.type !== ChannelType.GuildText) return inter.reply({ content: 'Select a text channel.', ephemeral: true })
      const title = inter.options.getString('title', true)
      const body = fmt(inter.options.getString('message', true))
      const pingRole = inter.options.getRole('ping')
      const colorHex = inter.options.getString('color') || '#8b5cf6'
      const e = new EmbedBuilder()
        .setColor(col(colorHex.replace('#', '')))
        .setTitle(title)
        .setDescription(body)
        .setFooter({ text: inter.guild.name })
        .setTimestamp()
      const content = pingRole ? `<@&${pingRole.id}>` : undefined
      await ch.send({ content, embeds: [e], allowedMentions: { roles: pingRole ? [pingRole.id] : [] } })
      return inter.reply({ content: `Announcement posted in ${ch}.`, ephemeral: true })
    }
    if (n === 'bot_channels') {
      if (!(isAdmin(inter.member) || isKeyManagerUser(inter))) return inter.reply({ content: 'Admin or bot access permission required.', ephemeral: true })
      const c = inter.options.getChannel('commits'), r = inter.options.getChannel('releases'), t = inter.options.getChannel('transcripts'), ml = inter.options.getChannel('modlog')
      if (c) state.channels.commits = c.id
      if (r) state.channels.releases = r.id
      if (t) state.channels.transcripts = t.id
      if (ml) { state.channels.modlog = ml.id; modLogChannelId = ml.id }
      saveState()
      return inter.reply({ content: `Saved.\nCommits: ${state.channels.commits || 'not set'}\nReleases: ${state.channels.releases || 'not set'}\nTranscripts: ${state.channels.transcripts || 'not set'}\nMod Log: ${state.channels.modlog || 'not set'}`, ephemeral: true })
    }
    if (n === 'bot_config') {
      if (!(isAdmin(inter.member) || isKeyManagerUser(inter))) return inter.reply({ content: 'Admin or bot access permission required.', ephemeral: true })
      const e = new EmbedBuilder().setColor(0x8b5cf6).setTitle('Bot Config').addFields(
        { name: 'Commits', value: state.channels.commits ? `<#${state.channels.commits}>` : 'Not set', inline: true },
        { name: 'Releases', value: state.channels.releases ? `<#${state.channels.releases}>` : 'Not set', inline: true },
        { name: 'Transcripts', value: state.channels.transcripts ? `<#${state.channels.transcripts}>` : 'Not set', inline: true },
        { name: 'Mod Log', value: state.channels.modlog ? `<#${state.channels.modlog}>` : 'Not set', inline: true }
      )
      return inter.reply({ embeds: [e], ephemeral: true })
    }
    // ── Automod commands ──────────────────────────────────────────────────────
    if (n.startsWith('automod')) {
      if (!isAdmin(inter.member) && !isKeyManagerUser(inter)) return inter.reply({ content: 'Admin permission required.', ephemeral: true })

      if (n === 'automod_toggle') {
        const rule = inter.options.getString('rule', true)
        const action = inter.options.getString('action', true)
        if (rule === 'all') {
          // Toggle master enabled/disabled
          if (action === 'off') {
            state.automod.enabled = false
            saveState()
            return inter.reply({ content: '🛡️ Automod **disabled**.', ephemeral: true })
          } else {
            state.automod.enabled = true
            // Set sensible defaults if not configured yet
            if (state.automod.rules.invites === 'off') state.automod.rules.invites = 'timeout'
            if (state.automod.rules.links === 'off') state.automod.rules.links = 'timeout'
            if (state.automod.rules.spam === 'off') state.automod.rules.spam = 'timeout'
            saveState()
            return inter.reply({ content: `🛡️ Automod **enabled**. Crack detection is always on. Use \`/automod_toggle\` for individual rules.`, ephemeral: true })
          }
        }
        if (!automodActionChoices.includes(action)) return inter.reply({ content: `Action must be one of: ${automodActionChoices.join(', ')}`, ephemeral: true })
        state.automod.rules[rule] = action
        saveState()
        return inter.reply({ content: `🛡️ Automod rule **${rule}** set to **${action}**.`, ephemeral: true })
      }

      if (n === 'automod_status') {
        const am = state.automod
        const ruleLines = Object.entries(am.rules || {}).map(([k, v]) => `**${k}**: \`${v}\``).join('\n')
        const e = new EmbedBuilder()
          .setColor(am.enabled ? 0x22c55e : 0xef4444)
          .setTitle(`🛡️ Automod — ${am.enabled ? 'ENABLED' : 'DISABLED'}`)
          .addFields(
            { name: 'Rules', value: ruleLines || 'None configured', inline: false },
            { name: 'Crack Detection', value: '`always on` (ban)', inline: true },
            { name: 'Timeout Duration', value: `${am.timeoutMinutes || 10} min`, inline: true },
            { name: 'Max Mentions', value: String(am.maxMentions || 6), inline: true },
            { name: 'Spam Window', value: `${am.spamMaxMessages || 6} msgs / ${am.spamWindowSec || 8}s`, inline: true },
            { name: 'Log Channel', value: am.logChannelId ? `<#${am.logChannelId}>` : 'Not set', inline: true },
            { name: 'Allowed Domains', value: (am.allowedDomains || []).join(', ').slice(0, 500) || 'None', inline: false },
            { name: 'Bad Words', value: String((am.badWords || []).length) + ' configured', inline: true },
          )
        return inter.reply({ embeds: [e], ephemeral: true })
      }

      if (n === 'automod_limits') {
        const timeout = inter.options.getInteger('timeout_minutes')
        const spam = inter.options.getInteger('spam_messages')
        const window = inter.options.getInteger('spam_window_sec')
        const mentions = inter.options.getInteger('max_mentions')
        const caps = inter.options.getNumber('caps_threshold')
        if (timeout != null) state.automod.timeoutMinutes = clamp(timeout, 1, 40320)
        if (spam != null) state.automod.spamMaxMessages = clamp(spam, 2, 30)
        if (window != null) state.automod.spamWindowSec = clamp(window, 2, 60)
        if (mentions != null) state.automod.maxMentions = clamp(mentions, 2, 20)
        if (caps != null) state.automod.capsThreshold = clamp(caps, 0.5, 1.0)
        saveState()
        return inter.reply({ content: '✅ Automod limits updated.', ephemeral: true })
      }

      if (n === 'automod_badword_add') {
        const word = inter.options.getString('word', true).toLowerCase().trim()
        if (!state.automod.badWords.includes(word)) { state.automod.badWords.push(word); saveState() }
        return inter.reply({ content: `✅ Added bad word: \`${word}\``, ephemeral: true })
      }

      if (n === 'automod_badword_remove') {
        const word = inter.options.getString('word', true).toLowerCase().trim()
        state.automod.badWords = state.automod.badWords.filter(w => w !== word)
        saveState()
        return inter.reply({ content: `✅ Removed: \`${word}\``, ephemeral: true })
      }

      if (n === 'automod_badword_list') {
        const list = state.automod.badWords.length ? state.automod.badWords.map(w => `\`${w}\``).join(', ') : 'None'
        return inter.reply({ content: `**Bad Words:** ${list.slice(0, 1900)}`, ephemeral: true })
      }

      if (n === 'automod_domain_add') {
        const domain = normalizeDomain(inter.options.getString('domain', true))
        if (!state.automod.allowedDomains.includes(domain)) { state.automod.allowedDomains.push(domain); saveState() }
        return inter.reply({ content: `✅ Allowed domain: \`${domain}\``, ephemeral: true })
      }

      if (n === 'automod_domain_remove') {
        const domain = normalizeDomain(inter.options.getString('domain', true))
        state.automod.allowedDomains = state.automod.allowedDomains.filter(d => d !== domain)
        saveState()
        return inter.reply({ content: `✅ Removed domain: \`${domain}\``, ephemeral: true })
      }

      if (n === 'automod_domain_list') {
        const list = state.automod.allowedDomains.length ? state.automod.allowedDomains.map(d => `\`${d}\``).join(', ') : 'None'
        return inter.reply({ content: `**Allowed Domains:** ${list.slice(0, 1900)}`, ephemeral: true })
      }

      if (n === 'automod_logchannel') {
        const ch = inter.options.getChannel('channel')
        state.automod.logChannelId = ch?.id || ''
        saveState()
        return inter.reply({ content: ch ? `✅ Automod logs → ${ch}` : '✅ Automod log channel cleared.', ephemeral: true })
      }

      return inter.reply({ content: 'Unknown automod command.', ephemeral: true })
    }
  } catch (e) {
    const cmdName = inter.isChatInputCommand() ? inter.commandName : (inter.customId || 'unknown')
    console.error(`[command] Error in "${cmdName}" from ${inter.user?.id}:`, e?.message || e)
    const isTimeout = e?.name === 'AbortError' || String(e?.message || '').includes('timeout')
    const msg = isTimeout
      ? '⚠️ The license server took too long to respond. Please try again in a moment.'
      : `❌ An error occurred while processing this command. Please try again.`
    try {
      if (inter.deferred || inter.replied) await inter.followUp({ content: msg, ephemeral: true }).catch(() => {})
      else await inter.reply({ content: msg, ephemeral: true }).catch(() => {})
    } catch (_) {}
  }
})


// ── Comprehensive Automod ────────────────────────────────────────────────────
// Patterns that indicate piracy / crack distribution — immediate ban territory
const CRACK_PATTERNS = [
  // zenith + crack anywhere in the same message (with any words between)
  /\bzenith\b.{0,60}\bcrack(ed|s)?\b/i,
  /\bcrack(ed|s)?\b.{0,60}\bzenith\b/i,
  // "dm (me) (for) crack/free/nulled" regardless of what follows
  /\bdm\b.{0,40}\b(crack(ed)?|nulled|free)\b/i,
  // explicit phrases
  /\bfree\s+zenith\b/i,
  /\bnulled\s+zenith\b/i,
  /\bzenith\s+nulled\b/i,
  /\bget\s+zenith\s+for\s+free\b/i,
  /\bzenith\b.{0,40}\bfor\s+free\b/i,
  /\bcracked\s+client\b/i,
  /\bcrack\s+client\b/i,
  /\bsell(ing)?\s+cracked\b/i,
  // file/crack hosts (high signal)
  /\bpaste\s*bin\.com\b/i,
  /\bmega\.nz\b/i,
  /\bmediafire\.com\b/i,
  /\bgofile\.io\b/i,
  /\banonfiles?\b/i,
  // key/bypass
  /\bzenith\b.{0,40}\bkeygen\b/i,
  /\bkeygen\b.{0,40}\bzenith\b/i,
  /\bbypass\s+(hwid|license)\b/i,
  /\bhwid\s+bypass\b/i,
]

// Patterns that indicate self-promotion / scam links
const SELF_PROMO_PATTERNS = [
  /\bsubscribe\s+to\s+my\b/i,
  /\bcheck\s+out\s+my\s+(server|discord|channel|youtube|tiktok)\b/i,
  /\bjoin\s+my\s+server\b/i,
  /\bfollow\s+my\b/i,
  /\bmy\s+discord\s+server\b/i,
  /\bpromo\s+code\b/i,
]

// Discord invite patterns
const DISCORD_INVITE_RE = /(?:discord\.gg|discord\.com\/invite|discordapp\.com\/invite)\/[a-zA-Z0-9-]+/i

// Safe domains that are always allowed (in addition to state.automod.allowedDomains)
const ALWAYS_ALLOWED_DOMAINS = new Set([
  'zenithmacros.store',
  'discord.com',
  'discord.gg',
  'discordapp.com',
  'youtube.com',
  'youtu.be',
  'twitter.com',
  'x.com',
  'tenor.com',
  'giphy.com',
  'imgur.com',
  'prnt.sc',
  'gyazo.com',
  'i.imgur.com',
  'cdn.discordapp.com',
  'media.discordapp.net',
])

// New account threshold (accounts < N days old are flagged as potential bots on join)
const NEW_ACCOUNT_THRESHOLD_DAYS = 7

async function runAutomod(message) {
  try {
    if (!message.guild) return
    if (message.author.bot) return

    // Ticket channels are fully exempt from all automod rules
    // Check both state (keyed by channel ID) and channel name prefix as a fallback
    if (state.tickets?.[message.channel.id]) return
    if (message.channel.name?.startsWith('ticket-')) return

    const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null)
    if (!member) return

    // Staff / admins are immune from all automod
    if (isAdmin(member) || hasSupport(member)) return

    const content = message.content || ''
    const contentLower = content.toLowerCase()

    // ── 1. CRACK DETECTION — always active, regardless of automod enabled flag ─
    const isCrack = CRACK_PATTERNS.some(p => p.test(content))
    if (isCrack) {
      await message.delete().catch(() => {})
      await automodLog(message.guild, {
        userId: message.author.id,
        rule: 'crack_distribution',
        action: 'ban',
        channelId: message.channel.id,
        summary: `🚫 Crack/piracy content detected — user banned`,
        sample: content.slice(0, 500),
      })
      // Warn then ban
      await message.author.send({
        embeds: [new EmbedBuilder()
          .setColor(0xef4444)
          .setTitle('🚫 Banned from Zenith Macros')
          .setDescription('You have been **permanently banned** from the Zenith Macros server for distributing or promoting cracked/pirated software. This is a zero-tolerance policy.')
          .setTimestamp()]
      }).catch(() => {})
      await member.ban({ reason: 'Automod: crack/piracy content distribution', deleteMessageSeconds: 86400 }).catch(() => {})
      return
    }

    // All rules below require automod to be explicitly enabled
    if (!state.automod?.enabled) return

    // ── 2. DISCORD INVITE LINKS ───────────────────────────────────────────────
    const hasInvite = DISCORD_INVITE_RE.test(content)
    const inviteRule = state.automod.rules?.invites || 'off'
    if (hasInvite && inviteRule !== 'off') {
      // Allow if the invite leads to the server's own guild
      const inviteMatch = content.match(/(?:discord\.gg|discord\.com\/invite|discordapp\.com\/invite)\/([a-zA-Z0-9-]+)/i)
      let isOwnServer = false
      if (inviteMatch) {
        try {
          const inv = await message.client.fetchInvite(inviteMatch[1]).catch(() => null)
          if (inv?.guild?.id === message.guild.id) isOwnServer = true
        } catch (_) {}
      }
      if (!isOwnServer) {
        await message.delete().catch(() => {})
        await automodLog(message.guild, {
          userId: message.author.id,
          rule: 'invites',
          action: inviteRule,
          channelId: message.channel.id,
          summary: `External Discord invite link removed`,
          sample: content.slice(0, 300),
        })
        if (inviteRule === 'timeout') {
          const ms = state.automod.timeoutMinutes * 60 * 1000
          await member.timeout(ms, 'Automod: external Discord invite').catch(() => {})
          await message.author.send({
            embeds: [new EmbedBuilder()
              .setColor(0xf59e0b)
              .setTitle('⚠️ Timed Out — Self-Promotion Not Allowed')
              .setDescription(`You've been timed out for **${state.automod.timeoutMinutes} minutes** for posting external Discord invite links. Self-promotion is not permitted in this server.`)
              .setTimestamp()]
          }).catch(() => {})
        }
        return
      }
    }

    // ── 3. SELF-PROMOTION / EXTERNAL LINKS ───────────────────────────────────
    const linksRule = state.automod.rules?.links || 'off'
    if (linksRule !== 'off') {
      const domains = extractDomainsFromContent(content)
      const allowedDomains = [...state.automod.allowedDomains]
      const blockedDomains = domains.filter(d =>
        !ALWAYS_ALLOWED_DOMAINS.has(d) &&
        !matchesAllowedDomain(d, allowedDomains)
      )
      // Also check self-promo patterns even without external links
      const hasSelfPromo = SELF_PROMO_PATTERNS.some(p => p.test(content))

      if (blockedDomains.length > 0 || hasSelfPromo) {
        await message.delete().catch(() => {})
        await automodLog(message.guild, {
          userId: message.author.id,
          rule: 'links',
          action: linksRule,
          channelId: message.channel.id,
          summary: `Self-promotion or external link: ${blockedDomains.join(', ') || 'self-promo text'}`,
          sample: content.slice(0, 300),
        })
        if (linksRule === 'timeout') {
          const ms = state.automod.timeoutMinutes * 60 * 1000
          await member.timeout(ms, 'Automod: external link / self-promotion').catch(() => {})
          await message.author.send({
            embeds: [new EmbedBuilder()
              .setColor(0xf59e0b)
              .setTitle('⚠️ Timed Out — Advertising Not Allowed')
              .setDescription(`You've been timed out for **${state.automod.timeoutMinutes} minutes** for posting promotional or off-topic links. Keep links relevant to Zenith Macros.`)
              .setTimestamp()]
          }).catch(() => {})
        }
        return
      }
    }

    // ── 4. BAD WORDS ──────────────────────────────────────────────────────────
    const badwordsRule = state.automod.rules?.badwords || 'off'
    if (badwordsRule !== 'off' && state.automod.badWords?.length) {
      const matched = state.automod.badWords.find(w => {
        const re = new RegExp(`\\b${escapeRegExp(w)}\\b`, 'i')
        return re.test(contentLower)
      })
      if (matched) {
        await message.delete().catch(() => {})
        await automodLog(message.guild, {
          userId: message.author.id,
          rule: 'badwords',
          action: badwordsRule,
          channelId: message.channel.id,
          summary: `Banned word detected: "${matched}"`,
          sample: content.slice(0, 300),
        })
        if (badwordsRule === 'timeout') {
          const ms = state.automod.timeoutMinutes * 60 * 1000
          await member.timeout(ms, `Automod: banned word`).catch(() => {})
        }
        return
      }
    }

    // ── 5. EXCESSIVE CAPS ─────────────────────────────────────────────────────
    const capsRule = state.automod.rules?.caps || 'off'
    if (capsRule !== 'off') {
      const { ratio, count } = messageCapsRatio(content)
      if (count >= (state.automod.capsMinLength || 10) && ratio >= (state.automod.capsThreshold || 0.78)) {
        await message.delete().catch(() => {})
        await automodLog(message.guild, {
          userId: message.author.id,
          rule: 'caps',
          action: capsRule,
          channelId: message.channel.id,
          summary: `Excessive caps (${Math.round(ratio * 100)}%)`,
          sample: content.slice(0, 300),
        })
        if (capsRule === 'timeout') {
          const ms = state.automod.timeoutMinutes * 60 * 1000
          await member.timeout(ms, 'Automod: excessive caps').catch(() => {})
        }
        return
      }
    }

    // ── 6. SPAM (repeated messages in short window) ───────────────────────────
    const spamRule = state.automod.rules?.spam || 'off'
    if (spamRule !== 'off') {
      const key = `${message.guild.id}:${message.author.id}`
      const now = Date.now()
      const windowMs = (state.automod.spamWindowSec || 8) * 1000
      const maxMsgs = state.automod.spamMaxMessages || 6
      if (!spamTracker.has(key)) spamTracker.set(key, [])
      const times = spamTracker.get(key).filter(t => now - t < windowMs)
      times.push(now)
      spamTracker.set(key, times)
      if (times.length >= maxMsgs) {
        spamTracker.delete(key)
        await message.delete().catch(() => {})
        await automodLog(message.guild, {
          userId: message.author.id,
          rule: 'spam',
          action: spamRule,
          channelId: message.channel.id,
          summary: `Spam: ${times.length} messages in ${state.automod.spamWindowSec}s`,
          sample: content.slice(0, 300),
        })
        if (spamRule === 'timeout') {
          const ms = state.automod.timeoutMinutes * 60 * 1000
          await member.timeout(ms, 'Automod: spam').catch(() => {})
          await message.author.send({
            embeds: [new EmbedBuilder()
              .setColor(0xf59e0b)
              .setTitle('⚠️ Timed Out — Spam Detected')
              .setDescription(`You've been timed out for **${state.automod.timeoutMinutes} minutes** for sending too many messages in a short period.`)
              .setTimestamp()]
          }).catch(() => {})
        }
        return
      }
    }

    // ── 7. EXCESSIVE MENTIONS ─────────────────────────────────────────────────
    const maxMentions = state.automod.maxMentions || 6
    const mentionCount = (message.mentions.users?.size || 0) + (message.mentions.roles?.size || 0)
    if (mentionCount >= maxMentions) {
      await message.delete().catch(() => {})
      const ms = state.automod.timeoutMinutes * 60 * 1000
      await member.timeout(ms, 'Automod: mention spam').catch(() => {})
      await automodLog(message.guild, {
        userId: message.author.id,
        rule: 'mention_spam',
        action: 'timeout',
        channelId: message.channel.id,
        summary: `Mention spam: ${mentionCount} mentions`,
        sample: content.slice(0, 300),
      })
    }
  } catch (err) {
    console.error('[automod] error:', err?.message || err)
  }
}

// Hook automod into every new message
client.on(Events.MessageCreate, async message => {
  await runAutomod(message).catch(() => {})
})

// Also scan edited messages (people editing in invite links / crack content)
client.on(Events.MessageUpdate, async (_old, message) => {
  if (!message.partial) await runAutomod(message).catch(() => {})
})

// New member anti-bot check — flag very new accounts in the log channel
client.on(Events.GuildMemberAdd, async member => {
  if (!state.automod?.enabled) return
  if (!member.user.bot) {
    const accountAgeDays = (Date.now() - member.user.createdTimestamp) / 86400000
    if (accountAgeDays < NEW_ACCOUNT_THRESHOLD_DAYS) {
      await automodLog(member.guild, {
        userId: member.user.id,
        rule: 'new_account',
        action: 'flagged',
        channelId: '',
        summary: `⚠️ New account joined (${Math.floor(accountAgeDays)}d old) — possible bot/alt`,
        sample: '',
      })
    }
  }
})

function startHealthServer() {
  const jsonReply = (res, status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(payload || {}))
  }

  const server = http.createServer((req, res) => {
    ;(async () => {
      const method = String(req.method || 'GET').toUpperCase()
      const reqPath = String(req.url || '/').split('?')[0]

      if (reqPath === '/healthz' && method === 'GET') {
        return jsonReply(res, 200, {
          ok: true,
          uptimeSec: Math.floor(process.uptime()),
          timestamp: new Date().toISOString()
        })
      }

      if (reqPath === '/api/presets/publish' && method === 'POST') {
        let bodyText = ''
        try {
          bodyText = await readRequestBody(req)
        } catch (err) {
          const msg = String(err?.message || '')
          if (msg === 'payload-too-large') return jsonReply(res, 413, { ok: false, error: 'Payload too large' })
          return jsonReply(res, 400, { ok: false, error: 'Could not read request body' })
        }

        if (!verifyBotRequestAuth(req, method, reqPath, bodyText)) {
          return jsonReply(res, 401, { ok: false, error: 'Unauthorized' })
        }

        let payload = null
        try {
          payload = JSON.parse(bodyText || '{}')
        } catch (_) {
          return jsonReply(res, 400, { ok: false, error: 'Invalid JSON body' })
        }

        const channelId = String(payload?.channelId || CFG.macroPresetChannel || '').trim()
        const macroName = fmt(payload?.macroName || '').slice(0, 64)
        const code = fmt(payload?.code || '').slice(0, 4096)
        const password = fmt(payload?.password || '').slice(0, 256)
        const note = fmt(payload?.note || '').slice(0, 500)
        const publisher = fmt(payload?.publisher || '').slice(0, 64)

        if (!channelId || !macroName || !code || !password) {
          return jsonReply(res, 400, { ok: false, error: 'channelId, macroName, code, and password are required' })
        }

        try {
          const sent = await sendMacroPresetToChannel({ channelId, macroName, code, password, note, publisher })
          return jsonReply(res, 200, { ok: true, ...sent })
        } catch (err) {
          return jsonReply(res, 500, { ok: false, error: err?.message || 'Preset publish failed' })
        }
      }

      return jsonReply(res, 404, { ok: false, error: 'Not found' })
    })().catch((err) => {
      console.error('[health] request error:', err?.message || err)
      if (!res.headersSent) {
        jsonReply(res, 500, { ok: false, error: 'Internal server error' })
      }
    })
  })
  server.on('error', err => {
    console.error(`[health] server error: ${err.message}`)
  })
  server.listen(HEALTH_PORT, () => {
    console.log(`[health] listening on port ${HEALTH_PORT}`)
  })
}

async function main() {
  startHealthServer()
  await registerCommands()
  await client.login(env.DISCORD_TOKEN)
}
main().catch(e => {
  console.error('Fatal startup error:', e)
  process.exit(1)
})


