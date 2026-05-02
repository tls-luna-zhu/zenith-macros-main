// ─────────────────────────────────────────────────────────────────────────────
//  macros/input.js  —  native Win32 input
//
//  Keyboard:  keysender Hardware  (sendKey → SendInput, KEYEVENTF_SCANCODE)
//             KEY_HOLD_MS=20 → key held 20ms between down and up, spanning
//             at least one GLFW poll at 60fps (16.7ms/frame) so the slot
//             switch is registered before keyup arrives.
//             Anchor macros (SA/DA/AP) use slotClick() instead of press():
//             keydown and mousedown are queued concurrently via Win32 SendInput,
//             reducing step time from 27ms to 10ms (CLICK_HOLD_MS).
//             focusLock.focusMc() is called before every anchor sequence to force
//             SetForegroundWindow(mcHwnd), ensuring SendInput goes to
//             Minecraft instead of the Electron window.
//  Mouse:     keysender Hardware  (mouseToggle → SendInput WITH hardware flags)
//             Minecraft/GLFW ignores software mouse events without hardware flags.
//  Timing:    deterministic delays only (no stealth jitter or pattern breaks).
// ─────────────────────────────────────────────────────────────────────────────

const { Hardware }  = require('../electron/keysender-safe')
const focusLock     = require('../electron/focus-lock')
const { toKeysenderKey, normalizeBindToken } = require('../electron/keymap')
const timing = {
  vary(ms) {
    return Math.max(0, Number(ms) || 0)
  },
  varyHold(ms) {
    return Math.max(0, Number(ms) || 0)
  },
  shouldSkipClick() {
    return false
  }
}
const { getClickBinds, resolveMouseButton, setClickBinds } = require('./click-binds')

// Global hardware input instance — desktop mode (no window handle).
// Keyboard SendInput goes to the Win32 foreground window (set by focusMc).
// Mouse hardware events go to the cursor position unconditionally.
let _hwInstance = null
const hw = new Proxy({}, {
  get(_target, prop) {
    if (!_hwInstance) _hwInstance = new Hardware()
    const value = _hwInstance[prop]
    return typeof value === 'function' ? value.bind(_hwInstance) : value
  }
})

// Base hold time (ms) between keydown and keyup.
const KEY_HOLD_MS   = 20
// Base hold time between mousedown and mouseup so Minecraft registers the click.
const CLICK_HOLD_MS = 10
// How long to hold the slot-switch key when it is a mouse button (ms).
// Also the minimum key hold inside slotClick's concurrent path — key is released
// concurrently with the click so 17ms > one 60fps GLFW frame (16.7ms) is not
// strictly required here, but keeping it consistent avoids edge-case misses.
const SLOT_HOLD_MS  = 17

// Maps user-facing mouse button names → keysender mouse button strings.
// Used by press() so macro action keys (anchorKey, glowstoneKey, etc.) can be
// bound to mouse buttons — routed through hw.mouse.toggle() instead of sendKey.
const PRESS_MOUSE_MAP = {
  Mouse1: 'left',
  Mouse2: 'right',
  Mouse3: 'middle',
  Mouse4: 'x1',
  Mouse5: 'x2',
}

function _mouseButtonFromBind(rawKey) {
  const token = normalizeBindToken(rawKey)
  if (!token) return null
  return PRESS_MOUSE_MAP[token] || null
}

function _toSendKey(rawKey) {
  const mapped = toKeysenderKey(rawKey)
  if (mapped) return mapped
  const token = normalizeBindToken(rawKey)
  if (!token || token === 'None') return null
  return String(token).toLowerCase()
}

// ── Cancellation tokens ───────────────────────────────────────────────────────
const macroTokens = {}

function sleep(ms, token) {
  return new Promise(resolve => {
    if (token?.cancelled) return resolve()
    const tid = setTimeout(resolve, ms)
    if (token) token._cancel = () => { clearTimeout(tid); resolve() }
  })
}

async function startMacro(id, fn) {
  // Skip if this macro is still running.
  // Prevents mouse-button contact bounce / accidental double-press from
  // cancelling the first run mid-sequence (e.g. glowstone never pressed
  // because the anchor→glowstone sleep token was cancelled by the second trigger).
  // KP/IDH are safe: their hook is unregistered while running so they
  // cannot be double-triggered from the hook side anyway.
  if (macroTokens[id]) return

  const token = { cancelled: false, _cancel: null }
  macroTokens[id] = token

  try { await fn(token) }
  catch(e) { if (!token.cancelled) console.error(`[macro:${id}]`, e.message) }
  finally  { if (macroTokens[id] === token) delete macroTokens[id] }
}

// Queue-one scheduler for anchor macros (SA / DA / AP).
//
// Why not cancel-and-restart:
//   Cancelling mid-sequence leaves a partially-executed run (sendKey / mouse.toggle
//   calls already in flight in the OS queue).  The new run then starts immediately,
//   so both runs are pushing hardware events concurrently — slot switches and clicks
//   interleave and the sequence corrupts.
//
// Queue-one behaviour:
//   • If no run is active  → start immediately.
//   • If a run is active   → store fn as the pending next-run (latest press wins).
//   • When the active run finishes → if a next-run was queued, fire it with zero gap.
//   • stopAll()            → clears both the active token and any queued run.
//
// This means spam-pressing always chains sequences back-to-back with no gap and
// no interleaved hardware events, because each sequence runs to completion before
// the next begins.
const macroQueue = {}

