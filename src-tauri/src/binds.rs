use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;

#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
  VK_ADD, VK_BACK, VK_CAPITAL, VK_CONTROL, VK_DECIMAL, VK_DELETE, VK_DIVIDE, VK_DOWN, VK_END, VK_ESCAPE,
  VK_F1, VK_F10, VK_F11, VK_F12, VK_F13, VK_F14, VK_F15, VK_F16, VK_F17, VK_F18, VK_F19, VK_F2, VK_F20, VK_F21,
  VK_F22, VK_F23, VK_F24, VK_F3, VK_F4, VK_F5, VK_F6, VK_F7, VK_F8, VK_F9, VK_HOME, VK_INSERT, VK_LCONTROL,
  VK_LEFT, VK_LMENU, VK_LSHIFT, VK_LWIN, VK_MENU, VK_MULTIPLY, VK_NEXT, VK_NUMLOCK, VK_NUMPAD0, VK_NUMPAD1,
  VK_NUMPAD2, VK_NUMPAD3, VK_NUMPAD4, VK_NUMPAD5, VK_NUMPAD6, VK_NUMPAD7, VK_NUMPAD8, VK_NUMPAD9, VK_OEM_1,
  VK_OEM_2, VK_OEM_3, VK_OEM_4, VK_OEM_5, VK_OEM_6, VK_OEM_7, VK_OEM_COMMA, VK_OEM_MINUS, VK_OEM_PERIOD,
  VK_OEM_PLUS, VK_PAUSE, VK_PRIOR, VK_RCONTROL, VK_RETURN, VK_RIGHT, VK_RMENU, VK_RSHIFT, VK_RWIN, VK_SCROLL,
  VK_SEPARATOR, VK_SHIFT, VK_SNAPSHOT, VK_SPACE, VK_SUBTRACT, VK_TAB, VK_UP,
};

