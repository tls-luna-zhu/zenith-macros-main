// click-binds.js — shared left/right click bindings for all macros
// Defaults to Mouse1/Mouse2 to match standard MC attack/use.

let _binds = { left: 'Mouse1', right: 'Mouse2' }

function _norm(v) {
  if (!v) return null
  const s = String(v).trim()
  return s.length ? s : null
}

function setClickBinds(next) {
  if (!next) return
  const left = _norm(next.left)
  const right = _norm(next.right)
  if (left) _binds.left = left
  if (right) _binds.right = right
}

function getClickBinds() {
  return { ..._binds }
}

function resolveMouseButton(key) {
  const map = {
    Mouse1: 'left',
    Mouse2: 'right',
    Mouse3: 'middle',
    Mouse4: 'x1',
    Mouse5: 'x2',
  }
  return map[String(key)]
}

module.exports = { setClickBinds, getClickBinds, resolveMouseButton }