async function startAnchorMacro(id, fn) {
  if (macroTokens[id]) {
    // Run in progress — park this press; it will fire the moment the run ends.
    macroQueue[id] = fn
    return
  }

  const token = { cancelled: false, _cancel: null }
  macroTokens[id] = token
  try { await fn(token) }
  catch(e) { if (!token.cancelled) console.error(`[macro:${id}]`, e.message) }
  finally {
    if (macroTokens[id] === token) delete macroTokens[id]
    // Fire the queued run immediately — but not if stopAll() cancelled us.
    if (macroQueue[id] && !token.cancelled) {
      const next = macroQueue[id]
      delete macroQueue[id]
      startAnchorMacro(id, next)  // fire-and-forget; runSA/DA/AP already returned
    } else {
      delete macroQueue[id]       // discard stale queue if we were stopped
    }
  }
}

// ── Low-level input primitives ────────────────────────────────────────────────

// focusMc() → SetForegroundWindow(mcHwnd): guarantees the next SendInput
// keyboard event is directed to Minecraft's thread, not Electron's.
// varyHold(KEY_HOLD_MS) applies ±(1–7)ms jitter to the hold duration.
async function press(key, token, holdMs) {
  if (token?.cancelled) return
  if (!key || key === 'None') return

  // If the macro action key is a mouse button, toggle it via SendInput hardware
  // flags (same path as lClick/rClick) — sendKey only accepts keyboard keys.
  const mouseBtn = _mouseButtonFromBind(key)
  if (mouseBtn) {
    const clickHold = holdMs ?? CLICK_HOLD_MS
    try {
      await hw.mouse.toggle(mouseBtn, true)
      await sleep(timing.varyHold(clickHold), token)
      if (token?.cancelled) { await hw.mouse.toggle(mouseBtn, false).catch(() => {}); return }
      await hw.mouse.toggle(mouseBtn, false)
    } catch (_) {}
    return
  }

  const keyHold = holdMs ?? KEY_HOLD_MS
  focusLock.focusMc()
  await sleep(2, token)
  if (token?.cancelled) return
  try { await hw.keyboard.sendKey(_toSendKey(key), timing.varyHold(keyHold), 0) } catch(_) {}
}

// Hardware mouse clicks — keysender sends SendInput with MOUSEEVENTF_* flags
// so Minecraft/GLFW processes them regardless of keyboard focus state.
// varyHold(CLICK_HOLD_MS) applies ±(1–7)ms jitter to the hold duration.
async function _clickWithBind(bindKey, token, holdMs) {
  if (token?.cancelled) return
  if (!bindKey || bindKey === 'None') return

  const mouseBtn = resolveMouseButton(bindKey)
  if (mouseBtn) {
    await hw.mouse.toggle(mouseBtn, true)
    await sleep(timing.varyHold(holdMs ?? CLICK_HOLD_MS), token)
    if (token?.cancelled) { await hw.mouse.toggle(mouseBtn, false).catch(() => {}); return }
    await hw.mouse.toggle(mouseBtn, false)
    return
  }

  try {
    await hw.keyboard.sendKey(_toSendKey(bindKey), timing.varyHold(holdMs ?? CLICK_HOLD_MS), 0)
  } catch (_) {}
}

async function rClick(token, holdMs) {
  if (token?.cancelled) return
  const { right } = getClickBinds()
  await _clickWithBind(right || 'Mouse2', token, holdMs)
}

async function lClickFixed(token) {
  if (token?.cancelled) return
  const { left } = getClickBinds()
  const bind = left || 'Mouse1'
  const mouseBtn = resolveMouseButton(bind)
  if (mouseBtn) {
    await hw.mouse.toggle(mouseBtn, true)
    await sleep(CLICK_HOLD_MS, token)
    await hw.mouse.toggle(mouseBtn, false)
    return
  }
  try { await hw.keyboard.sendKey(_toSendKey(bind), CLICK_HOLD_MS, 0) } catch (_) {}
}

// Dedicated physical left-click (Mouse1) path for placement/break consistency.
async function lClickMouse1Fixed(token) {
  if (token?.cancelled) return
  await hw.mouse.toggle('left', true)
  await sleep(CLICK_HOLD_MS, token)
  await hw.mouse.toggle('left', false)
}

// Fixed-duration right-click for anchor sequences (SA / DA / AP).
// rClick() passes through varyHold() which can vary hold by ±55 ms — at
// sub-30 ms step delays that collapses the inter-click gap below what
// Minecraft needs to process consecutive block interactions, causing misses.
// This version always holds for exactly CLICK_HOLD_MS with no jitter.
async function rClickFixed(token) {
  if (token?.cancelled) return
  const { right } = getClickBinds()
  const bind = right || 'Mouse2'
  const mouseBtn = resolveMouseButton(bind)
  if (mouseBtn) {
    await hw.mouse.toggle(mouseBtn, true)
    await sleep(CLICK_HOLD_MS, token)
    await hw.mouse.toggle(mouseBtn, false)
    return
  }
  try { await hw.keyboard.sendKey(_toSendKey(bind), CLICK_HOLD_MS, 0) } catch (_) {}
}

