// ─────────────────────────────────────────────────────────────────────────────
//  Triggerbot — rewritten to match xexternal architecture exactly.
//
//  Toggle ON/OFF via keybind.  When ON and Minecraft is focused:
//    1. Sample 3x3 pixels at screen center
//    2. Manhattan distance < 30 from target color? → click
//    3. Wait cooldown → repeat
//
//  No state machine, no sequence tracking — dead simple like xexternal.
// ─────────────────────────────────────────────────────────────────────────────

const { Hardware } = require('../electron/keysender-safe')
const { screen } = require('electron')
const focusLock = require('../electron/focus-lock')
const { getClickBinds, resolveMouseButton } = require('./click-binds')

let _hwInstance = null
const _hw = new Proxy({}, {
  get(_target, prop) {
    if (!_hwInstance) _hwInstance = new Hardware()
    const value = _hwInstance[prop]
    return typeof value === 'function' ? value.bind(_hwInstance) : value
  }
})

// ── Config ──────────────────────────────────────────────────────────────────
const CLICK_HOLD_MS = 15
const COOLDOWN_MS = 600
const POLL_MS = 1             // xexternal uses time.sleep(0.001)
const UNFOCUSED_POLL_MS = 100 // xexternal uses time.sleep(0.1)
const CENTER_FALLBACK = { cx: 960, cy: 540 }
const TOLERANCE = 30          // xexternal Manhattan tolerance

// ── State ───────────────────────────────────────────────────────────────────
let _tbActive = false
let _tbTimer = null
let _clicking = false
let _lastClickMs = 0
let _statusCb = null
let _center = null
let _focusLocked = true

let _mode = 'normal'
let _sTapMs = 150
let _pollMs = POLL_MS

// ── Color detection — xexternal's is_exact_match ────────────────────────────
// Manhattan distance from target color.
// Red crosshair:  target (255, 0, 0)
// Blue crosshair: target (0, 0, 255)
function isRed(r, g, b) {
  return (Math.abs(r - 255) + g + b) < TOLERANCE
}

function isBlue(r, g, b) {
  return (r + g + Math.abs(b - 255)) < TOLERANCE
}

function isTargetColor(x, y) {
  try {
    const [r, g, b] = _hw.workwindow.colorAt(x, y, 'array')
    return isRed(r, g, b) || isBlue(r, g, b)
  } catch (_) {
    return false
  }
}

// ── 3x3 sampling — xexternal scans 3x3 grid, any match = click ─────────────
function shouldClick(cx, cy) {
  for (let y = -1; y <= 1; y++) {
    for (let x = -1; x <= 1; x++) {
      if (isTargetColor(cx + x, cy + y)) return true
    }
  }
  return false
}

// ── Screen center resolution ────────────────────────────────────────────────
function toPoint(x, y) {
  return { cx: Math.floor(Number(x) || 0), cy: Math.floor(Number(y) || 0) }
}

function getDisplayScreenBounds(display) {
  try {
    if (!display) return null
    const bounds = display.bounds || { x: 0, y: 0, width: display.size.width, height: display.size.height }
    const leftDip = Number(bounds.x)
    const topDip = Number(bounds.y)
    const widthDip = Number(bounds.width)
    const heightDip = Number(bounds.height)
    if (![leftDip, topDip, widthDip, heightDip].every(Number.isFinite)) return null

    const topLeft = typeof screen.dipToScreenPoint === 'function'
      ? screen.dipToScreenPoint({ x: leftDip, y: topDip })
      : { x: leftDip * (Number(display.scaleFactor) || 1), y: topDip * (Number(display.scaleFactor) || 1) }
    const bottomRight = typeof screen.dipToScreenPoint === 'function'
      ? screen.dipToScreenPoint({ x: leftDip + widthDip, y: topDip + heightDip })
      : {
          x: (leftDip + widthDip) * (Number(display.scaleFactor) || 1),
          y: (topDip + heightDip) * (Number(display.scaleFactor) || 1),
        }

    const left = Number(topLeft?.x)
    const top = Number(topLeft?.y)
    const right = Number(bottomRight?.x)
    const bottom = Number(bottomRight?.y)
    if (![left, top, right, bottom].every(Number.isFinite)) return null

    return {
      left, top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
      center: toPoint((left + right) / 2, (top + bottom) / 2),
    }
  } catch (_) {
    return null
  }
}

function getFullscreenCenterPoint(view) {
  try {
    const x = Number(view?.x)
    const y = Number(view?.y)
    const width = Number(view?.width)
    const height = Number(view?.height)
    if (![x, y, width, height].every(Number.isFinite)) return null
    if (width <= 0 || height <= 0) return null

    let dipPoint = { x: x + width / 2, y: y + height / 2 }
    if (typeof screen.screenToDipPoint === 'function') {
      const converted = screen.screenToDipPoint({ x: dipPoint.x, y: dipPoint.y })
      if (converted && Number.isFinite(converted.x) && Number.isFinite(converted.y)) {
        dipPoint = converted
      }
    }

    const display = screen.getDisplayNearestPoint(dipPoint) || screen.getPrimaryDisplay()
    const displayBounds = getDisplayScreenBounds(display)
    if (!displayBounds) return null

    const widthRatio = width / Math.max(1, displayBounds.width)
    const heightRatio = height / Math.max(1, displayBounds.height)
    if (widthRatio < 0.96 || heightRatio < 0.96) return null

    return displayBounds.center
  } catch (_) {
    return null
  }
}

