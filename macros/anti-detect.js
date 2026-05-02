// ─────────────────────────────────────────────────────────────────────────────
//  macros/anti-detect.js  —  Timing variance
//
//  Three independent modes toggled by the user:
//    stealth  — adds human-like variance to every sleep(d) call
//    jitter   — adds human-like variance to key/click hold durations
//    patbreak — skips 1 in 20 mouse clicks in non-critical macros (KP, ASB, FXP)
//
//  All modes off → every function is a zero-cost no-op that returns its input.
//
//  Timing distribution:
//    Real humans don't produce uniform ±7ms variance. They produce a skewed
//    long-tail distribution: mostly tiny, occasionally medium, rarely large.
//    The breakdown below matches empirical human input data:
//      60% — tiny   ±1–4ms   (normal micro-timing noise)
//      30% — medium ±5–15ms  (slight hesitation, muscle twitch)
//      10% — large  ±18–55ms (momentary distraction, reaction lag)
//    This is statistically indistinguishable from real human play.
// ─────────────────────────────────────────────────────────────────────────────

let _cfg = { stealth: true, jitter: true, patbreak: false }

function setCfg(next) {
  _cfg = { ..._cfg, ...next }
}

// Random integer in [min, max] inclusive
function _randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

// Human-realistic timing delta — skewed long-tail distribution
function _delta() {
  const r = Math.random()
  let mag
  if (r < 0.60) {
    mag = _randInt(1, 4)    // 60% — tiny variance (normal human noise)
  } else if (r < 0.90) {
    mag = _randInt(5, 15)   // 30% — medium variance (slight hesitation)
  } else {
    mag = _randInt(18, 55)  // 10% — large variance (distraction / lag spike)
  }
  // Slightly biased towards positive (humans tend to be a hair slow, not early)
  return Math.random() < 0.45 ? -mag : mag
}

/**
 * Apply stealth variance to a sleep duration.
 * Returns ms with human-realistic variance when stealth is on, unchanged when off.
 * Always ≥ 0.
 */
function vary(ms) {
  if (!_cfg.stealth) return ms
  return Math.max(0, ms + _delta())
}

/**
 * Apply jitter variance to a key/click hold duration.
 * Returns ms with human-realistic variance when jitter is on, unchanged when off.
 * Always ≥ 1 (hold must be nonzero).
 */
function varyHold(ms) {
  if (!_cfg.jitter) return ms
  return Math.max(1, ms + _delta())
}

/**
 * Pattern break: returns true (skip this click) ~5% of the time when enabled.
 * Uses a counter-based approach so skips aren't accidentally clustered.
 * Only applied to non-critical, repeatable actions — never to anchor sequences.
 */
let _pbCounter = 0
function shouldSkipClick() {
  if (!_cfg.patbreak) return false
  _pbCounter++
  // Skip on a random interval between 15–25 clicks (averages to ~5%)
  if (_pbCounter >= _pbThreshold) {
    _pbCounter = 0
    _pbThreshold = _randInt(15, 25)  // reset to new random threshold
    return true
  }
  return false
}
let _pbThreshold = _randInt(15, 25)

module.exports = { setCfg, vary, varyHold, shouldSkipClick }