// Dedicated physical right-click (Mouse2) path for placement-critical flows.
async function rClickMouse2Fixed(token) {
  if (token?.cancelled) return
  await hw.mouse.toggle('right', true)
  await sleep(CLICK_HOLD_MS, token)
  await hw.mouse.toggle('right', false)
}

// slotClick — concurrent slot-switch + right-click for anchor sequences.
//
// Keyboard key path (the common case):
//   sendKey and the mouse chain run concurrently via Promise.all, and both are
//   fully awaited — slotClick only resolves after keyup AND mouseup are sent.
//   Key hold uses SLOT_HOLD_MS (17ms > one 60fps GLFW frame) so keydown and
//   keyup span at least one GLFW poll cycle — preventing both events landing in
//   the same cycle which would cause an intermittent missed slot switch.
//   Mouse hold uses CLICK_HOLD_MS (10ms).  Promise.all resolves at ~17ms
//   (keyboard governs).
//
//   Why Promise.all instead of the old fire-and-forget sendKey:
//   When startAnchorMacro chains a queued run immediately in its finally block,
//   the next slotClick's keydown must not reach GLFW before the previous keyup.
//   With fire-and-forget the keyup timer (17ms) outlived the function (10ms),
//   so the next keydown arrived before keyup — GLFW saw two consecutive keydowns
//   for the same key, treated the key as already-held, and ignored the slot
//   switch → partial sequence (only anchor placed / only glowstone placed) on spam.
//
// Mouse-button slot key path:
//   Two mouse buttons cannot be toggled simultaneously, so we fall back to
//   sequential: hold slot button for SLOT_HOLD_MS, release, then right-click.
async function slotClick(key, token) {
  if (token?.cancelled) return
  if (!key || key === 'None') return

  const slotMouseBtn = _mouseButtonFromBind(key)
  if (slotMouseBtn) {
    // Mouse button as slot key — sequential to avoid simultaneous mouse buttons.
    try {
      await hw.mouse.toggle(slotMouseBtn, true)
      await sleep(SLOT_HOLD_MS, token)
      if (token?.cancelled) { await hw.mouse.toggle(slotMouseBtn, false).catch(() => {}); return }
      await hw.mouse.toggle(slotMouseBtn, false)
    } catch (_) {}
    await rClickFixed(token)
    return
  }

  // Keyboard key — fire slot key first, give it a 3ms head-start so GLFW
  // polls the slot switch before the right-click, ensuring correct item placed.
  const { right } = getClickBinds()
  const bind = right || 'Mouse2'
  const mouseBtn = resolveMouseButton(bind)

  hw.keyboard.sendKey(_toSendKey(key), SLOT_HOLD_MS, 0).catch(() => {})
  await sleep(3, token)
  if (token?.cancelled) return

  if (mouseBtn) {
    await hw.mouse.toggle(mouseBtn, true)
    await sleep(CLICK_HOLD_MS, token)
    await hw.mouse.toggle(mouseBtn, false).catch(() => {})
  } else {
    try { await hw.keyboard.sendKey(_toSendKey(bind), CLICK_HOLD_MS, 0) } catch (_) {}
  }
  const remaining = SLOT_HOLD_MS - 3 - CLICK_HOLD_MS
  if (remaining > 0) await sleep(remaining, token)
}

// slotLClick — concurrent slot-switch + left-click for tick-sensitive swaps.
// Used by Lunge Swap so spear select and attack land in the same game tick.
async function slotLClick(key, token) {
  if (token?.cancelled) return
  if (!key || key === 'None') return

  const slotMouseBtn = _mouseButtonFromBind(key)
  if (slotMouseBtn) {
    try {
      await hw.mouse.toggle(slotMouseBtn, true)
      await sleep(SLOT_HOLD_MS, token)
      if (token?.cancelled) { await hw.mouse.toggle(slotMouseBtn, false).catch(() => {}); return }
      await hw.mouse.toggle(slotMouseBtn, false)
    } catch (_) {}
    await lClickFixed(token)
    return
  }

  const { left } = getClickBinds()
  const bind = left || 'Mouse1'
  const mouseBtn = resolveMouseButton(bind)

  // Give slot key a 3ms head-start before the click so GLFW polls the slot
  // switch before the attack lands — fixes intermittent stun misses.
  hw.keyboard.sendKey(_toSendKey(key), SLOT_HOLD_MS, 0).catch(() => {})
  await sleep(3, token)
  if (token?.cancelled) return

  if (mouseBtn) {
    await hw.mouse.toggle(mouseBtn, true)
    await sleep(CLICK_HOLD_MS, token)
    await hw.mouse.toggle(mouseBtn, false).catch(() => {})
  } else {
    try { await hw.keyboard.sendKey(_toSendKey(bind), CLICK_HOLD_MS, 0) } catch (_) {}
  }
  // Let slot key hold finish (SLOT_HOLD_MS - 3ms head-start - CLICK_HOLD_MS already waited)
  const remaining = SLOT_HOLD_MS - 3 - CLICK_HOLD_MS
  if (remaining > 0) await sleep(remaining, token)
}

