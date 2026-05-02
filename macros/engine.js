const { globalShortcut } = require('electron')
const { LowLevelHook, isButtonPressed } = require('../electron/keysender-safe')
const {
  runSA, runSFA, runDA, runAP, runKP,
  runIDH, runOHT, runASB, startFXP, stopFXP, startAC, stopAC, runRecordedSequence,
  runES, runPC, runSS, runSW, runBS, runHC, runLS,
  runIC, runXB, runDR, runLW, runLA,
  stopAll: stopInputMacros
} = require('./input')
const { toggleTB, stopTB, setFocusLocked: tbSetFocusLocked } = require('./triggerbot')
const { toKeysenderKey, toAccelerator, hasModifier: bindHasModifier, normalizeBindString } = require('../electron/keymap')

let macroConfig = {}
let focusLocked = true   // default on; updated by setFocusLock()
let mcHasFocus  = false
let chatPaused  = false
let runtimeGuard = () => true

// Mouse button keybinds → LowLevelHook 'mouse' event names
const MOUSE_BUTTONS = new Set(['Mouse1', 'Mouse2', 'Mouse3', 'Mouse4', 'Mouse5'])
const MOUSE_BTN_MAP = {
  Mouse1: 'left',
  Mouse2: 'right',
  Mouse3: 'middle',
  Mouse4: 'x1',
  Mouse5: 'x2'
}
// key -> { type: 'global'|'lowlevel'|'mouse', unlisten?: fn }
const registeredMacroKeys = new Map()

function stopAll() {
  stopInputMacros()
  stopTB()
}

function setConfig(config) {
  macroConfig = config
}

function setRuntimeGuard(fn) {
  runtimeGuard = typeof fn === 'function' ? fn : (() => true)
}

function setFocusLock(val) {
  focusLocked = val
  tbSetFocusLocked(val)
  if (!focusLocked) {
    // Lock turned off — register macros unconditionally (ignore MC focus)
    if (!chatPaused) registerAll()
  } else {
    // Lock turned on — respect current MC focus state
    if (mcHasFocus && !chatPaused) {
      registerAll()
    } else {
      unregisterMacros()
      stopAll()
    }
  }
}

function setMcFocus(val) {
  mcHasFocus = val
  if (!focusLocked) return  // lock off — focus changes don't affect macro registration
  if (val && !chatPaused) {
    registerAll()
  } else {
    unregisterMacros()
    stopAll()
  }
}

function setChatPaused(val) {
  chatPaused = val
  if (val) {
    unregisterMacros()
    stopAll()
  } else if (!focusLocked || mcHasFocus) {
    registerAll()
  }
}

function unregisterMacros() {
  registeredMacroKeys.forEach((info, key) => {
    try {
      if (info.type === 'global') {
        globalShortcut.unregister(key)
      } else if (typeof info.unlisten === 'function') {
        info.unlisten()
      }
    } catch (_) {}
  })
  registeredMacroKeys.clear()
  stopFXP()
  stopAC()
}