#[cfg(target_os = "windows")]
const fn vk(code: u16) -> u32 {
  code as u32
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModifierPayload {
  pub ctrl: bool,
  pub alt: bool,
  pub shift: bool,
  pub meta: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ModifierMask {
  pub ctrl: bool,
  pub alt: bool,
  pub shift: bool,
  pub meta: bool,
}

#[derive(Clone, Debug)]
pub struct MacroBinding {
  pub id: String,
  pub keybind: String,
  pub base_vks: Vec<u32>,
  pub modifiers: ModifierMask,
  pub is_hold: bool,
}

#[derive(Clone, Debug)]
pub struct MacroTriggerMatch {
  pub id: String,
  pub keybind: String,
  pub action: &'static str,
}

const STANDARD_MACRO_ORDER: &[&str] = &[
  "sa", "sfa", "da", "ap", "hc", "ac", "kp", "idh", "oht", "fxp", "asb", "ls", "tb", "es", "pc", "ss", "ass", "sw",
  "bs", "ic", "xb", "dr", "lw", "la",
];

// KBD is a special dual-keybind macro — handled separately below
fn compile_kbd_bindings(config: &Value, claimed: &mut std::collections::HashSet<String>) -> Vec<MacroBinding> {
  let mut out = Vec::new();
  let kbd = match config.get("kbd") {
    Some(v) => v,
    None => return out,
  };
  if !kbd.get("active").and_then(Value::as_bool).unwrap_or(false) {
    return out;
  }
  for (field, id) in [("leftKey", "kbd_l"), ("rightKey", "kbd_r")] {
    if let Some(key) = kbd.get(field).and_then(Value::as_str) {
      if let Some(binding) = parse_keybind(id, key) {
        if claimed.insert(binding.keybind.clone()) {
          out.push(binding);
        }
      }
    }
  }
  out
}

fn is_hold_macro(id: &str) -> bool {
  matches!(id, "fxp" | "ac" | "hc")
}

fn parse_modifier(token: &str) -> Option<ModifierMask> {
  match token {
    "Ctrl" => Some(ModifierMask {
      ctrl: true,
      ..ModifierMask::default()
    }),
    "Alt" => Some(ModifierMask {
      alt: true,
      ..ModifierMask::default()
    }),
    "Shift" => Some(ModifierMask {
      shift: true,
      ..ModifierMask::default()
    }),
    "Meta" => Some(ModifierMask {
      meta: true,
      ..ModifierMask::default()
    }),
    _ => None,
  }
}

#[cfg(target_os = "windows")]
pub fn code_to_vks(code: &str) -> Option<Vec<u32>> {
  let value = match code {
    "Backspace" => vec![vk(VK_BACK)],
    "Tab" => vec![vk(VK_TAB)],
    "Return" => vec![vk(VK_RETURN)],
    "Ctrl" => vec![vk(VK_CONTROL), vk(VK_LCONTROL), vk(VK_RCONTROL)],
    "Alt" => vec![vk(VK_MENU), vk(VK_LMENU), vk(VK_RMENU)],
    "Pause" => vec![vk(VK_PAUSE)],
    "CapsLock" => vec![vk(VK_CAPITAL)],
    "Escape" => vec![vk(VK_ESCAPE)],
    "Space" => vec![vk(VK_SPACE)],
    "PageUp" => vec![vk(VK_PRIOR)],
    "PageDown" => vec![vk(VK_NEXT)],
    "End" => vec![vk(VK_END)],
    "Home" => vec![vk(VK_HOME)],
    "Left" => vec![vk(VK_LEFT)],
    "Up" => vec![vk(VK_UP)],
    "Right" => vec![vk(VK_RIGHT)],
    "Down" => vec![vk(VK_DOWN)],
    "PrintScreen" => vec![vk(VK_SNAPSHOT)],
    "Insert" => vec![vk(VK_INSERT)],
    "Delete" => vec![vk(VK_DELETE)],
    "Meta" => vec![vk(VK_LWIN), vk(VK_RWIN)],
    "NumLock" => vec![vk(VK_NUMLOCK)],
    "ScrollLock" => vec![vk(VK_SCROLL)],
    "Shift" => vec![vk(VK_SHIFT), vk(VK_LSHIFT), vk(VK_RSHIFT)],
    "LShift" => vec![vk(VK_LSHIFT)],
    "RShift" => vec![vk(VK_RSHIFT)],
    "LCtrl" => vec![vk(VK_LCONTROL)],
    "RCtrl" => vec![vk(VK_RCONTROL)],
    "LAlt" => vec![vk(VK_LMENU)],
    "RAlt" => vec![vk(VK_RMENU)],
    "LWin" => vec![vk(VK_LWIN)],
    "RWin" => vec![vk(VK_RWIN)],
    ";" => vec![vk(VK_OEM_1)],
    "=" => vec![vk(VK_OEM_PLUS)],
    "," => vec![vk(VK_OEM_COMMA)],
    "-" => vec![vk(VK_OEM_MINUS)],
    "." => vec![vk(VK_OEM_PERIOD)],
    "/" => vec![vk(VK_OEM_2)],
    "`" => vec![vk(VK_OEM_3)],
    "[" => vec![vk(VK_OEM_4)],
    "\\" => vec![vk(VK_OEM_5)],
    "]" => vec![vk(VK_OEM_6)],
    "'" => vec![vk(VK_OEM_7)],
    "Num*" => vec![vk(VK_MULTIPLY)],
    "Num+" => vec![vk(VK_ADD)],
    "Num," => vec![vk(VK_SEPARATOR)],
    "Num-" => vec![vk(VK_SUBTRACT)],
    "Num." => vec![vk(VK_DECIMAL)],
    "Num/" => vec![vk(VK_DIVIDE)],
    _ => {
      // Single character must be handled BEFORE the F-key prefix check,
      // otherwise "F" (the letter) gets caught by strip_prefix('F') leaving ""
      // which fails to parse as a number → returns None → key silently ignored.
      if code.len() == 1 {
        let ch = code.chars().next()?;
        if ch.is_ascii_alphabetic() {
          return Some(vec![ch.to_ascii_uppercase() as u32]);
        } else if ch.is_ascii_digit() {
          return Some(vec![ch as u32]);
        } else {
          return None;
        }
      }
      if let Some(rest) = code.strip_prefix('F') {
        let parsed = rest.parse::<u32>().ok()?;
        let vk = match parsed {
          1 => vk(VK_F1),
          2 => vk(VK_F2),
          3 => vk(VK_F3),
          4 => vk(VK_F4),
          5 => vk(VK_F5),
          6 => vk(VK_F6),
          7 => vk(VK_F7),
          8 => vk(VK_F8),
          9 => vk(VK_F9),
          10 => vk(VK_F10),
          11 => vk(VK_F11),
          12 => vk(VK_F12),
          13 => vk(VK_F13),
          14 => vk(VK_F14),
          15 => vk(VK_F15),
          16 => vk(VK_F16),
          17 => vk(VK_F17),
          18 => vk(VK_F18),
          19 => vk(VK_F19),
          20 => vk(VK_F20),
          21 => vk(VK_F21),
          22 => vk(VK_F22),
          23 => vk(VK_F23),
          24 => vk(VK_F24),
          _ => return None,
        };
        vec![vk]
      } else if let Some(rest) = code.strip_prefix("Num") {
        let parsed = rest.parse::<u32>().ok()?;
        let vk = match parsed {
          0 => vk(VK_NUMPAD0),
          1 => vk(VK_NUMPAD1),
          2 => vk(VK_NUMPAD2),
          3 => vk(VK_NUMPAD3),
          4 => vk(VK_NUMPAD4),
          5 => vk(VK_NUMPAD5),
          6 => vk(VK_NUMPAD6),
          7 => vk(VK_NUMPAD7),
          8 => vk(VK_NUMPAD8),
          9 => vk(VK_NUMPAD9),
          _ => return None,
        };
        vec![vk]
      } else {
        return None;
      }
    }
  };

  Some(value)
}

#[cfg(not(target_os = "windows"))]
pub fn code_to_vks(_code: &str) -> Option<Vec<u32>> {
  None
}

#[cfg(target_os = "windows")]
pub fn vk_to_code(vk_code: u32) -> Option<String> {
  let code = match vk_code {
    value if value == vk(VK_BACK) => "Backspace".to_string(),
    value if value == vk(VK_TAB) => "Tab".to_string(),
    value if value == vk(VK_RETURN) => "Return".to_string(),
    value if value == vk(VK_CONTROL) => "Ctrl".to_string(),
    value if value == vk(VK_LCONTROL) => "LCtrl".to_string(),
    value if value == vk(VK_RCONTROL) => "RCtrl".to_string(),
    value if value == vk(VK_MENU) => "Alt".to_string(),
    value if value == vk(VK_LMENU) => "LAlt".to_string(),
    value if value == vk(VK_RMENU) => "RAlt".to_string(),
    value if value == vk(VK_SHIFT) => "Shift".to_string(),
    value if value == vk(VK_LSHIFT) => "LShift".to_string(),
    value if value == vk(VK_RSHIFT) => "RShift".to_string(),
    value if value == vk(VK_PAUSE) => "Pause".to_string(),
    value if value == vk(VK_CAPITAL) => "CapsLock".to_string(),
    value if value == vk(VK_ESCAPE) => "Escape".to_string(),
    value if value == vk(VK_SPACE) => "Space".to_string(),
    value if value == vk(VK_PRIOR) => "PageUp".to_string(),
    value if value == vk(VK_NEXT) => "PageDown".to_string(),
    value if value == vk(VK_END) => "End".to_string(),
    value if value == vk(VK_HOME) => "Home".to_string(),
    value if value == vk(VK_LEFT) => "Left".to_string(),
    value if value == vk(VK_UP) => "Up".to_string(),
    value if value == vk(VK_RIGHT) => "Right".to_string(),
    value if value == vk(VK_DOWN) => "Down".to_string(),
    value if value == vk(VK_SNAPSHOT) => "PrintScreen".to_string(),
    value if value == vk(VK_INSERT) => "Insert".to_string(),
    value if value == vk(VK_DELETE) => "Delete".to_string(),
    value if value == vk(VK_LWIN) => "LWin".to_string(),
    value if value == vk(VK_RWIN) => "RWin".to_string(),
    value if value == vk(VK_NUMPAD0) => "Num0".to_string(),
    value if value == vk(VK_NUMPAD1) => "Num1".to_string(),
    value if value == vk(VK_NUMPAD2) => "Num2".to_string(),
    value if value == vk(VK_NUMPAD3) => "Num3".to_string(),
    value if value == vk(VK_NUMPAD4) => "Num4".to_string(),
    value if value == vk(VK_NUMPAD5) => "Num5".to_string(),
    value if value == vk(VK_NUMPAD6) => "Num6".to_string(),
    value if value == vk(VK_NUMPAD7) => "Num7".to_string(),
    value if value == vk(VK_NUMPAD8) => "Num8".to_string(),
    value if value == vk(VK_NUMPAD9) => "Num9".to_string(),
    value if value == vk(VK_MULTIPLY) => "Num*".to_string(),
    value if value == vk(VK_ADD) => "Num+".to_string(),
    value if value == vk(VK_SEPARATOR) => "Num,".to_string(),
    value if value == vk(VK_SUBTRACT) => "Num-".to_string(),
    value if value == vk(VK_DECIMAL) => "Num.".to_string(),
    value if value == vk(VK_DIVIDE) => "Num/".to_string(),
    value if value == vk(VK_F1) => "F1".to_string(),
    value if value == vk(VK_F2) => "F2".to_string(),
    value if value == vk(VK_F3) => "F3".to_string(),
    value if value == vk(VK_F4) => "F4".to_string(),
    value if value == vk(VK_F5) => "F5".to_string(),
    value if value == vk(VK_F6) => "F6".to_string(),
    value if value == vk(VK_F7) => "F7".to_string(),
    value if value == vk(VK_F8) => "F8".to_string(),
    value if value == vk(VK_F9) => "F9".to_string(),
    value if value == vk(VK_F10) => "F10".to_string(),
    value if value == vk(VK_F11) => "F11".to_string(),
    value if value == vk(VK_F12) => "F12".to_string(),
    value if value == vk(VK_F13) => "F13".to_string(),
    value if value == vk(VK_F14) => "F14".to_string(),
    value if value == vk(VK_F15) => "F15".to_string(),
    value if value == vk(VK_F16) => "F16".to_string(),
    value if value == vk(VK_F17) => "F17".to_string(),
    value if value == vk(VK_F18) => "F18".to_string(),
    value if value == vk(VK_F19) => "F19".to_string(),
    value if value == vk(VK_F20) => "F20".to_string(),
    value if value == vk(VK_F21) => "F21".to_string(),
    value if value == vk(VK_F22) => "F22".to_string(),
    value if value == vk(VK_F23) => "F23".to_string(),
    value if value == vk(VK_F24) => "F24".to_string(),
    value if value == vk(VK_NUMLOCK) => "NumLock".to_string(),
    value if value == vk(VK_SCROLL) => "ScrollLock".to_string(),
    value if value == vk(VK_OEM_1) => ";".to_string(),
    value if value == vk(VK_OEM_PLUS) => "=".to_string(),
    value if value == vk(VK_OEM_COMMA) => ",".to_string(),
    value if value == vk(VK_OEM_MINUS) => "-".to_string(),
    value if value == vk(VK_OEM_PERIOD) => ".".to_string(),
    value if value == vk(VK_OEM_2) => "/".to_string(),
    value if value == vk(VK_OEM_3) => "`".to_string(),
    value if value == vk(VK_OEM_4) => "[".to_string(),
    value if value == vk(VK_OEM_5) => "\\".to_string(),
    value if value == vk(VK_OEM_6) => "]".to_string(),
    value if value == vk(VK_OEM_7) => "'".to_string(),
    value @ 0x30..=0x39 | value @ 0x41..=0x5A => char::from_u32(value).map(|ch| ch.to_string())?,
    _ => return None,
  };

  Some(code)
}

#[cfg(not(target_os = "windows"))]
pub fn vk_to_code(_vk_code: u32) -> Option<String> {
  None
}

pub fn modifiers_from_pressed(pressed: &HashSet<u32>) -> ModifierPayload {
  #[cfg(target_os = "windows")]
  {
    ModifierPayload {
      ctrl: pressed.contains(&vk(VK_CONTROL)) || pressed.contains(&vk(VK_LCONTROL)) || pressed.contains(&vk(VK_RCONTROL)),
      alt: pressed.contains(&vk(VK_MENU)) || pressed.contains(&vk(VK_LMENU)) || pressed.contains(&vk(VK_RMENU)),
      shift: pressed.contains(&vk(VK_SHIFT)) || pressed.contains(&vk(VK_LSHIFT)) || pressed.contains(&vk(VK_RSHIFT)),
      meta: pressed.contains(&vk(VK_LWIN)) || pressed.contains(&vk(VK_RWIN)),
    }
  }

  #[cfg(not(target_os = "windows"))]
  {
    let _ = pressed;
    ModifierPayload::default()
  }
}

fn exact_modifier_match(required: ModifierMask, current: ModifierPayload) -> bool {
  current.ctrl == required.ctrl
    && current.alt == required.alt
    && current.shift == required.shift
    && current.meta == required.meta
}

fn parse_keybind(id: &str, keybind: &str) -> Option<MacroBinding> {
  let trimmed = keybind.trim();
  if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("none") {
    return None;
  }

  let tokens = trimmed
    .split('+')
    .map(str::trim)
    .filter(|token| !token.is_empty())
    .collect::<Vec<_>>();

  if tokens.is_empty() {
    return None;
  }

  let base = tokens.last().copied()?;

  // Mouse buttons are handled by the mouse hook worker — store the binding
  // with an empty base_vks so the keyboard path ignores it.
  if base.starts_with("Mouse") {
    return Some(MacroBinding {
      id: id.to_string(),
      keybind: trimmed.to_string(),
      base_vks: vec![],
      modifiers: ModifierMask::default(),
      is_hold: is_hold_macro(id),
    });
  }

  let base_vks = code_to_vks(base)?;
  let mut modifiers = ModifierMask::default();

  for token in &tokens[..tokens.len().saturating_sub(1)] {
    let next = parse_modifier(token)?;
    modifiers.ctrl |= next.ctrl;
    modifiers.alt |= next.alt;
    modifiers.shift |= next.shift;
    modifiers.meta |= next.meta;
  }

  Some(MacroBinding {
    id: id.to_string(),
    keybind: trimmed.to_string(),
    base_vks,
    modifiers,
    is_hold: is_hold_macro(id),
  })
}

pub fn parse_binding(id: &str, keybind: &str) -> Option<MacroBinding> {
  parse_keybind(id, keybind)
}

fn compile_entry(id: &str, cfg: &Value) -> Option<MacroBinding> {
  if !cfg.get("active").and_then(Value::as_bool).unwrap_or(false) {
    return None;
  }

  let keybind = cfg.get("keybind").and_then(Value::as_str)?;
  parse_keybind(id, keybind)
}

pub fn compile_keyboard_bindings(config: &Value) -> Vec<MacroBinding> {
  let mut entries = Vec::new();
  let mut claimed = HashSet::<String>::new();

  for id in STANDARD_MACRO_ORDER {
    if let Some(cfg) = config.get(*id) {
      if let Some(binding) = compile_entry(id, cfg) {
        if claimed.insert(binding.keybind.clone()) {
          entries.push(binding);
        }
      }
    }
  }

  entries.extend(compile_kbd_bindings(config, &mut claimed));

  if let Some(custom_macros) = config.get("customMacros").and_then(Value::as_array) {
    for (index, cfg) in custom_macros.iter().enumerate() {
      let id = format!("rec:{index}");
      if let Some(binding) = compile_entry(&id, cfg) {
        if claimed.insert(binding.keybind.clone()) {
          entries.push(binding);
        }
      }
    }
  }

  entries
}

pub fn matching_press_triggers(
  bindings: &[MacroBinding],
  vk_code: u32,
  modifiers: ModifierPayload,
) -> Vec<MacroTriggerMatch> {
  bindings
    .iter()
    .filter(|binding| binding.base_vks.contains(&vk_code))
    .filter(|binding| {
      if !binding.modifiers.ctrl && !binding.modifiers.alt && !binding.modifiers.shift && !binding.modifiers.meta {
        true
      } else {
        exact_modifier_match(binding.modifiers, modifiers)
      }
    })
    .map(|binding| MacroTriggerMatch {
      id: binding.id.clone(),
      keybind: binding.keybind.clone(),
      action: "press",
    })
    .collect()
}

pub fn matching_release_triggers(bindings: &[MacroBinding], vk_code: u32) -> Vec<MacroTriggerMatch> {
  bindings
    .iter()
    .filter(|binding| binding.is_hold && binding.base_vks.contains(&vk_code))
    .map(|binding| MacroTriggerMatch {
      id: binding.id.clone(),
      keybind: binding.keybind.clone(),
      action: "release",
    })
    .collect()
}

#[cfg(test)]
mod tests {
  use super::{compile_keyboard_bindings, matching_press_triggers, matching_release_triggers, ModifierPayload};
  use serde_json::json;

  #[test]
  fn modifierless_bind_matches_even_with_ctrl_held() {
    let config = json!({
      "sa": { "active": true, "keybind": "G" }
    });
    let bindings = compile_keyboard_bindings(&config);
    let triggers = matching_press_triggers(
      &bindings,
      'G' as u32,
      ModifierPayload {
        ctrl: true,
        ..ModifierPayload::default()
      },
    );
    assert_eq!(triggers.len(), 1);
    assert_eq!(triggers[0].id, "sa");
  }

  #[test]
  fn combo_and_plain_bind_can_fire_together() {
    let config = json!({
      "sa": { "active": true, "keybind": "G" },
      "sfa": { "active": true, "keybind": "Ctrl+G" }
    });
    let bindings = compile_keyboard_bindings(&config);
    let triggers = matching_press_triggers(
      &bindings,
      'G' as u32,
      ModifierPayload {
        ctrl: true,
        ..ModifierPayload::default()
      },
    );
    assert_eq!(triggers.len(), 2);
    assert_eq!(triggers[0].id, "sa");
    assert_eq!(triggers[1].id, "sfa");
  }

  #[test]
  fn duplicate_keybind_keeps_first_macro() {
    let config = json!({
      "sa": { "active": true, "keybind": "G" },
      "sfa": { "active": true, "keybind": "G" }
    });
    let bindings = compile_keyboard_bindings(&config);
    assert_eq!(bindings.len(), 1);
    assert_eq!(bindings[0].id, "sa");
  }

  #[test]
  fn hold_macro_emits_release_trigger() {
    let config = json!({
      "fxp": { "active": true, "keybind": "G" }
    });
    let bindings = compile_keyboard_bindings(&config);
    let triggers = matching_release_triggers(&bindings, 'G' as u32);
    assert_eq!(triggers.len(), 1);
    assert_eq!(triggers[0].id, "fxp");
    assert_eq!(triggers[0].action, "release");
  }
}