async function lClick(token, holdMs) {
  if (token?.cancelled) return
  const { left } = getClickBinds()
  await _clickWithBind(left || 'Mouse1', token, holdMs)
}

// ── pressBare — press without re-focusing ─────────────────────────────────────
// Used inside anchor sequences after a single focusMc() at the top.
// Skipping repeated SetForegroundWindow calls saves ~2ms per keypress and
// eliminates the race where a rapid second focusMc() disturbs focus mid-sequence.
async function pressBare(key, token, holdMs = 1) {
  if (token?.cancelled) return
  if (!key || key === 'None') return
  const mouseBtn = _mouseButtonFromBind(key)
  if (mouseBtn) {
    try {
      await hw.mouse.toggle(mouseBtn, true)
      await sleep(holdMs, token)
      if (token?.cancelled) { await hw.mouse.toggle(mouseBtn, false).catch(() => {}); return }
      await hw.mouse.toggle(mouseBtn, false)
    } catch (_) {}
    return
  }
  try { await hw.keyboard.sendKey(_toSendKey(key), holdMs, 0) } catch (_) {}
}

async function toggleBare(key, isDown, token) {
  if (token?.cancelled && isDown) return
  if (!key || key === 'None') return
  const mouseBtn = _mouseButtonFromBind(key)
  if (mouseBtn) {
    try { await hw.mouse.toggle(mouseBtn, !!isDown) } catch (_) {}
    return
  }
  try { await hw.keyboard.toggleKey(_toSendKey(key), !!isDown, 0) } catch (_) {}
}

// ── SA — Single Anchor ────────────────────────────────────────────────────────
// Each step uses slotClick(): keydown and mousedown sent concurrently via the
// Win32 SendInput queue.  Queue ordering guarantees slot switch (keydown) is
// processed by GLFW before right-click (mousedown), so no sequential hold is
// needed between the two.  Step time = CLICK_HOLD_MS (10ms) vs the old 27ms.
//
// Sequence: anchor slot → rclick (place) → glowstone slot → rclick (charge)
//           → totem slot → rclick (detonate)
function _saActions(actions) {
  const order = ['place', 'charge', 'explode']
  const normalized = Array.isArray(actions)
    ? actions
        .map(v => String(v || '').trim().toLowerCase())
        .filter(v => order.includes(v))
    : []
  return normalized.length ? normalized : order
}

async function runSA(anchorKey, glowstoneKey, totemKey, delay, actions = null) {
  await startAnchorMacro('sa', async tok => {
    const d   = Math.max(0, Number(delay))
    const det = (totemKey && totemKey !== 'None') ? totemKey : '9'
    const steps = _saActions(actions)

    focusLock.focusMc()
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]
      if (step === 'place') await slotClick(anchorKey, tok)
      else if (step === 'charge') await slotClick(glowstoneKey, tok)
      else if (step === 'explode') await slotClick(det, tok)
      if (i < steps.length - 1) await sleep(d, tok)
    }

    const lastStep = steps[steps.length - 1]
    if (lastStep === 'place' && glowstoneKey && glowstoneKey !== 'None') {
      await sleep(d, tok)
      await pressBare(glowstoneKey, tok, SLOT_HOLD_MS)
    } else if (lastStep === 'charge' && det && det !== 'None') {
      await sleep(d, tok)
      await pressBare(det, tok, SLOT_HOLD_MS)
    }
  })
}

async function runSFA(anchorKey, glowstoneKey, totemKey, delay, sneakKey = 'Shift') {
  await startAnchorMacro('sfa', async tok => {
    const d   = Math.max(0, Number(delay))
    const det = (totemKey && totemKey !== 'None') ? totemKey : '9'
    const sneak = (sneakKey && sneakKey !== 'None') ? sneakKey : 'Shift'
    let sneakHeld = false

    focusLock.focusMc()
    await slotClick(anchorKey,    tok); await sleep(d, tok)
    await slotClick(glowstoneKey, tok)
    try {
      await toggleBare(sneak, true, tok)
      sneakHeld = true
      await sleep(d, tok)
      await pressBare(glowstoneKey, tok, SLOT_HOLD_MS); await sleep(d, tok)
      await rClickFixed(tok)
    } finally {
      if (sneakHeld) await toggleBare(sneak, false, null)
    }
    await sleep(Math.max(8, d), tok)
    await pressBare(det, tok, SLOT_HOLD_MS)
  })
}