function registerAll() {
  unregisterMacros()
  if (!runtimeGuard()) return
  if (focusLocked && !mcHasFocus) return

  const entries = Object.entries(macroConfig).filter(([id]) => id !== 'customMacros')
  const customMacros = Array.isArray(macroConfig.customMacros) ? macroConfig.customMacros : []
  customMacros.forEach((cfg, idx) => entries.push([`rec:${idx}`, cfg]))

  const resolveCfg = (id, fallback) => {
    if (id.startsWith('rec:')) {
      const idx = Number(id.slice(4))
      if (Number.isFinite(idx) && idx >= 0) {
        const live = Array.isArray(macroConfig.customMacros) ? macroConfig.customMacros[idx] : null
        if (live && typeof live === 'object') return live
      }
      return fallback
    }
    return macroConfig[id] || fallback
  }

  entries.forEach(([id, cfg]) => {
    if (!cfg?.active) return

    if (!cfg.keybind || cfg.keybind === 'None') return
    const keybind = normalizeBindString(cfg.keybind)
    if (!keybind || keybind === 'None') return

    // Skip duplicate keybinds — if another active macro already claimed this
    // key, don't register a second hook (the first macro wins).
    // Without this guard, both hooks fire when the key is pressed AND the
    // Map only stores the last registration, so the first hook leaks and
    // can never be unlistened — causing ghost macros even after disabling.
    if (registeredMacroKeys.has(keybind)) return

    // FXP: hold-to-run (press starts, release stops)
    if (id === 'fxp') {
      registerFXP(keybind, cfg)
      return
    }
    // AC: hold-to-run (press starts, release stops)
    if (id === 'ac') {
      registerAC(keybind, cfg)
      return
    }

    const normalized  = normalizeBindString(keybind)
    const base        = normalized.split('+').pop()
    const isMouse     = MOUSE_BUTTONS.has(base)
    const isCombo = normalized.includes('+')
    const hasModifier = !isMouse && isCombo && (
      bindHasModifier(normalized, 'Ctrl') ||
      bindHasModifier(normalized, 'Alt') ||
      bindHasModifier(normalized, 'Shift') ||
      bindHasModifier(normalized, 'Meta')
    )

    try {
      if (isMouse) {
        // ── Side / middle mouse button ──────────────────────────────────────
        const mouseBtn = MOUSE_BTN_MAP[base]
        if (!mouseBtn) return
        const unlisten = LowLevelHook.on('mouse', mouseBtn, true, () => {
          triggerMacro(id, resolveCfg(id, cfg))
        })
        registeredMacroKeys.set(keybind, { type: 'mouse', unlisten })
        console.log(`[engine] Registered [${id}] mouse: ${mouseBtn}`)

      } else if (hasModifier) {
        // ── Modifier combo (Shift+X, Ctrl+X) — globalShortcut handles these ─
        // globalShortcut correctly fires ONLY when the exact combo is pressed.
        const normalizedKey = normalizeShortcut(keybind)
        const ok = globalShortcut.register(normalizedKey, () => {
          triggerMacro(id, resolveCfg(id, cfg))
        })
        if (ok) registeredMacroKeys.set(keybind, { type: 'global' })
        console.log(`[engine] Registered [${id}] global: ${normalizedKey}`)

      } else {
        // ── Simple key — use LowLevelHook so it fires even when Shift/Ctrl ──
        // are physically held (sprinting with Ctrl, crouching with Shift, etc.)
        // globalShortcut('R') silently fails when any extra modifier is held.
        const ksKey = convertToKeySenderKey(keybind)
        if (!ksKey) return
        const unlisten = LowLevelHook.on('keyboard', ksKey, true, () => {
          triggerMacro(id, resolveCfg(id, cfg))
        })
        registeredMacroKeys.set(keybind, { type: 'lowlevel', unlisten })
        console.log(`[engine] Registered [${id}] lowlevel: ${ksKey}`)
      }
    } catch (e) {
      console.log(`[engine] Could not register [${id}]: ${keybind}`, e.message)
    }
  })
}

function _modsDown(keybind) {
  if (!keybind) return true
  const normalized = normalizeBindString(keybind)
  const need = []
  if (bindHasModifier(normalized, 'Ctrl'))  need.push('ctrl')
  if (bindHasModifier(normalized, 'Alt'))   need.push('alt')
  if (bindHasModifier(normalized, 'Shift')) need.push('shift')
  if (bindHasModifier(normalized, 'Meta'))  need.push('meta')
  if (!need.length) return true
  try {
    return need.every((m) => {
      if (m !== 'meta') return isButtonPressed('keyboard', m)
      return isButtonPressed('keyboard', 'meta')
        || isButtonPressed('keyboard', 'lWin')
        || isButtonPressed('keyboard', 'rWin')
    })
  } catch (_) {
    return false
  }
}