function resolveCenterPoint() {
  try {
    const view = typeof focusLock.getFocusedGameView === 'function'
      ? focusLock.getFocusedGameView() : null
    if (view) {
      const fsc = getFullscreenCenterPoint(view)
      if (fsc) return fsc
      const cx = Number(view.x) + Number(view.width) / 2
      const cy = Number(view.y) + Number(view.height) / 2
      if (Number.isFinite(cx) && Number.isFinite(cy)) return toPoint(cx, cy)
    }
  } catch (_) {}

  try {
    const cursor = screen.getCursorScreenPoint()
    const d = screen.getDisplayNearestPoint(cursor) || screen.getPrimaryDisplay()
    if (d) {
      const bounds = d.bounds || { x: 0, y: 0, width: d.size.width, height: d.size.height }
      const dipX = Number(bounds.x) + Number(bounds.width) / 2
      const dipY = Number(bounds.y) + Number(bounds.height) / 2
      if (Number.isFinite(dipX) && Number.isFinite(dipY)) {
        if (typeof screen.dipToScreenPoint === 'function') {
          const p = screen.dipToScreenPoint({ x: dipX, y: dipY })
          if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return toPoint(p.x, p.y)
        }
        const sf = Number(d.scaleFactor) || 1
        return toPoint(dipX * sf, dipY * sf)
      }
    }
  } catch (_) {}

  return { ...CENTER_FALLBACK }
}

// ── Click — hardware left-click via keysender ───────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function doClick() {
  if (_clicking) return
  _clicking = true
  try {
    const { left } = getClickBinds()
    const bind = left || 'Mouse1'
    const mouseBtn = resolveMouseButton(bind)
    if (mouseBtn) {
      await _hw.mouse.toggle(mouseBtn, true)
      await sleep(CLICK_HOLD_MS)
      await _hw.mouse.toggle(mouseBtn, false)
    } else {
      await _hw.keyboard.sendKey(String(bind).toLowerCase(), CLICK_HOLD_MS, 0)
    }
    if (_mode === 's-tap') {
      await sleep(10)
      await _hw.keyboard.sendKey('s', _sTapMs, 0)
    }
  } catch (_) {
  } finally {
    _clicking = false
  }
}

// ── Main poll — mirrors xexternal's main loop body ──────────────────────────
function poll() {
  if (!_tbActive) return

  // Don't fire when tabbed out — matches xexternal's check_window_safety
  if (_focusLocked && !focusLock.isMcFocused()) {
    _tbTimer = setTimeout(poll, UNFOCUSED_POLL_MS)
    return
  }

  if (_clicking) {
    _tbTimer = setTimeout(poll, POLL_MS)
    return
  }

  // Refresh center point
  _center = resolveCenterPoint()
  if (!_center) {
    _tbTimer = setTimeout(poll, POLL_MS)
    return
  }

  // Check cooldown
  const now = Date.now()
  if (now - _lastClickMs < COOLDOWN_MS) {
    _tbTimer = setTimeout(poll, POLL_MS)
    return
  }

  // Sample 3x3 — if any pixel matches, click
  if (shouldClick(_center.cx, _center.cy)) {
    doClick()
    _lastClickMs = Date.now()
  }

  if (_tbActive) {
    _tbTimer = setTimeout(poll, POLL_MS)
  }
}

// ── Public API ──────────────────────────────────────────────────────────────
function setTBConfig(cfg) {
  if (!cfg) return
  if (cfg.tbMode) {
    _mode = ['normal', 's-tap'].includes(cfg.tbMode) ? cfg.tbMode : 'normal'
  }
  if (cfg.sTapMs != null) _sTapMs = Math.max(10, Number(cfg.sTapMs) || 150)
}

function setStatusCallback(fn) { _statusCb = fn }
function setFocusLocked(val) { _focusLocked = val }
function isTBActive() { return _tbActive }

function startTB(cfg) {
  if (_tbActive) return
  _mode = 'normal'
  _sTapMs = 150
  setTBConfig(cfg || {})
  _center = null
  _tbActive = true
  _clicking = false
  _lastClickMs = 0
  _tbTimer = setTimeout(poll, POLL_MS)
  console.log('[triggerbot] ON — mode=%s', _mode)
  _statusCb?.(true)
}

function stopTB() {
  if (!_tbActive) return
  _tbActive = false
  clearTimeout(_tbTimer)
  _tbTimer = null
  _clicking = false
  console.log('[triggerbot] OFF')
  _statusCb?.(false)
}

function toggleTB(cfg) {
  if (_tbActive) stopTB()
  else startTB(cfg)
}

module.exports = { toggleTB, stopTB, setTBConfig, setStatusCallback, isTBActive, setFocusLocked }