// ── DA — Double Anchor ────────────────────────────────────────────────────────
// Two full SA cycles back-to-back with immediate chain into cycle #2.
async function runDA(anchorKey, glowstoneKey, totemKey, delay) {
  await startAnchorMacro('da', async tok => {
    const d   = Math.max(0, Number(delay))
    const det = (totemKey && totemKey !== 'None') ? totemKey : '9'
    // Brief settle time between cycles so cycle #2 doesn't start unrealistically
    // fast on low-delay configs, while still chaining immediately to players.
    const cycleGap = Math.max(8, Math.min(22, Math.floor(d * 0.35)))

    focusLock.focusMc()
    for (let i = 0; i < 2; i++) {
      await slotClick(anchorKey,    tok); await sleep(d, tok)
      await slotClick(glowstoneKey, tok); await sleep(d, tok)
      await slotClick(det,          tok)
      if (i === 0) await sleep(cycleGap, tok)
    }
  })
}

// ── AP — Anchor Pearl ─────────────────────────────────────────────────────────
// SA cycle, then throw an ender pearl immediately after detonation.
async function runAP(anchorKey, glowstoneKey, pearlKey, totemKey, delay) {
  await startAnchorMacro('ap', async tok => {
    const d   = Math.max(0, Number(delay))
    const det = (totemKey && totemKey !== 'None') ? totemKey : '9'

    focusLock.focusMc()
    await slotClick(anchorKey,    tok); await sleep(d, tok)
    await slotClick(glowstoneKey, tok); await sleep(d, tok)
    await slotClick(det,          tok); await sleep(d, tok)
    await pressBare(pearlKey,     tok, SLOT_HOLD_MS)
    await sleep(12, tok)
    await rClickFixed(tok)
    await sleep(Math.max(10, d), tok)
    await pressBare(det,          tok, SLOT_HOLD_MS)
  })
}

// ── KP — Key Pearl ────────────────────────────────────────────────────────────
// Pattern break applies — 1 in 20 fires the pearl click is skipped.
async function runKP(pearlKey, returnKey, delay) {
  await startMacro('kp', async tok => {
    const d = Math.max(0, Number(delay))
    await sleep(30, tok)
    await press(pearlKey, tok);  await sleep(timing.vary(d), tok)
    if (!timing.shouldSkipClick()) { focusLock.focusMc(); await sleep(5, tok); await rClick(tok) }
    await sleep(timing.vary(d), tok)
    await press(returnKey, tok)
  })
}

// ── IDH — Inventory D-Hand ────────────────────────────────────────────────────
// Keyboard keybinds (like E) also reach Minecraft and open inventory.
// The LowLevelHook fires BEFORE MC's GLFW poll processes the key, so we must
// wait for MC to open inventory (~100ms), then close it with Escape, then swap.
async function runIDH(totemKey, swapKey, delay) {
  await startMacro('idh', async tok => {
    const d = Math.max(0, Number(delay))
    // Wait for MC to process the keybind and open inventory
    await sleep(120, tok)
    // Close inventory with Escape
    await press('Escape', tok)
    await sleep(80, tok)
    // Now do the totem → offhand swap
    await press(totemKey, tok)
    await sleep(timing.vary(d), tok)
    await press(swapKey, tok)
  })
}

// ── OHT — Offhand Totem ───────────────────────────────────────────────────────
// Switch to totem slot, then press swap key (F).
// Each step uses press() which calls focusMc() to guarantee Minecraft focus.
async function runOHT(totemKey, swapKey, delay) {
  await startMacro('oht', async tok => {
    const d = Math.max(50, Number(delay) || 50)
    focusLock.focusMc()
    await sleep(30, tok)
    // Step 1: switch to totem slot
    await hw.keyboard.sendKey(_toSendKey(totemKey), KEY_HOLD_MS, 0).catch(() => {})
    // Step 2: wait for slot switch to register in game
    await sleep(d, tok)
    // Step 3: press offhand swap key
    focusLock.focusMc()
    await sleep(2, tok)
    await hw.keyboard.sendKey(_toSendKey(swapKey), KEY_HOLD_MS, 0).catch(() => {})
  })
}

// ── ASB — Auto Shield Breaker ─────────────────────────────────────────────────
// Shield stun chain: axe swap -> double-click stun, with user-configurable click gap.
async function runShieldStunFixed(axeKey, tok, doubleClickMs = 3) {
  const parsedDc = Number(doubleClickMs)
  const dc = Number.isFinite(parsedDc) ? Math.max(1, Math.min(100, parsedDc)) : 3
  focusLock.focusMc()
  await sleep(2, tok)
  // Concurrent slot switch to axe + left-click (first stun hit)
  await slotLClick(axeKey, tok)
  // Second hit in tight stun window to break shield
  await sleep(dc, tok)
  await lClickMouse1Fixed(tok)
}

async function runASB(axeKey, swordKey, doubleClickMs) {
  await startMacro('asb', async tok => {
    await sleep(10, tok)
    await runShieldStunFixed(axeKey, tok, doubleClickMs)
    await sleep(8, tok)
    await pressBare(swordKey, tok, SLOT_HOLD_MS)
  })
}

// ── FXP — Fast XP (toggle) ───────────────────────────────────────────────────
// Pattern break applies — 1 in 20 ticks the click is skipped.
let _fxpActive = false
let _fxpTimer  = null