function registerFXP(keybind, cfg) {
  const base = normalizeBindString(keybind).split('+').pop()
  const isMouse = MOUSE_BUTTONS.has(base)

  try {
    if (isMouse) {
      const mouseBtn = MOUSE_BTN_MAP[base]
      if (!mouseBtn) return
      const unlistenDown = LowLevelHook.on('mouse', mouseBtn, true, () => {
        if ((focusLocked && !mcHasFocus) || chatPaused) return
        if (!_modsDown(keybind)) return
        startFXP(cfg.delay || '35')
      })
      const unlistenUp = LowLevelHook.on('mouse', mouseBtn, false, () => {
        stopFXP()
      })
      registeredMacroKeys.set(keybind, { type: 'mouse', unlisten: () => { unlistenDown(); unlistenUp() } })
      console.log(`[engine] Registered [fxp] hold mouse: ${mouseBtn}`)
      return
    }

    const ksKey = convertToKeySenderKey(keybind)
    if (!ksKey) return
    const unlistenDown = LowLevelHook.on('keyboard', ksKey, true, () => {
      if ((focusLocked && !mcHasFocus) || chatPaused) return
      if (!_modsDown(keybind)) return
      startFXP(cfg.delay || '35')
    })
    const unlistenUp = LowLevelHook.on('keyboard', ksKey, false, () => {
      stopFXP()
    })
    registeredMacroKeys.set(keybind, { type: 'lowlevel', unlisten: () => { unlistenDown(); unlistenUp() } })
    console.log(`[engine] Registered [fxp] hold key: ${ksKey}`)
  } catch (e) {
    console.log(`[engine] Could not register [fxp]: ${keybind}`, e.message)
  }
}

function registerAC(keybind, cfg) {
  const base = normalizeBindString(keybind).split('+').pop()
  const isMouse = MOUSE_BUTTONS.has(base)

  try {
    if (isMouse) {
      const mouseBtn = MOUSE_BTN_MAP[base]
      if (!mouseBtn) return
      const unlistenDown = LowLevelHook.on('mouse', mouseBtn, true, () => {
        if ((focusLocked && !mcHasFocus) || chatPaused) return
        if (!_modsDown(keybind)) return
        startAC(cfg.crystalKey || '5', cfg.delay || '25')
      })
      const unlistenUp = LowLevelHook.on('mouse', mouseBtn, false, () => {
        stopAC()
      })
      registeredMacroKeys.set(keybind, { type: 'mouse', unlisten: () => { unlistenDown(); unlistenUp() } })
      console.log(`[engine] Registered [ac] hold mouse: ${mouseBtn}`)
      return
    }

    const ksKey = convertToKeySenderKey(keybind)
    if (!ksKey) return
    const unlistenDown = LowLevelHook.on('keyboard', ksKey, true, () => {
      if ((focusLocked && !mcHasFocus) || chatPaused) return
      if (!_modsDown(keybind)) return
      startAC(cfg.crystalKey || '5', cfg.delay || '25')
    })
    const unlistenUp = LowLevelHook.on('keyboard', ksKey, false, () => {
      stopAC()
    })
    registeredMacroKeys.set(keybind, { type: 'lowlevel', unlisten: () => { unlistenDown(); unlistenUp() } })
    console.log(`[engine] Registered [ac] hold key: ${ksKey}`)
  } catch (e) {
    console.log(`[engine] Could not register [ac]: ${keybind}`, e.message)
  }
}

// Convert keybind to keysender format for LowLevelHook
function convertToKeySenderKey(keybind) {
  return toKeysenderKey(keybind)
}