function startFXP(delay) {
  if (_fxpActive) return
  _fxpActive = true
  console.log('[macro:fxp] started')
  const d = Math.max(1, Number(delay) || 35)
  _fxpTimer = setInterval(async () => {
    if (_fxpActive && !timing.shouldSkipClick()) {
      await rClick(null)
    }
  }, d)
}

function stopFXP() {
  if (!_fxpActive) return
  _fxpActive = false
  clearInterval(_fxpTimer)
  _fxpTimer = null
  console.log('[macro:fxp] stopped')
}

// ── ES — Elytra Swap ──────────────────────────────────────────────────────────
// Switch to elytra slot → wait delay → right-click to equip → return to set key.
async function runES(elytraKey, returnKey, delay) {
  await startMacro('es', async tok => {
    const d = Math.max(0, Number(delay))
    await sleep(30, tok)
    focusLock.focusMc()
    await pressBare(elytraKey, tok, SLOT_HOLD_MS)
    await sleep(timing.vary(d), tok)
    await rClickFixed(tok)
    await sleep(Math.max(12, d), tok)
    await pressBare(returnKey, tok, SLOT_HOLD_MS)
  })
}

// ── HC — Hit Crystal ──────────────────────────────────────────────────────────
// Place obsidian → place crystal → left-click to break crystal immediately.
async function runHC(obsidianKey, crystalKey, delay) {
  await startMacro('hc', async tok => {
    const d = Math.max(0, Number(delay))
    focusLock.focusMc()
    await sleep(10, tok)
    // 1. Switch to obsidian + place
    await pressBare(obsidianKey, tok, SLOT_HOLD_MS)
    await sleep(3, tok)
    await rClickMouse2Fixed(tok)
    // 2. Wait for server to register obsidian block (critical when moving)
    await sleep(Math.max(80, d), tok)
    // 3. Switch to crystal + spam right-click to guarantee placement
    await pressBare(crystalKey, tok, SLOT_HOLD_MS)
    await sleep(3, tok)
    for (let i = 0; i < 10 && !tok?.cancelled; i++) {
      await rClickMouse2Fixed(tok)
      await sleep(30, tok)
    }
    // 4. Left-click to break crystal
    await lClickMouse1Fixed(tok)
  })
}

// ── PC — Pearl Catch ──────────────────────────────────────────────────────────
// Switch to pearl → throw → wait delay ms → switch to wind charge → throw.
async function runPC(pearlKey, windChargeKey, delay) {
  await startMacro('pc', async tok => {
    const d = Math.max(0, Number(delay))
    await sleep(30, tok)
    await press(pearlKey, tok);      await rClick(tok)
    await sleep(timing.vary(d), tok)
    await press(windChargeKey, tok); await rClick(tok)
  })
}

// ── SS — Stun Slam ────────────────────────────────────────────────────────────
// Concurrent slot+click for both axe stun and mace slam — lands in same tick.
async function runSS(axeKey, maceKey, delay) {
  await startMacro('ss', async tok => {
    const d = Math.max(0, Number(delay))
    focusLock.focusMc()
    await sleep(10, tok)
    // Concurrent slot switch to axe + left-click (stun)
    await slotLClick(axeKey, tok)
    await sleep(d, tok)
    // Concurrent slot switch to mace + left-click (slam)
    await slotLClick(maceKey, tok)
  })
}

async function runSW(axeKey, cobwebKey, delay, doubleClickMs) {
  await startMacro('sw', async tok => {
    const d = Math.max(0, Number(delay))
    await sleep(10, tok)
    // Shield stun (concurrent slot+click, double-click)
    await runShieldStunFixed(axeKey, tok, doubleClickMs)
    await sleep(d, tok)
    // Concurrent slot switch to cobweb + right-click to place
    await slotClick(cobwebKey, tok)
  })
}


// ── BS — Breach Swap ──────────────────────────────────────────────────────────
// Switch to mace → lClick (hit) → wait delay → switch back to sword.
async function runBS(maceKey, swordKey, delay) {
  await startMacro('bs', async tok => {
    const d = Math.max(0, Number(delay))
    focusLock.focusMc()
    await sleep(2, tok)
    await slotLClick(maceKey, tok)
    await sleep(d, tok)
    await pressBare(swordKey, tok, SLOT_HOLD_MS)
  })
}

// ── LS — Lunge Swap ───────────────────────────────────────────────────────────
// Attribute swap sequence in one tick:
// sword slot -> spear slot + hit -> sword slot
async function runLS(swordKey, spearKey) {
  await startMacro('ls', async tok => {
    focusLock.focusMc()
    await sleep(2, tok)
    await pressBare(swordKey, tok, SLOT_HOLD_MS)
    await slotLClick(spearKey, tok)
    await sleep(8, tok)
    await pressBare(swordKey, tok, SLOT_HOLD_MS)
    await sleep(4, tok)
    await pressBare(swordKey, tok, SLOT_HOLD_MS)
  })
}