function triggerMacro(id, cfg) {
  if (!runtimeGuard()) {
    console.log(`[engine] Blocked [${id}] - runtime lease invalid`)
    stopAll()
    return
  }

  if (focusLocked && !mcHasFocus) {
    console.log(`[engine] Blocked [${id}] — Minecraft not focused`)
    return
  }

  if (chatPaused) {
    console.log(`[engine] Blocked [${id}] — chat is open`)
    return
  }

  // ── Key-guard: ONLY needed for KP ─────────────────────────────────────────
  // KP presses its pearlKey which may equal the keybind — unregister the
  // hook while running to prevent a re-trigger loop.
  // ──────────────────────────────────────────────────────────────────────────
  const needsGuard = (id === 'kp')
  const keybind    = needsGuard ? cfg.keybind : null

  if (keybind) {
    const entry = registeredMacroKeys.get(keybind)
    if (entry) {
      if (entry.type === 'global') {
        try { globalShortcut.unregister(keybind) } catch (_) {}
      } else if ((entry.type === 'lowlevel' || entry.type === 'mouse') && entry.unlisten) {
        // Defer hook.delete() — calling it synchronously from within the hook
        // callback causes a native WH_MOUSE_LL / WH_KEYBOARD_LL crash.
        const fn = entry.unlisten
        setImmediate(() => { try { fn() } catch (_) {} })
      }
      registeredMacroKeys.delete(keybind)
    }
  }

  function reregister() {
    if (!keybind) return
    if (focusLocked && !mcHasFocus) return

    const normalized  = normalizeBindString(keybind)
    const base        = normalized.split('+').pop()
    const isMouse     = MOUSE_BUTTONS.has(base)
    const isCombo = normalized.includes('+')
    const hasModifier = !isMouse && isCombo && (
      bindHasModifier(normalized, 'Ctrl') ||
      bindHasModifier(normalized, 'Alt') ||
      bindHasModifier(normalized, 'Shift') ||
      bindHasModifier(normalized, 'Meta')
    )

    try {
      if (isMouse) {
        const mouseBtn = MOUSE_BTN_MAP[base]
        if (!mouseBtn) return
        const unlisten = LowLevelHook.on('mouse', mouseBtn, true, () => {
          triggerMacro(id, macroConfig[id] || cfg)
        })
        registeredMacroKeys.set(keybind, { type: 'mouse', unlisten })
      } else if (hasModifier) {
        const normalizedKey = normalizeShortcut(keybind)
        const ok = globalShortcut.register(normalizedKey, () => {
          triggerMacro(id, macroConfig[id] || cfg)
        })
        if (ok) registeredMacroKeys.set(keybind, { type: 'global' })
      } else {
        const ksKey = convertToKeySenderKey(keybind)
        if (!ksKey) return
        const unlisten = LowLevelHook.on('keyboard', ksKey, true, () => {
          triggerMacro(id, macroConfig[id] || cfg)
        })
        registeredMacroKeys.set(keybind, { type: 'lowlevel', unlisten })
      }
    } catch (_) {}
  }

  if (id.startsWith('rec:')) {
    runRecordedSequence(id, cfg.sequence || [], {
      stepMs: cfg.stepMs || cfg.delay || '35',
      repeatCount: cfg.repeatCount || 1,
      startDelayMs: cfg.startDelayMs || 0,
      stepJitterMs: cfg.stepJitterMs || 0,
    })
    return
  }

  switch (id) {

    // ── Placement ── no key-guard needed, fire-and-forget with cancel token
    case 'sa':
      {
        const detKey = (cfg.totemKey && cfg.totemKey !== 'None')
          ? cfg.totemKey
          : ((cfg.explodeKey && cfg.explodeKey !== 'None') ? cfg.explodeKey : '9')
      runSA(
        cfg.anchorKey    || '4',
        cfg.glowstoneKey || '5',
        detKey,
        cfg.delay        || '27',
        cfg.actions
      )
      }
      break

    case 'sfa':
      {
        const detKey = (cfg.totemKey && cfg.totemKey !== 'None')
          ? cfg.totemKey
          : ((cfg.explodeKey && cfg.explodeKey !== 'None') ? cfg.explodeKey : '9')
      runSFA(
        cfg.anchorKey    || '4',
        cfg.glowstoneKey || '5',
          detKey,
        cfg.delay        || '35',
        cfg.sneakKey     || 'Shift'
      )
      }
      break

    case 'da':
      {
        const detKey = (cfg.totemKey && cfg.totemKey !== 'None')
          ? cfg.totemKey
          : ((cfg.explodeKey && cfg.explodeKey !== 'None') ? cfg.explodeKey : '9')
      runDA(
        cfg.anchorKey    || '4',
        cfg.glowstoneKey || '5',
          detKey,
        cfg.delay        || '26'
      )
      }
      break

    case 'ap':
      {
        const totemKey = (cfg.totemKey && cfg.totemKey !== 'None')
          ? cfg.totemKey
          : ((cfg.explodeKey && cfg.explodeKey !== 'None') ? cfg.explodeKey : '9')
      runAP(
        cfg.anchorKey    || '4',
        cfg.glowstoneKey || '5',
        cfg.pearlKey     || '6',
          totemKey,
        cfg.delay        || '25'
      )
      }
      break

    case 'hc':
      runHC(
        cfg.obsidianKey || '4',
        cfg.crystalKey  || '5',
        cfg.delay       || '1'
      )
      break

    // ── KP / IDH — press own keybind, must guard ──────────────────────────
    case 'kp':
      runKP(
        cfg.pearlKey  || '6',
        cfg.returnKey || '1',
        cfg.delay     || '30'
      ).finally(reregister)
      break

    case 'idh':
      stopAll()
      runIDH(
        cfg.totemKey || '9',
        cfg.swapKey  || 'f',
        cfg.delay    || '25'
      )
      break

    // ── Triggerbot — toggle polling loop ──────────────────────────────────
    case 'tb':
      toggleTB(cfg)
      break

    // ── Rest — no key-guard ────────────────────────────────────────────────
    case 'oht':
      runOHT(
        cfg.totemKey || '9',
        cfg.swapKey  || 'f',
        cfg.delay    || '35'
      )
      break

    case 'asb':
      runASB(
        cfg.axeKey    || '2',
        cfg.swordKey  || '1',
        cfg.doubleClickMs || '2'
      )
      break

    case 'ls':
      runLS(
        cfg.swordKey || '1',
        cfg.spearKey || '3'
      )
      break

    // ── Mace macros ────────────────────────────────────────────────────────
    case 'es':
      runES(
        cfg.elytraKey || '5',
        cfg.returnKey || '1',
        cfg.delay     || '50'
      )
      break

    case 'pc':
      runPC(
        cfg.pearlKey      || '6',
        cfg.windChargeKey || '7',
        cfg.delay         || '50'
      )
      break

    case 'ss':
      runSS(
        cfg.axeKey  || '2',
        cfg.maceKey || '3',
        cfg.delay   || '10'
      )
      break

    case 'sw':
      runSW(
        cfg.axeKey    || '2',
        cfg.cobwebKey || '9',
        cfg.delay     || '90',
        cfg.doubleClickMs || '2'
      )
      break

    case 'bs':
      runBS(
        cfg.maceKey  || '3',
        cfg.swordKey || '1',
        cfg.delay    || '25'
      )
      break

    // ── Cart macros ────────────────────────────────────────────────────────
    case 'ic':
      runIC(
        cfg.railKey   || '5',
        cfg.bowKey    || '4',
        cfg.cartKey   || '6',
        cfg.bowHoldMs || '150',
        cfg.delay     || '50'
      )
      break

    case 'xb':
      runXB(
        cfg.railKey      || '5',
        cfg.cartKey      || '6',
        cfg.fnsKey       || '7',
        cfg.crossbowKey  || '4',
        cfg.delay        || '50'
      )
      break

    // ── UHC macros ─────────────────────────────────────────────────────────
    case 'dr':
      runDR(
        cfg.bucketKey || '7',
        cfg.delay     || '30'
      )
      break

    case 'lw':
      runLW(
        cfg.lavaKey   || '8',
        cfg.cobwebKey || '9',
        cfg.delay     || '30'
      )
      break

    case 'la':
      runLA(
        cfg.lavaKey || '8',
        cfg.delay   || '30'
      )
      break
  }
}

function getBaseKey(keybind) {
  if (!keybind || keybind === 'None') return null
  const normalized = normalizeBindString(keybind)
  if (!normalized || normalized === 'None') return null
  return normalized.split('+').pop()
}

function normalizeShortcut(key) {
  return toAccelerator(key)
}

module.exports = { setConfig, setFocusLock, setMcFocus, setChatPaused, setRuntimeGuard, registerAll, stopAll }