// ── IC — Insta Cart ───────────────────────────────────────────────────────────
// Place rail first, then draw and release bow (arrow airborne), then place
// cart instantly — the arrow lands on the cart and detonates it.
// Aim toward where you want the cart before triggering.
async function runIC(railKey, bowKey, cartKey, bowHoldMs, delay) {
  await startMacro('ic', async tok => {
    const d      = Math.max(0, Number(delay))
    const holdMs = Math.max(50, Number(bowHoldMs))

    // Place rail
    await press(railKey, tok)
    await sleep(timing.vary(d), tok)
    await rClick(tok)
    await sleep(timing.vary(d), tok)

    // Draw and fire bow (arrow now in flight)
    await press(bowKey, tok)
    await sleep(timing.vary(d), tok)
    if (tok.cancelled) return
    await hw.mouse.toggle('right', true)
    await sleep(holdMs, tok)
    await hw.mouse.toggle('right', false)
    await sleep(timing.vary(d), tok)  // let Minecraft register the shot

    // Place cart — arrow already airborne
    await press(cartKey, tok)
    await rClick(tok)
  })
}

// ── XB — Crossbow Cart ────────────────────────────────────────────────────────
// Place rail, place cart, light the ground with flint & steel, then fire a
// pre-loaded crossbow through the fire to detonate the cart.
// Load the crossbow before triggering this macro.
async function runXB(railKey, cartKey, fnsKey, crossbowKey, delay) {
  await startMacro('xb', async tok => {
    const d = Math.max(0, Number(delay))

    await press(railKey, tok);     await sleep(timing.vary(d), tok)
    await rClick(tok);             await sleep(timing.vary(d), tok)
    await press(cartKey, tok);     await sleep(timing.vary(d), tok)
    await rClick(tok);             await sleep(timing.vary(d), tok)
    await press(fnsKey, tok);      await sleep(timing.vary(d), tok)
    await rClick(tok);             await sleep(timing.vary(d), tok)
    await press(crossbowKey, tok); await sleep(timing.vary(d), tok)
    await rClick(tok)
  })
}

// ── DR — Drain ────────────────────────────────────────────────────────────────
// Switch to bucket and scoop up water or lava instantly.
async function runDR(bucketKey, delay) {
  await startMacro('dr', async tok => {
    const d = Math.max(0, Number(delay))
    await press(bucketKey, tok)
    await sleep(timing.vary(d), tok)
    await rClick(tok)
  })
}

// ── LW — Lava Web ─────────────────────────────────────────────────────────────
// Place lava (burns enemies), immediately pick it back up (empty bucket),
// then lay a cobweb to trap them in the fire zone.
async function runLW(lavaKey, cobwebKey, delay) {
  await startMacro('lw', async tok => {
    const d = Math.max(0, Number(delay))
    await press(lavaKey, tok)
    await sleep(timing.vary(d), tok)
    await rClick(tok)    // place lava
    await sleep(timing.vary(d), tok)
    await rClick(tok)    // pick lava back up
    await sleep(timing.vary(d), tok)
    await press(cobwebKey, tok)
    await sleep(timing.vary(d), tok)
    await rClick(tok)    // place cobweb
  })
}

// ── LA — Lava ─────────────────────────────────────────────────────────────────
// Switch to lava bucket and place instantly.
async function runLA(lavaKey, delay) {
  await startMacro('la', async tok => {
    const d = Math.max(0, Number(delay))
    await press(lavaKey, tok)
    await sleep(timing.vary(d), tok)
    await rClick(tok)
  })
}

// ── Stop everything ───────────────────────────────────────────────────────────
// Auto Crystal (hold): crystal slot -> right click -> left click, repeating.
// Optional manual-right mode: while user holds right click in crystal slot,
// macro only handles the hit timing (left click loop).
let _acActive = false
let _acToken = null

function startAC(crystalKey, delay, options = {}) {
  if (_acActive) return
  _acActive = true

  const tok = { cancelled: false, _cancel: null }
  _acToken = tok
  const slotKey = (crystalKey && crystalKey !== 'None') ? String(crystalKey) : '5'
  const d = Math.max(12, Number(delay) || 25)
  const manualGap = (2 * d) + CLICK_HOLD_MS
  const skipSlotSwitch = options?.skipSlotSwitch === true
  const manualRightHold = options?.manualRightHold === true
  const beforeRightClick = typeof options?.beforeRightClick === 'function' ? options.beforeRightClick : null
  const afterRightClick = typeof options?.afterRightClick === 'function' ? options.afterRightClick : null
  console.log('[macro:ac] started')

  ;(async () => {
    try {
      // Manual right-hold mode starts while the user is actively holding RMB in-game.
      // Avoid forcing foreground here, which can interfere with that hold.
      if (!manualRightHold) {
        focusLock.focusMc()
        await sleep(2, tok)
        if (tok.cancelled || !_acActive) return
      }

      // Switch to crystal slot once when the hold starts.
      if (!skipSlotSwitch) {
        await pressBare(slotKey, tok, SLOT_HOLD_MS)
        if (tok.cancelled || !_acActive) return
      }

      // In manual right-hold mode, give Minecraft one short window to place
      // the first crystal before we start break clicks.
      if (manualRightHold) {
        await sleep(d + CLICK_HOLD_MS, tok)
        if (tok.cancelled || !_acActive) return
      }

      while (_acActive && !tok.cancelled) {
        if (!manualRightHold) {
          // Re-lock crystal slot each iteration so slot never drifts.
          await pressBare(slotKey, tok, SLOT_HOLD_MS)
          if (tok.cancelled || !_acActive) break
          if (beforeRightClick) {
            try { await beforeRightClick() } catch (_) {}
            if (tok.cancelled || !_acActive) break
          }
          await rClickMouse2Fixed(tok)
          if (afterRightClick) {
            try { await afterRightClick() } catch (_) {}
            if (tok.cancelled || !_acActive) break
          }
          await sleep(d, tok)
          if (tok.cancelled || !_acActive) break
        }
        await lClickMouse1Fixed(tok)
        await sleep(manualRightHold ? manualGap : d, tok)
      }
    } catch (_) {
    } finally {
      if (_acToken === tok) {
        _acToken = null
        _acActive = false
      }
    }
  })()
}

function stopAC() {
  if (!_acActive && !_acToken) return
  _acActive = false
  const tok = _acToken
  _acToken = null
  if (tok) {
    tok.cancelled = true
    tok._cancel?.()
  }
  console.log('[macro:ac] stopped')
}

async function runRecordedSequence(recordId, sequence, options = {}) {
  const events = Array.isArray(sequence) ? sequence : []
  if (!events.length) return
  const cfg = (options && typeof options === 'object') ? options : { stepMs: options }
  const gap = Math.max(0, Number(cfg.stepMs) || 35)
  const repeatCount = Math.max(1, Math.min(20, Number(cfg.repeatCount) || 1))
  const startDelayMs = Math.max(0, Math.min(10000, Number(cfg.startDelayMs) || 0))
  const stepJitterMs = Math.max(0, Math.min(1000, Number(cfg.stepJitterMs) || 0))
  const macroId = `rec:${String(recordId || 'custom')}`

  await startMacro(macroId, async (tok) => {
    focusLock.focusMc()
    await sleep(2, tok)
    if (tok.cancelled) return
    if (startDelayMs > 0) await sleep(startDelayMs, tok)
    if (tok.cancelled) return

    for (let cycle = 0; cycle < repeatCount; cycle += 1) {
      if (tok.cancelled) break
      for (const evt of events) {
        if (tok.cancelled) break
        const eventStart = Date.now()
        let isPressStep = false

        if (evt?.type === 'move') {
          const dx = Math.trunc(Number(evt?.dx) || 0)
          const dy = Math.trunc(Number(evt?.dy) || 0)
          if ((dx !== 0 || dy !== 0) && !tok.cancelled) {
            try { await hw.mouse.move(dx, dy, 0) } catch (_) {}
          }
        } else if (evt?.type === 'wheel') {
          const amount = Number(evt?.amount) < 0 ? -1 : 1
          if (!tok.cancelled) {
            try { await hw.mouse.scrollWheel(amount, 0) } catch (_) {}
          }
        } else {
          isPressStep = true
          let bind = normalizeBindToken(String(evt?.code || '').trim())
          if (!bind || bind === 'None') continue

          // Keep recorder playback consistent with built-in macro click rules:
          // Mouse1/Mouse2 follow the configured left/right click binds.
          if (bind === 'Mouse1' || bind === 'Mouse2') {
            const clicks = getClickBinds()
            const mapped = bind === 'Mouse1' ? clicks.left : clicks.right
            const normMapped = normalizeBindToken(String(mapped || '').trim())
            if (normMapped) bind = normMapped
          }

          const hold = /^Mouse[1-5]$/.test(bind) ? CLICK_HOLD_MS : KEY_HOLD_MS
          await pressBare(bind, tok, hold)
        }
        if (tok.cancelled) break

        // Keep cadence fixed between press steps only.
        // Old behavior added full gap after each event, causing slow "hold + gap"
        // timing. This keeps intervals close to exactly step gap.
        if (isPressStep && gap > 0) {
          const elapsed = Date.now() - eventStart
          let targetGap = gap
          if (stepJitterMs > 0) {
            const jitter = Math.floor((Math.random() * ((stepJitterMs * 2) + 1)) - stepJitterMs)
            targetGap = Math.max(0, gap + jitter)
          }
          const waitMs = targetGap - elapsed
          if (waitMs > 0) await sleep(waitMs, tok)
        }
      }
    }
  })
}

function stopAll() {
  // Clear queued anchor runs first so the finally-block chain doesn't fire them.
  Object.keys(macroQueue).forEach(id => delete macroQueue[id])
  Object.keys(macroTokens).forEach(id => {
    const tok = macroTokens[id]
    if (tok) { tok.cancelled = true; tok._cancel?.() }
  })
  stopFXP()
  stopAC()
}

module.exports = {
  runSA, runSFA, runDA, runAP, runKP,
  runIDH, runOHT, runASB, startFXP, stopFXP, startAC, stopAC,
  runRecordedSequence,
  runES, runPC, runSS, runSW, runBS, runHC, runLS,
  runIC, runXB, runDR, runLW, runLA,
  stopAll,
  setClickBinds
}


