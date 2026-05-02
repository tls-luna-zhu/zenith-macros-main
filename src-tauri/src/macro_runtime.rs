use crate::{
  binds::code_to_vks,
  focus_lock::{self, SharedFocusState},
};
use serde_json::{json, Value};
use std::{
  collections::{HashMap, HashSet},
  sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
  },
  thread,
  time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};

pub type SharedMacroConfig = Arc<Mutex<Option<Value>>>;
pub type SharedFocusLockEnabled = Arc<AtomicBool>;
pub type SharedClickBinds = Arc<Mutex<ClickBinds>>;
pub type SharedAuthActive = Arc<AtomicBool>;
pub type SharedChatPaused = Arc<AtomicBool>;
pub type SharedMacroRuntime = Arc<MacroRuntime>;

const KEY_HOLD_MS: u64 = 20;
const CLICK_HOLD_MS: u64 = 10;
const SLOT_HOLD_MS: u64 = 17;
const WHEEL_DELTA: i32 = 120;
const XBUTTON1_DATA: u32 = 0x0001;
const XBUTTON2_DATA: u32 = 0x0002;

#[derive(Clone, Debug)]
pub struct ClickBinds {
  pub left: String,
  pub right: String,
}

impl Default for ClickBinds {
  fn default() -> Self {
    Self {
      left: "Mouse1".to_string(),
      right: "Mouse2".to_string(),
    }
  }
}

#[derive(Default)]
struct AnchorQueueState {
  running: bool,
  pending: bool,
}

#[derive(Default)]
struct ExecutionState {
  active: HashSet<String>,
  anchors: HashMap<String, AnchorQueueState>,
  fxp_stop: Option<mpsc::Sender<()>>,
  ac_stop: Option<mpsc::Sender<()>>,
  tb_stop: Option<mpsc::Sender<()>>,
  tb_last_toggle_ms: u64,
  hc_hold_stop: Option<mpsc::Sender<()>>,
  ass_stop: Option<mpsc::Sender<()>>, // Auto Stun Slam
}

pub struct MacroRuntime {
  config: SharedMacroConfig,
  focus_state: SharedFocusState,
  focus_lock_enabled: SharedFocusLockEnabled,
  auth_active: SharedAuthActive,
  chat_paused: SharedChatPaused,
  click_binds: SharedClickBinds,
  state: Mutex<ExecutionState>,
  app_handle: Arc<Mutex<Option<AppHandle>>>,
}

#[derive(Clone, Copy)]
enum MouseButton {
  Left,
  Right,
  Middle,
  X1,
  X2,
}

#[derive(Clone, Copy)]
enum ActionKey {
  Keyboard(u16),
  Mouse(MouseButton),
}

pub fn new(
  config: SharedMacroConfig,
  focus_state: SharedFocusState,
  focus_lock_enabled: SharedFocusLockEnabled,
  auth_active: SharedAuthActive,
  click_binds: SharedClickBinds,
  chat_paused: SharedChatPaused,
) -> SharedMacroRuntime {
  Arc::new(MacroRuntime {
    config,
    focus_state,
    focus_lock_enabled,
    auth_active,
    chat_paused,
    click_binds,
    state: Mutex::new(ExecutionState::default()),
    app_handle: Arc::new(Mutex::new(None)),
  })
}

impl MacroRuntime {
  pub fn set_authenticated(&self, active: bool) {
    self.auth_active.store(active, Ordering::Relaxed);
    if !active {
      self.stop_all();
    }
  }

  pub fn set_focus_lock_enabled(&self, enabled: bool) {
    self.focus_lock_enabled.store(enabled, Ordering::Relaxed);
  }

  pub fn stop_all(&self) {
    let (fxp_stop, ac_stop, tb_stop, hc_hold_stop, ass_stop) = {
      let mut state = self.state.lock().expect("macro runtime lock poisoned");
      state.active.clear();
      state.anchors.clear();
      (state.fxp_stop.take(), state.ac_stop.take(), state.tb_stop.take(), state.hc_hold_stop.take(), state.ass_stop.take())
    };

    if let Some(tx) = fxp_stop { let _ = tx.send(()); }
    if let Some(tx) = ac_stop  { let _ = tx.send(()); }
    if let Some(tx) = tb_stop  { let _ = tx.send(()); self.emit_tb_status(false); }
    if let Some(tx) = hc_hold_stop { let _ = tx.send(()); }
    if let Some(tx) = ass_stop { let _ = tx.send(()); }
  }

  pub fn set_app_handle(&self, handle: AppHandle) {
    if let Ok(mut guard) = self.app_handle.lock() {
      *guard = Some(handle);
    }
  }

  pub fn set_chat_paused(&self, paused: bool) {
    self.chat_paused.store(paused, Ordering::Relaxed);
  }

  fn emit_tb_status(&self, active: bool) {
    if let Ok(guard) = self.app_handle.lock() {
      if let Some(ref handle) = *guard {
        if let Some(window) = handle.get_webview_window("main") {
          let _ = window.emit("tb-status", active);
        }
      }
    }
  }

  fn emit_ass_status(&self, active: bool) {
    if let Ok(guard) = self.app_handle.lock() {
      if let Some(ref handle) = *guard {
        if let Some(window) = handle.get_webview_window("main") {
          let _ = window.emit("ass-status", active);
        }
      }
    }
  }

  fn emit_tb_detecting(&self, detecting: bool) {
    if let Ok(guard) = self.app_handle.lock() {
      if let Some(ref handle) = *guard {
        if let Some(window) = handle.get_webview_window("main") {
          let _ = window.emit("tb-detecting", detecting);
        }
      }
    }
  }

  pub fn set_click_binds(&self, left: Option<String>, right: Option<String>) {
    if let Ok(mut binds) = self.click_binds.lock() {
      if let Some(value) = normalize_bind(left.as_deref()) {
        binds.left = value;
      }
      if let Some(value) = normalize_bind(right.as_deref()) {
        binds.right = value;
      }
    }
  }

  pub fn handle_trigger(self: &Arc<Self>, id: String, action: &str) {
    match (id.as_str(), action) {
      ("fxp", "press") => self.start_fxp(),
      ("fxp", "release") => self.stop_fxp(),
      ("ac", "press") => self.start_ac(),
      ("ac", "release") => self.stop_ac(),
      ("tb", "press") => self.toggle_triggerbot(),
      ("ass", "press") => self.toggle_auto_ss(),
      ("hc", "press") => self.start_hc_hold(),
      ("hc", "release") => self.stop_hc_hold(),
      (macro_id, "press") if matches!(macro_id, "sa" | "sfa" | "da" | "ap") => {
        self.queue_anchor(macro_id.to_string());
      }
      (macro_id, "press") => {
        self.start_standard(macro_id.to_string());
      }
      _ => {}
    }
  }

  fn queue_anchor(self: &Arc<Self>, id: String) {
    if !self.can_execute_now() {
      return;
    }

    let should_spawn = {
      let mut state = self.state.lock().expect("macro runtime lock poisoned");
      let entry = state.anchors.entry(id.clone()).or_default();
      if entry.running {
        entry.pending = true;
        false
      } else {
        entry.running = true;
        entry.pending = false;
        true
      }
    };

    if !should_spawn {
      return;
    }

    let runtime = Arc::clone(self);
    thread::spawn(move || {
      loop {
        let cfg = runtime.macro_cfg(&id);
        runtime.execute_macro(&id, &cfg);

        let pending = {
          let mut state = runtime.state.lock().expect("macro runtime lock poisoned");
          if let Some(entry) = state.anchors.get_mut(&id) {
            if entry.pending {
              entry.pending = false;
              true
            } else {
              entry.running = false;
              false
            }
          } else {
            false
          }
        };

        if !pending {
          break;
        }
      }
    });
  }

  fn start_standard(self: &Arc<Self>, id: String) {
    if !self.can_execute_now() {
      return;
    }

    let should_spawn = {
      let mut state = self.state.lock().expect("macro runtime lock poisoned");
      if state.active.contains(&id) {
        false
      } else {
        state.active.insert(id.clone());
        true
      }
    };

    if !should_spawn {
      return;
    }

    let runtime = Arc::clone(self);
    thread::spawn(move || {
      let cfg = runtime.macro_cfg(&id);
      runtime.execute_macro(&id, &cfg);
      let mut state = runtime.state.lock().expect("macro runtime lock poisoned");
      state.active.remove(&id);
    });
  }

  fn start_fxp(self: &Arc<Self>) {
    if !self.can_execute_now() {
      return;
    }

    let (delay, right_click) = {
      let cfg = self.macro_cfg("fxp");
      (value_u64(&cfg, "delay", 35), self.right_click_action())
    };

    let (tx, rx) = mpsc::channel::<()>();
    {
      let mut state = self.state.lock().expect("macro runtime lock poisoned");
      if state.fxp_stop.is_some() {
        return;
      }
      state.fxp_stop = Some(tx);
    }

    let runtime = Arc::clone(self);
    thread::spawn(move || {
      runtime.ensure_focus_target();
      loop {
        if !runtime.can_execute_now() {
          break;
        }
        runtime.click_action(right_click, CLICK_HOLD_MS);
        if wait_or_stop(&rx, Duration::from_millis(delay)) {
          break;
        }
      }
      let mut state = runtime.state.lock().expect("macro runtime lock poisoned");
      state.fxp_stop = None;
    });
  }

  fn stop_fxp(&self) {
    let stop = {
      let mut state = self.state.lock().expect("macro runtime lock poisoned");
      state.fxp_stop.take()
    };
    if let Some(tx) = stop {
      let _ = tx.send(());
    }
  }

  fn start_ac(self: &Arc<Self>) {
    if !self.can_execute_now() {
      return;
    }

    let cfg = self.macro_cfg("ac");
    let crystal_key = value_text(&cfg, "crystalKey", "5");
    let delay = value_u64(&cfg, "delay", 25).max(12);

    let (tx, rx) = mpsc::channel::<()>();
    {
      let mut state = self.state.lock().expect("macro runtime lock poisoned");
      if state.ac_stop.is_some() {
        return;
      }
      state.ac_stop = Some(tx);
    }

    let runtime = Arc::clone(self);
    thread::spawn(move || {
      runtime.ensure_focus_target();
      thread::sleep(Duration::from_millis(10));
      if !runtime.can_execute_now() {
        let mut state = runtime.state.lock().expect("macro runtime lock poisoned");
        state.ac_stop = None;
        return;
      }

      // Select crystal slot once at start
      if has_action(&cfg, "select") {
        runtime.tap_action_str(&crystal_key, SLOT_HOLD_MS);
        thread::sleep(Duration::from_millis(8));
      }

      loop {
        if !runtime.can_execute_now() {
          break;
        }

        // Place crystal (right click)
        if has_action(&cfg, "place") {
          runtime.click_mouse_fixed(MouseButton::Right, CLICK_HOLD_MS);
        }
        if wait_or_stop(&rx, Duration::from_millis(delay)) {
          break;
        }

        if !runtime.can_execute_now() {
          break;
        }

        // Break crystal (left click)
        if has_action(&cfg, "break") {
          runtime.click_mouse_fixed(MouseButton::Left, CLICK_HOLD_MS);
        }
        if wait_or_stop(&rx, Duration::from_millis(delay)) {
          break;
        }

        // Re-select crystal slot to keep consistency
        if !runtime.can_execute_now() {
          break;
        }
        runtime.tap_action_str(&crystal_key, SLOT_HOLD_MS);
        if wait_or_stop(&rx, Duration::from_millis(8)) {
          break;
        }
      }

      let mut state = runtime.state.lock().expect("macro runtime lock poisoned");
      state.ac_stop = None;
    });
  }

  fn stop_ac(&self) {
    let stop = {
      let mut state = self.state.lock().expect("macro runtime lock poisoned");
      state.ac_stop.take()
    };
    if let Some(tx) = stop {
      let _ = tx.send(());
    }
  }

  fn toggle_triggerbot(self: &Arc<Self>) {
    // Check if already running, atomically decide what to do.
    let is_running = {
      let state = self.state.lock().expect("macro runtime lock poisoned");
      state.tb_stop.is_some()
    };
    if is_running {
      self.stop_triggerbot();
    } else {
      self.start_triggerbot();
    }
  }

  fn start_triggerbot(self: &Arc<Self>) {
    let cfg = self.macro_cfg("tb");
    // hitCooldown is a minimum debounce between clicks (ms).
    // Default 50ms — the crosshair color itself (turns white during MC attack cooldown)
    // is the natural rate limiter. Max 5000ms so users can intentionally slow the bot.
    let cooldown = value_u64(&cfg, "hitCooldown", 50).clamp(10, 5000);
    let mode = value_text(&cfg, "tbMode", "normal");
    let stap_ms = value_u64(&cfg, "sTapMs", 600).clamp(10, 2000);
    let left_click = self.left_click_action();

    let (tx, rx) = mpsc::channel::<()>();
    {
      let mut state = self.state.lock().expect("macro runtime lock poisoned");
      if state.tb_stop.is_some() {
        return;
      }
      state.tb_stop = Some(tx);
    }

    self.emit_tb_status(true);

    let runtime = Arc::clone(self);
    thread::spawn(move || {
      let mut last_click_ms: u64 = 0;
      let mut last_detecting = false;
      let mut detect_emit_ms: u64 = 0;
      loop {
        // ── Focus check: don't fire when MC is not focused ──
        {
          let focus_enabled = runtime.focus_lock_enabled.load(Ordering::Relaxed);
          if focus_enabled {
            let fs = runtime.focus_state.lock().expect("focus state lock poisoned");
            if !fs.focused {
              if last_detecting {
                last_detecting = false;
                runtime.emit_tb_detecting(false);
              }
              if wait_or_stop(&rx, Duration::from_millis(100)) { break; }
              continue;
            }
          }
        }

        // ── Chat pause: don't fire when chat is open ──
        if runtime.chat_paused.load(Ordering::Relaxed) {
          if last_detecting {
            last_detecting = false;
            runtime.emit_tb_detecting(false);
          }
          if wait_or_stop(&rx, Duration::from_millis(50)) { break; }
          continue;
        }

        // ── Get the foreground MC window ──
        let fg = get_fg_hwnd();
        if fg == 0 {
          if wait_or_stop(&rx, Duration::from_millis(100)) { break; }
          continue;
        }

        // ── Capture center region and check for crosshair color ──
        let detected = tb_scan_center(fg, &mode);

        // Emit detection state on change, or every 200ms as keepalive
        let now_ms = std::time::SystemTime::now()
          .duration_since(std::time::UNIX_EPOCH)
          .unwrap_or_default()
          .as_millis() as u64;
        if detected != last_detecting || now_ms.saturating_sub(detect_emit_ms) >= 200 {
          last_detecting = detected;
          detect_emit_ms = now_ms;
          runtime.emit_tb_detecting(detected);
        }

        if detected {
          if now_ms.saturating_sub(last_click_ms) >= cooldown {
            last_click_ms = now_ms;
            runtime.click_action(left_click, CLICK_HOLD_MS);
            if mode == "s-tap" {
              runtime.tap_action_str("S", stap_ms);
            }
          }
        }

        if wait_or_stop(&rx, Duration::from_millis(5)) {
          break;
        }
      }
      {
        let mut state = runtime.state.lock().expect("macro runtime lock poisoned");
        let _ = state.tb_stop.take();
      }
      runtime.emit_tb_status(false);
    });
  }

  fn stop_triggerbot(&self) {
    let stop = {
      let mut state = self.state.lock().expect("macro runtime lock poisoned");
      state.tb_stop.take()
    };
    if let Some(tx) = stop {
      let _ = tx.send(());
      // emit false immediately so UI updates without waiting for thread to exit
      self.emit_tb_status(false);
    }
  }

  // ── Auto Stun Slam ──────────────────────────────────────────────────────────
  // Same pixel scan as Triggerbot but fires run_ss instead of a click.
  // Only triggers on blue crosshair (target with shield / crit indicator).

  fn toggle_auto_ss(self: &Arc<Self>) {
    let is_running = {
      let state = self.state.lock().expect("macro runtime lock poisoned");
      state.ass_stop.is_some()
    };
    if is_running {
      self.stop_auto_ss();
    } else {
      self.start_auto_ss();
    }
  }

  fn start_auto_ss(self: &Arc<Self>) {
    let cfg = self.macro_cfg("ass");
    let cooldown = value_u64(&cfg, "hitCooldown", 500).clamp(100, 5000);

    let (tx, rx) = mpsc::channel::<()>();
    {
      let mut state = self.state.lock().expect("macro runtime lock poisoned");
      if state.ass_stop.is_some() {
        return;
      }
      state.ass_stop = Some(tx);
    }
    self.emit_ass_status(true);

    // Pre-read SS config once — avoids mutex + JSON clone on every hot-loop tick
    let ss_cfg = self.macro_cfg("ss");

    let runtime = Arc::clone(self);
    thread::spawn(move || {
      let mut last_fire_ms: u64 = 0;
      loop {
        // Auto-stop when alt-tabbed — always check focus regardless of focus lock setting
        {
          let fs = runtime.focus_state.lock().expect("focus state lock poisoned");
          if !fs.focused {
            // MC is not in the foreground — untoggle ASS completely
            break;
          }
        }

        // Chat pause check
        if runtime.chat_paused.load(Ordering::Relaxed) {
          if wait_or_stop(&rx, Duration::from_millis(50)) { break; }
          continue;
        }

        let fg = get_fg_hwnd();
        if fg == 0 {
          break;
        }

        // Only fire on blue crosshair (same as Triggerbot "smart-crit" mode)
        let detected = tb_scan_center(fg, "smart-crit");

        if detected {
          let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
          if now_ms.saturating_sub(last_fire_ms) >= cooldown {
            last_fire_ms = now_ms;
            runtime.run_ss(&ss_cfg);
          }
        }

        if wait_or_stop(&rx, Duration::from_millis(5)) {
          break;
        }
      }
      {
        let mut state = runtime.state.lock().expect("macro runtime lock poisoned");
        let _ = state.ass_stop.take();
      }
      runtime.emit_ass_status(false);
    });
  }

  fn stop_auto_ss(&self) {
    let stop = {
      let mut state = self.state.lock().expect("macro runtime lock poisoned");
      state.ass_stop.take()
    };
    if let Some(tx) = stop {
      let _ = tx.send(());
      self.emit_ass_status(false);
    }
  }

  fn start_hc_hold(self: &Arc<Self>) {
    if !self.can_execute_now() {
      return;
    }

    let cfg = self.macro_cfg("hc");
    let obsidian = value_text(&cfg, "obsidianKey", "4");
    let crystal = value_text(&cfg, "crystalKey", "5");
    let delay = value_u64(&cfg, "delay", 12).max(10);

    let (tx, rx) = mpsc::channel::<()>();
    {
      let mut state = self.state.lock().expect("macro runtime lock poisoned");
      if state.hc_hold_stop.is_some() {
        return;
      }
      state.hc_hold_stop = Some(tx);
    }

    let do_obsidian = has_action(&cfg, "obsidian");
    let do_place = has_action(&cfg, "place");
    let do_break = has_action(&cfg, "break");

    let runtime = Arc::clone(self);
    thread::spawn(move || {
      runtime.ensure_focus_target();
      thread::sleep(Duration::from_millis(10));
      if !runtime.can_execute_now() {
        let mut state = runtime.state.lock().expect("macro runtime lock poisoned");
        state.hc_hold_stop = None;
        return;
      }

      // Phase 1: Place obsidian (if action enabled)
      if do_obsidian {
        runtime.tap_action_str(&obsidian, SLOT_HOLD_MS);
        thread::sleep(Duration::from_millis(delay));
        runtime.click_mouse_fixed(MouseButton::Right, CLICK_HOLD_MS);
        thread::sleep(Duration::from_millis(delay.max(50))); // server registration
      }

      // Phase 2: Place first crystal (if action enabled)
      if do_place {
        runtime.tap_action_str(&crystal, SLOT_HOLD_MS);
        thread::sleep(Duration::from_millis(delay));
        runtime.click_mouse_fixed(MouseButton::Right, CLICK_HOLD_MS);
        // Wait for crystal to register on server before breaking
        thread::sleep(Duration::from_millis(delay.max(80)));
      }

      // Phase 3: Break first crystal (if action enabled)
      if do_break {
        runtime.click_mouse_fixed(MouseButton::Left, CLICK_HOLD_MS);
      }
      if wait_or_stop(&rx, Duration::from_millis(delay)) {
        let mut s = runtime.state.lock().expect("macro runtime lock poisoned");
        s.hc_hold_stop = None;
        return;
      }

      // Phase 4: Loop — place crystal, break crystal, repeat until released
      loop {
        if !runtime.can_execute_now() {
          break;
        }

        if do_place {
          runtime.tap_action_str(&crystal, SLOT_HOLD_MS);
          thread::sleep(Duration::from_millis(delay));
          runtime.click_mouse_fixed(MouseButton::Right, CLICK_HOLD_MS);
          thread::sleep(Duration::from_millis(delay.max(80)));
        }

        if do_break {
          runtime.click_mouse_fixed(MouseButton::Left, CLICK_HOLD_MS);
        }
        if wait_or_stop(&rx, Duration::from_millis(delay)) {
          break;
        }
      }

      let mut state = runtime.state.lock().expect("macro runtime lock poisoned");
      state.hc_hold_stop = None;
    });
  }

  fn stop_hc_hold(&self) {
    let stop = {
      let mut state = self.state.lock().expect("macro runtime lock poisoned");
      state.hc_hold_stop.take()
    };
    if let Some(tx) = stop {
      let _ = tx.send(());
    }
  }

  fn execute_macro(&self, id: &str, cfg: &Value) {
    match id {
      "sa" => self.run_sa(cfg),
      "sfa" => self.run_sfa(cfg),
      "da" => self.run_da(cfg),
      "ap" => self.run_ap(cfg),
      "hc" => self.run_hc(cfg),
      "kp" => self.run_kp(cfg),
      "idh" => self.run_idh(cfg),
      "oht" => self.run_oht(cfg),
      "asb" => self.run_asb(cfg),
      "ls" => self.run_ls(cfg),
      "es" => self.run_es(cfg),
      "pc" => self.run_pc(cfg),
      "ss" => self.run_ss(cfg),
      "sw" => self.run_sw(cfg),
      "bs" => self.run_bs(cfg),
      "kbd_l" => self.run_kbd(cfg, -1),
      "kbd_r" => self.run_kbd(cfg, 1),
      "ic" => self.run_ic(cfg),
      "xb" => self.run_xb(cfg),
      "dr" => self.run_dr(cfg),
      "lw" => self.run_lw(cfg),
      "la" => self.run_la(cfg),
      _ if id.starts_with("rec:") => self.run_recorded(id, cfg),
      _ => {}
    }
  }

  fn can_execute_now(&self) -> bool {
    if !self.auth_active.load(Ordering::Relaxed) {
      return false;
    }

    if self.chat_paused.load(Ordering::Relaxed) {
      return false;
    }

    if !self.focus_lock_enabled.load(Ordering::Relaxed) {
      return true;
    }

    focus_lock::current_snapshot(&self.focus_state).focused
  }

  fn ensure_focus_target(&self) {
    let _ = focus_lock::focus_minecraft(&self.focus_state);
  }

  fn macro_cfg(&self, id: &str) -> Value {
    let root = self
      .config
      .lock()
      .expect("macro config lock poisoned")
      .clone()
      .unwrap_or_else(|| json!({}));

    // Extract the per-macro sub-config
    let mut sub = if let Some(index) = id.strip_prefix("rec:").and_then(|value| value.parse::<usize>().ok()) {
      root
        .get("customMacros")
        .and_then(Value::as_array)
        .and_then(|items| items.get(index))
        .cloned()
        .unwrap_or_else(|| json!({}))
    } else if matches!(id, "kbd_l" | "kbd_r") {
      root.get("kbd").cloned().unwrap_or_else(|| json!({}))
    } else {
      root.get(id).cloned().unwrap_or_else(|| json!({}))
    };

    sub
  }

  fn click_binds(&self) -> ClickBinds {
    self.click_binds.lock().expect("click binds lock poisoned").clone()
  }

  fn left_click_action(&self) -> ActionKey {
    parse_action_key(&self.click_binds().left).unwrap_or(ActionKey::Mouse(MouseButton::Left))
  }

  fn right_click_action(&self) -> ActionKey {
    parse_action_key(&self.click_binds().right).unwrap_or(ActionKey::Mouse(MouseButton::Right))
  }

  fn tap_action_str(&self, key: &str, hold_ms: u64) {
    if let Some(action) = parse_action_key(key) {
      self.tap_action(action, hold_ms);
    }
  }

  fn tap_action(&self, action: ActionKey, hold_ms: u64) {
    match action {
      ActionKey::Keyboard(vk) => {
        let _ = tap_keyboard(vk, hold_ms);
      }
      ActionKey::Mouse(button) => {
        let _ = click_mouse(button, hold_ms);
      }
    }
  }

  fn toggle_action_str(&self, key: &str, is_down: bool) {
    if let Some(action) = parse_action_key(key) {
      self.toggle_action(action, is_down);
    }
  }

  fn toggle_action(&self, action: ActionKey, is_down: bool) {
    match action {
      ActionKey::Keyboard(vk) => {
        let _ = toggle_keyboard(vk, is_down);
      }
      ActionKey::Mouse(button) => {
        let _ = toggle_mouse(button, is_down);
      }
    }
  }

  fn click_action(&self, action: ActionKey, hold_ms: u64) {
    match action {
      ActionKey::Keyboard(vk) => {
        let _ = tap_keyboard(vk, hold_ms);
      }
      ActionKey::Mouse(button) => {
        let _ = click_mouse(button, hold_ms);
      }
    }
  }

  fn click_mouse_fixed(&self, button: MouseButton, hold_ms: u64) {
    let _ = click_mouse_held_safe(button, hold_ms);
  }

  fn slot_click(&self, slot_key: &str) {
    if let Some(slot_action) = parse_action_key(slot_key) {
      match slot_action {
        ActionKey::Mouse(_) => {
          self.tap_action(slot_action, SLOT_HOLD_MS);
          self.click_action(self.right_click_action(), CLICK_HOLD_MS);
        }
        ActionKey::Keyboard(vk) => {
          let right = self.right_click_action();
          self.toggle_action(ActionKey::Keyboard(vk), true);
          thread::sleep(Duration::from_millis(4)); // let MC process slot change before clicking
          self.toggle_action(right, true);
          thread::sleep(Duration::from_millis(CLICK_HOLD_MS));
          self.toggle_action(right, false);
          if SLOT_HOLD_MS > CLICK_HOLD_MS + 4 {
            thread::sleep(Duration::from_millis(SLOT_HOLD_MS - CLICK_HOLD_MS - 4));
          }
          self.toggle_action(ActionKey::Keyboard(vk), false);
        }
      }
    }
  }

  fn slot_lclick(&self, slot_key: &str) {
    if let Some(slot_action) = parse_action_key(slot_key) {
      match slot_action {
        ActionKey::Mouse(_) => {
          self.tap_action(slot_action, SLOT_HOLD_MS);
          self.click_action(self.left_click_action(), CLICK_HOLD_MS);
        }
        ActionKey::Keyboard(vk) => {
          let left = self.left_click_action();
          self.toggle_action(ActionKey::Keyboard(vk), true);
          thread::sleep(Duration::from_millis(10)); // let MC process slot change before clicking
          self.toggle_action(left, true);
          thread::sleep(Duration::from_millis(CLICK_HOLD_MS));
          self.toggle_action(left, false);
          if SLOT_HOLD_MS > CLICK_HOLD_MS + 10 {
            thread::sleep(Duration::from_millis(SLOT_HOLD_MS - CLICK_HOLD_MS - 10));
          }
          self.toggle_action(ActionKey::Keyboard(vk), false);
        }
      }
    }
  }

  fn run_sa(&self, cfg: &Value) {
    let delay = value_u64(cfg, "delay", 27);
    let anchor = value_text(cfg, "anchorKey", "4");
    let glowstone = value_text(cfg, "glowstoneKey", "5");
    let detonate = fallback_totem_key(cfg);
    let actions = sa_actions(cfg);

    self.ensure_focus_target();
    for (index, action) in actions.iter().enumerate() {
      match *action {
        "place" => self.slot_click(&anchor),
        "charge" => self.slot_click(&glowstone),
        "explode" => self.slot_click(&detonate),
        _ => {}
      }
      if index + 1 < actions.len() {
        thread::sleep(Duration::from_millis(delay));
      }
    }

    if let Some(last_step) = actions.last() {
      match *last_step {
        "place" => {
          thread::sleep(Duration::from_millis(delay));
          self.tap_action_str(&glowstone, SLOT_HOLD_MS);
        }
        "charge" => {
          thread::sleep(Duration::from_millis(delay));
          self.tap_action_str(&detonate, SLOT_HOLD_MS);
        }
        _ => {}
      }
    }
  }

  fn run_sfa(&self, cfg: &Value) {
    // Dispatch to classic (crouch-place) mode if selected
    let mode = value_text(cfg, "mode", "flick");
    if mode.eq_ignore_ascii_case("classic") {
      self.run_sfa_classic(cfg);
      return;
    }

    let delay = value_u64(cfg, "delay", 50);
    let anchor = value_text(cfg, "anchorKey", "4");
    let glowstone = value_text(cfg, "glowstoneKey", "5");
    let detonate = fallback_totem_key(cfg);

    let flick_distance = value_i32(cfg, "flickDistance", 300).clamp(50, 1200);
    let flick_steps = value_u64(cfg, "flickSteps", 5).clamp(1, 30) as i32;
    let flick_step_delay = value_u64(cfg, "flickStepDelay", 2).clamp(0, 20);

    let do_place   = has_action(cfg, "place");
    let do_charge  = has_action(cfg, "charge");
    let do_flick   = has_action(cfg, "flick") || has_action(cfg, "hold");
    let do_totem   = has_action(cfg, "totem") || has_action(cfg, "explode") || has_action(cfg, "hold");

    self.ensure_focus_target();

    // 1. Place anchor
    if do_place {
      self.slot_click(&anchor);
      thread::sleep(Duration::from_millis(delay));
    }

    // 2. Charge anchor with glowstone
    if do_charge {
      self.slot_click(&glowstone);
      thread::sleep(Duration::from_millis(delay));
    }

    // 3. Flick down + place glowstone
    if do_flick {
      self.smooth_flick(0, flick_distance, flick_steps, flick_step_delay);
      // Wait for MC to register new aim position, then right-click with longer hold
      thread::sleep(Duration::from_millis(50));
      self.slot_click(&glowstone);
      thread::sleep(Duration::from_millis(delay));
    }

    // 4. Switch to totem
    if do_totem {
      self.tap_action_str(&detonate, SLOT_HOLD_MS);
    }
  }

  /// Classic Safe Anchor: place anchor -> charge with glowstone -> crouch ->
  /// place glowstone block -> switch to totem -> uncrouch -> detonate.
  ///
  /// Minecraft runs at 20 ticks/sec (50ms/tick). Every state change
  /// (slot swap, right-click, sneak) must land in its OWN tick to be
  /// processed reliably. Sub-tick delays cause silent drops: slot swap
  /// ignored → right-click fires with previous item → "all anchors"
  /// failure mode. All waits are explicitly one full tick + buffer.
  fn run_sfa_classic(&self, cfg: &Value) {
    let anchor = value_text(cfg, "anchorKey", "4");
    let glowstone = value_text(cfg, "glowstoneKey", "5");
    let detonate = fallback_totem_key(cfg);
    let shift = parse_action_key("LShift")
      .unwrap_or(ActionKey::Keyboard(0xA0));
    let right = self.right_click_action();
    let left = self.left_click_action();

    // User-configurable inter-step delay. 50ms = one MC tick.
    let tick: u64 = value_u64(cfg, "delay", 60).clamp(10, 500);
    // Sneak pose + physics needs at least ~90ms to settle before the
    // glowstone-block place, regardless of user's tick.
    let sneak_warmup: u64 = tick.max(60) + 30;

    // Action gating — Classic replaces FLICK with CROUCH in the UI,
    // and TOTEM also encompasses the detonate left-click.
    let do_place  = has_action(cfg, "place");
    let do_charge = has_action(cfg, "charge");
    let do_crouch = has_action(cfg, "crouch") || has_action(cfg, "flick");
    let do_totem  = has_action(cfg, "totem") || has_action(cfg, "explode");

    self.ensure_focus_target();

    // 1. Place anchor — short slot-swap hold keeps the first action snappy
    //    (no "pre-fire" delay). `tick` is only used for inter-step pacing.
    if do_place {
      self.tap_action_str(&anchor, SLOT_HOLD_MS);
      self.click_action(right, CLICK_HOLD_MS);
      thread::sleep(Duration::from_millis(tick));
    }

    // 2. Charge anchor with glowstone.
    if do_charge {
      self.tap_action_str(&glowstone, SLOT_HOLD_MS);
      self.click_action(right, CLICK_HOLD_MS);
      thread::sleep(Duration::from_millis(tick));
    }

    // 3. Sneak → place glowstone block (the "safe" part).
    if do_crouch {
      self.toggle_action(shift, true);
      thread::sleep(Duration::from_millis(sneak_warmup));
      // Keep glowstone selected from step 2 if charge just ran, else re-select.
      if !do_charge {
        self.tap_action_str(&glowstone, SLOT_HOLD_MS);
      }
      self.click_action(right, CLICK_HOLD_MS);
      thread::sleep(Duration::from_millis(tick));
    }

    // 4. Swap to totem (still sneaking if we crouched) and detonate.
    if do_totem {
      self.tap_action_str(&detonate, SLOT_HOLD_MS);
      thread::sleep(Duration::from_millis(20));
      if do_crouch {
        self.toggle_action(shift, false);
        thread::sleep(Duration::from_millis(30));
      }
      self.click_action(left, CLICK_HOLD_MS);
    } else if do_crouch {
      // Uncrouch even if user skipped totem.
      self.toggle_action(shift, false);
    }
  }

  /// Moves the mouse smoothly over `steps` increments with `step_delay_ms` between each.
  /// Total movement is (dx, dy) in raw mouse units.
  /// steps=1 is an instant snap, higher values produce a smoother arc.
  fn smooth_flick(&self, dx: i32, dy: i32, steps: i32, step_delay_ms: u64) {
    if steps <= 1 {
      // Instant flick — single movement
      let _ = move_mouse_relative(dx, dy);
      return;
    }

    // Distribute the total movement across steps, accumulating remainder
    // to avoid rounding drift (ensures we land exactly on target)
    let mut moved_x: i32 = 0;
    let mut moved_y: i32 = 0;

    for i in 1..=steps {
      let target_x = (dx as i64 * i as i64 / steps as i64) as i32;
      let target_y = (dy as i64 * i as i64 / steps as i64) as i32;
      let step_dx = target_x - moved_x;
      let step_dy = target_y - moved_y;

      let _ = move_mouse_relative(step_dx, step_dy);
      moved_x = target_x;
      moved_y = target_y;

      if i < steps && step_delay_ms > 0 {
        thread::sleep(Duration::from_millis(step_delay_ms));
      }
    }
  }

  fn run_da(&self, cfg: &Value) {
    let delay = value_u64(cfg, "delay", 26);
    let anchor = value_text(cfg, "anchorKey", "4");
    let glowstone = value_text(cfg, "glowstoneKey", "5");
    let detonate = fallback_totem_key(cfg);
    let cycle_gap = ((delay as f64 * 0.35).floor() as u64).clamp(8, 22);

    self.ensure_focus_target();
    for index in 0..2 {
      if has_action(cfg, "place") {
        self.slot_click(&anchor);
        thread::sleep(Duration::from_millis(delay));
      }
      if has_action(cfg, "charge") {
        self.slot_click(&glowstone);
        thread::sleep(Duration::from_millis(delay));
      }
      if has_action(cfg, "explode") {
        self.slot_click(&detonate);
      }
      if index == 0 {
        thread::sleep(Duration::from_millis(cycle_gap));
      }
    }
  }

  fn run_ap(&self, cfg: &Value) {
    let delay = value_u64(cfg, "delay", 25);
    let anchor = value_text(cfg, "anchorKey", "4");
    let glowstone = value_text(cfg, "glowstoneKey", "5");
    let pearl = value_text(cfg, "pearlKey", "6");
    let detonate = fallback_totem_key(cfg);

    self.ensure_focus_target();
    if has_action(cfg, "place") {
      self.slot_click(&anchor);
      thread::sleep(Duration::from_millis(delay));
    }
    if has_action(cfg, "charge") {
      self.slot_click(&glowstone);
      thread::sleep(Duration::from_millis(delay));
    }
    if has_action(cfg, "explode") {
      self.slot_click(&detonate);
      thread::sleep(Duration::from_millis(delay));
    }
    if has_action(cfg, "pearl") {
      self.tap_action_str(&pearl, SLOT_HOLD_MS);
      thread::sleep(Duration::from_millis(12));
      self.click_action(self.right_click_action(), CLICK_HOLD_MS);
      thread::sleep(Duration::from_millis(delay.max(10)));
      self.tap_action_str(&detonate, SLOT_HOLD_MS);
    }
  }

  fn run_hc(&self, cfg: &Value) {
    let delay = value_u64(cfg, "delay", 12);
    let step = delay.max(10);
    let obsidian = value_text(cfg, "obsidianKey", "4");
    let crystal = value_text(cfg, "crystalKey", "5");

    thread::sleep(Duration::from_millis(10));
    self.ensure_focus_target();

    if has_action(cfg, "obsidian") {
      self.tap_action_str(&obsidian, SLOT_HOLD_MS);
      thread::sleep(Duration::from_millis(step));
      self.click_mouse_fixed(MouseButton::Right, CLICK_HOLD_MS);
      thread::sleep(Duration::from_millis(step.max(50)));
    }

    if has_action(cfg, "place") {
      self.tap_action_str(&crystal, SLOT_HOLD_MS);
      thread::sleep(Duration::from_millis(step));
      self.click_mouse_fixed(MouseButton::Right, CLICK_HOLD_MS);
      // Wait for crystal to actually place on server before breaking
      thread::sleep(Duration::from_millis(step.max(80)));
    }

    if has_action(cfg, "break") {
      self.click_mouse_fixed(MouseButton::Left, CLICK_HOLD_MS);
      thread::sleep(Duration::from_millis(4));
      self.click_mouse_fixed(MouseButton::Left, CLICK_HOLD_MS);
    }
  }

  fn run_kp(&self, cfg: &Value) {
    let delay = value_u64(cfg, "delay", 30);
    let pearl = value_text(cfg, "pearlKey", "6");
    let return_key = value_text(cfg, "returnKey", "1");

    thread::sleep(Duration::from_millis(30));
    self.ensure_focus_target();
    if has_action(cfg, "select") {
      self.tap_action_str(&pearl, KEY_HOLD_MS);
      thread::sleep(Duration::from_millis(delay));
    }
    if has_action(cfg, "throw") {
      self.click_action(self.right_click_action(), CLICK_HOLD_MS);
      thread::sleep(Duration::from_millis(delay));
    }
    if has_action(cfg, "return") {
      self.tap_action_str(&return_key, KEY_HOLD_MS);
    }
  }

  fn run_idh(&self, cfg: &Value) {
    let delay = value_u64(cfg, "delay", 25);
    let totem = value_text(cfg, "totemKey", "9");
    let swap  = value_text(cfg, "swapKey", "F");

    self.ensure_focus_target();
    if has_action(cfg, "open") {
      self.tap_action_str(&totem, SLOT_HOLD_MS);
      thread::sleep(Duration::from_millis(delay.max(20)));
    }
    if has_action(cfg, "swap") {
      self.tap_action_str(&swap, KEY_HOLD_MS);
    }
  }

  fn run_oht(&self, cfg: &Value) {
    let delay = value_u64(cfg, "delay", 50); // configurable via UI
    let totem = value_text(cfg, "totemKey", "9");
    let swap = value_text(cfg, "swapKey", "F");

    thread::sleep(Duration::from_millis(30));
    self.ensure_focus_target();
    if has_action(cfg, "select") {
      self.tap_action_str(&totem, SLOT_HOLD_MS);
      thread::sleep(Duration::from_millis(delay.max(30)));
    }
    if has_action(cfg, "swap") {
      self.tap_action_str(&swap, KEY_HOLD_MS);
      thread::sleep(Duration::from_millis(20));
    }
  }

  fn run_asb(&self, cfg: &Value) {
    let axe = value_text(cfg, "axeKey", "2");
    let sword = value_text(cfg, "swordKey", "1");
    let dc = value_u64(cfg, "doubleClickMs", 8).min(100);

    thread::sleep(Duration::from_millis(10));
    if has_action(cfg, "axe") || has_action(cfg, "stun") {
      self.run_shield_stun_fixed(&axe, dc);
      thread::sleep(Duration::from_millis(8));
    }
    if has_action(cfg, "sword") {
      self.tap_action_str(&sword, SLOT_HOLD_MS);
    }
  }

  fn run_ls(&self, cfg: &Value) {
    let sword = value_text(cfg, "swordKey", "1");
    let spear = value_text(cfg, "spearKey", "3");

    self.ensure_focus_target();
    thread::sleep(Duration::from_millis(2));
    if has_action(cfg, "sword1") {
      self.tap_action_str(&sword, SLOT_HOLD_MS);
    }
    if has_action(cfg, "spear") {
      self.slot_lclick(&spear);
      thread::sleep(Duration::from_millis(8));
    }
    if has_action(cfg, "sword2") {
      self.tap_action_str(&sword, SLOT_HOLD_MS);
      thread::sleep(Duration::from_millis(4));
      self.tap_action_str(&sword, SLOT_HOLD_MS);
    }
  }

  fn run_es(&self, cfg: &Value) {
    let delay = value_u64(cfg, "delay", 50);
    let elytra = value_text(cfg, "elytraKey", "5");
    let return_key = value_text(cfg, "returnKey", "1");

    thread::sleep(Duration::from_millis(30));
    self.ensure_focus_target();
    if has_action(cfg, "equip") {
      self.tap_action_str(&elytra, SLOT_HOLD_MS);
      thread::sleep(Duration::from_millis(delay));
      self.click_action(self.right_click_action(), CLICK_HOLD_MS);
      thread::sleep(Duration::from_millis(delay.max(12)));
    }
    if has_action(cfg, "return") {
      self.tap_action_str(&return_key, SLOT_HOLD_MS);
    }
  }

  fn run_pc(&self, cfg: &Value) {
    let delay = value_u64(cfg, "delay", 50);
    let pearl = value_text(cfg, "pearlKey", "6");
    let wind = value_text(cfg, "windChargeKey", "7");

    thread::sleep(Duration::from_millis(30));
    self.ensure_focus_target();
    if has_action(cfg, "pearl") {
      self.tap_action_str(&pearl, KEY_HOLD_MS);
      self.click_action(self.right_click_action(), CLICK_HOLD_MS);
      thread::sleep(Duration::from_millis(delay));
    }
    if has_action(cfg, "wind") {
      self.tap_action_str(&wind, KEY_HOLD_MS);
      self.click_action(self.right_click_action(), CLICK_HOLD_MS);
    }
  }

  fn run_ss(&self, cfg: &Value) {
    let axe  = value_text(cfg, "axeKey", "2");
    let mace = value_text(cfg, "maceKey", "3");

    let do_axe  = has_action(cfg, "axe");
    let do_mace = has_action(cfg, "mace");

    // Reuse run_shield_stun_fixed exactly as ASB and SW do — proven consistent.
    if do_axe {
      self.run_shield_stun_fixed(&axe, 8);
    }

    if do_mace {
      let left = self.left_click_action();
      thread::sleep(Duration::from_millis(10));
      self.slot_lclick(&mace);
      thread::sleep(Duration::from_millis(8));
      self.click_action(left, CLICK_HOLD_MS);
      thread::sleep(Duration::from_millis(8));
      self.click_action(left, CLICK_HOLD_MS);
    }
  }

  fn run_sw(&self, cfg: &Value) {
    let delay = value_u64(cfg, "delay", 90);
    let axe = value_text(cfg, "axeKey", "2");
    let cobweb = value_text(cfg, "cobwebKey", "9");
    let dc = value_u64(cfg, "doubleClickMs", 8).min(100);

    if has_action(cfg, "stun") {
      thread::sleep(Duration::from_millis(10));
      self.run_shield_stun_fixed(&axe, dc);
      thread::sleep(Duration::from_millis(delay));
    }
    if has_action(cfg, "web") {
      self.tap_action_str(&cobweb, SLOT_HOLD_MS);
      thread::sleep(Duration::from_millis(delay.clamp(8, 25)));
      self.click_mouse_fixed(MouseButton::Right, CLICK_HOLD_MS);
    }
  }

  fn run_bs(&self, cfg: &Value) {
    let delay = value_u64(cfg, "delay", 25);
    let mace = value_text(cfg, "maceKey", "3");
    let sword = value_text(cfg, "swordKey", "1");

    self.ensure_focus_target();
    thread::sleep(Duration::from_millis(2));
    if has_action(cfg, "mace") {
      self.slot_lclick(&mace);
      thread::sleep(Duration::from_millis(delay));
    }
    if has_action(cfg, "sword") {
      self.tap_action_str(&sword, SLOT_HOLD_MS);
    }
  }

  fn run_kbd(&self, cfg: &Value, direction: i32) {
    // direction: -1 = left flick, +1 = right flick
    let flick_px  = value_u64(cfg, "flickPx", 1500) as i32;
    let hold_ms   = value_u64(cfg, "holdMs", 50);
    let dx = flick_px * direction;

    self.ensure_focus_target();

    // Flick in direction
    #[cfg(target_os = "windows")]
    {
      use windows_sys::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_MOVE;
      let _ = send_mouse(MOUSEEVENTF_MOVE, 0, dx, 0);
    }

    // Hold long enough for server to register the angle change
    thread::sleep(Duration::from_millis(hold_ms));

    // Hit the player
    self.click_mouse_fixed(MouseButton::Left, CLICK_HOLD_MS);

    // Snap back instantly
    #[cfg(target_os = "windows")]
    {
      use windows_sys::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_MOVE;
      let _ = send_mouse(MOUSEEVENTF_MOVE, 0, -dx, 0);
    }
  }

  fn run_ic(&self, cfg: &Value) {
    let delay = value_u64(cfg, "delay", 50);
    let hold = value_u64(cfg, "bowHoldMs", 150).max(50);
    let rail = value_text(cfg, "railKey", "5");
    let bow = value_text(cfg, "bowKey", "4");
    let cart = value_text(cfg, "cartKey", "6");

    self.ensure_focus_target();
    self.tap_action_str(&rail, KEY_HOLD_MS);
    thread::sleep(Duration::from_millis(delay));
    self.click_action(self.right_click_action(), CLICK_HOLD_MS);
    thread::sleep(Duration::from_millis(delay));
    self.tap_action_str(&bow, KEY_HOLD_MS);
    thread::sleep(Duration::from_millis(delay));
    self.toggle_action(ActionKey::Mouse(MouseButton::Right), true);
    thread::sleep(Duration::from_millis(hold));
    self.toggle_action(ActionKey::Mouse(MouseButton::Right), false);
    thread::sleep(Duration::from_millis(delay));
    self.tap_action_str(&cart, KEY_HOLD_MS);
    self.click_action(self.right_click_action(), CLICK_HOLD_MS);
  }

  fn run_xb(&self, cfg: &Value) {
    let delay = value_u64(cfg, "delay", 50);
    let rail = value_text(cfg, "railKey", "5");
    let cart = value_text(cfg, "cartKey", "6");
    let fns = value_text(cfg, "fnsKey", "7");
    let crossbow = value_text(cfg, "crossbowKey", "4");

    self.ensure_focus_target();
    self.tap_action_str(&rail, KEY_HOLD_MS);
    thread::sleep(Duration::from_millis(delay));
    self.click_action(self.right_click_action(), CLICK_HOLD_MS);
    thread::sleep(Duration::from_millis(delay));
    self.tap_action_str(&cart, KEY_HOLD_MS);
    thread::sleep(Duration::from_millis(delay));
    self.click_action(self.right_click_action(), CLICK_HOLD_MS);
    thread::sleep(Duration::from_millis(delay));
    self.tap_action_str(&fns, KEY_HOLD_MS);
    thread::sleep(Duration::from_millis(delay));
    self.click_action(self.right_click_action(), CLICK_HOLD_MS);
    thread::sleep(Duration::from_millis(delay));
    self.tap_action_str(&crossbow, KEY_HOLD_MS);
    thread::sleep(Duration::from_millis(delay));
    self.click_action(self.right_click_action(), CLICK_HOLD_MS);
  }

  fn run_dr(&self, cfg: &Value) {
    let delay = value_u64(cfg, "delay", 30);
    let bucket = value_text(cfg, "bucketKey", "7");

    self.ensure_focus_target();
    self.tap_action_str(&bucket, KEY_HOLD_MS);
    thread::sleep(Duration::from_millis(delay));
    self.click_action(self.right_click_action(), CLICK_HOLD_MS);
  }

  fn run_lw(&self, cfg: &Value) {
    let delay = value_u64(cfg, "delay", 30);
    let lava = value_text(cfg, "lavaKey", "8");
    let cobweb = value_text(cfg, "cobwebKey", "9");

    self.ensure_focus_target();
    self.tap_action_str(&lava, KEY_HOLD_MS);
    thread::sleep(Duration::from_millis(delay));
    self.click_action(self.right_click_action(), CLICK_HOLD_MS);
    thread::sleep(Duration::from_millis(delay));
    self.click_action(self.right_click_action(), CLICK_HOLD_MS);
    thread::sleep(Duration::from_millis(delay));
    self.tap_action_str(&cobweb, KEY_HOLD_MS);
    thread::sleep(Duration::from_millis(delay));
    self.click_action(self.right_click_action(), CLICK_HOLD_MS);
  }

  fn run_la(&self, cfg: &Value) {
    let delay = value_u64(cfg, "delay", 30);
    let lava = value_text(cfg, "lavaKey", "8");

    self.ensure_focus_target();
    self.tap_action_str(&lava, KEY_HOLD_MS);
    thread::sleep(Duration::from_millis(delay));
    self.click_action(self.right_click_action(), CLICK_HOLD_MS);
  }

  fn run_recorded(&self, _id: &str, cfg: &Value) {
    let events = cfg
      .get("sequence")
      .and_then(Value::as_array)
      .cloned()
      .unwrap_or_default();
    let gap = value_u64(cfg, "stepMs", 35);

    if events.is_empty() {
      return;
    }

    self.ensure_focus_target();
    thread::sleep(Duration::from_millis(2));

    for event in events {
      let event_start = std::time::Instant::now();

      if let Some(kind) = event.get("type").and_then(Value::as_str) {
        match kind {
          "move" => {
            let dx = value_i32(&event, "dx", 0);
            let dy = value_i32(&event, "dy", 0);
            let _ = move_mouse_relative(dx, dy);
          }
          "wheel" => {
            let amount = if value_i32(&event, "amount", 1) < 0 { -1 } else { 1 };
            let _ = scroll_wheel(amount);
          }
          _ => {
            self.play_recorded_press(&event);
          }
        }
      } else {
        self.play_recorded_press(&event);
      }

      let elapsed_ms = event_start.elapsed().as_millis() as u64;
      if gap > elapsed_ms {
        thread::sleep(Duration::from_millis(gap - elapsed_ms));
      }
    }
  }

  fn play_recorded_press(&self, event: &Value) {
    let Some(raw_code) = event.get("code").and_then(Value::as_str) else {
      return;
    };

    let code = match raw_code {
      "Mouse1" => self.click_binds().left,
      "Mouse2" => self.click_binds().right,
      other => other.to_string(),
    };

    let hold = if matches!(code.as_str(), "Mouse1" | "Mouse2" | "Mouse3" | "Mouse4" | "Mouse5") {
      CLICK_HOLD_MS
    } else {
      KEY_HOLD_MS
    };

    self.tap_action_str(&code, hold);
  }

  fn run_shield_stun_fixed(&self, axe_key: &str, double_click_ms: u64) {
    let dc = double_click_ms.min(100);
    self.ensure_focus_target();
    thread::sleep(Duration::from_millis(2));
    self.slot_lclick(axe_key);
    thread::sleep(Duration::from_millis(dc));
    self.click_action(self.left_click_action(), 6);
  }
}

fn normalize_bind(raw: Option<&str>) -> Option<String> {
  let value = raw?.trim();
  if value.is_empty() {
    return None;
  }
  Some(value.to_string())
}

fn value_text(cfg: &Value, key: &str, default: &str) -> String {
  cfg
    .get(key)
    .and_then(Value::as_str)
    .map(|value| value.trim())
    .filter(|value| !value.is_empty())
    .unwrap_or(default)
    .to_string()
}

/// Look up a slot key from the centralised `slotKeys` section first,
/// falling back to the per-macro field, then to `default`.
fn slot_key(cfg: &Value, gamemode: &str, key: &str, default: &str) -> String {
  // Try centralised: cfg.slotKeys.<gamemode>.<key>
  if let Some(val) = cfg
    .get("slotKeys")
    .and_then(|sk| sk.get(gamemode))
    .and_then(|gm| gm.get(key))
    .and_then(Value::as_str)
    .map(|s| s.trim())
    .filter(|s| !s.is_empty())
  {
    return val.to_string();
  }
  // Fallback to per-macro field
  value_text(cfg, key, default)
}

fn value_u64(cfg: &Value, key: &str, default: u64) -> u64 {
  if let Some(value) = cfg.get(key) {
    if let Some(text) = value.as_str() {
      return text.trim().parse::<u64>().unwrap_or(default);
    }
    if let Some(number) = value.as_u64() {
      return number;
    }
    if let Some(number) = value.as_i64() {
      return number.max(0) as u64;
    }
  }
  default
}

fn value_i32(cfg: &Value, key: &str, default: i32) -> i32 {
  if let Some(value) = cfg.get(key) {
    if let Some(text) = value.as_str() {
      return text.trim().parse::<i32>().unwrap_or(default);
    }
    if let Some(number) = value.as_i64() {
      return number as i32;
    }
    if let Some(number) = value.as_u64() {
      return number as i32;
    }
  }
  default
}

fn fallback_totem_key(cfg: &Value) -> String {
  let key = value_text(cfg, "totemKey", "");
  if !key.is_empty() && !key.eq_ignore_ascii_case("none") {
    return key;
  }
  cfg.get("explodeKey")
    .and_then(Value::as_str)
    .filter(|v| !v.trim().is_empty())
    .map(|v| v.to_string())
    .unwrap_or_else(|| "9".to_string())
}

fn has_action(cfg: &Value, action: &str) -> bool {
  match cfg.get("actions").and_then(Value::as_array) {
    None => true,
    Some(arr) if arr.is_empty() => true,
    Some(arr) => arr.iter().any(|v| {
      v.as_str().map(|s| s.eq_ignore_ascii_case(action)).unwrap_or(false)
    }),
  }
}

fn sa_actions(cfg: &Value) -> Vec<&'static str> {
  let order = ["place", "charge", "explode"];
  let normalized = cfg
    .get("actions")
    .and_then(Value::as_array)
    .map(|items| {
      items
        .iter()
        .filter_map(Value::as_str)
        .map(|value| value.trim().to_lowercase())
        .filter(|value| order.contains(&value.as_str()))
        .collect::<Vec<_>>()
    })
    .unwrap_or_default();

  if normalized.is_empty() {
    return order.to_vec();
  }

  order
    .iter()
    .copied()
    .filter(|step| normalized.iter().any(|value| value == step))
    .collect()
}

fn parse_action_key(raw: &str) -> Option<ActionKey> {
  match raw.trim() {
    "Mouse1" => Some(ActionKey::Mouse(MouseButton::Left)),
    "Mouse2" => Some(ActionKey::Mouse(MouseButton::Right)),
    "Mouse3" => Some(ActionKey::Mouse(MouseButton::Middle)),
    "Mouse4" => Some(ActionKey::Mouse(MouseButton::X1)),
    "Mouse5" => Some(ActionKey::Mouse(MouseButton::X2)),
    other => code_to_vks(other)
      .and_then(|values| values.into_iter().next())
      .map(|vk| ActionKey::Keyboard(vk as u16)),
  }
}

fn wait_or_stop(rx: &mpsc::Receiver<()>, duration: Duration) -> bool {
  match rx.recv_timeout(duration) {
    Ok(_) | Err(mpsc::RecvTimeoutError::Disconnected) => true,
    Err(mpsc::RecvTimeoutError::Timeout) => false,
  }
}

#[cfg(target_os = "windows")]
/// Atomically sends [KeyDown, MouseDown, MouseUp, KeyUp] in a single SendInput batch.
/// Because GLFW drains the full OS message queue each frame, MC processes all four
/// events in order within one frame — slot switch guaranteed before the attack click.
#[cfg(target_os = "windows")]
fn slot_click_batch(vk_code: u16, button: MouseButton) -> Result<(), String> {
  use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE,
    KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, MAPVK_VK_TO_VSC, MOUSEINPUT,
  };

  let scan_code = unsafe { MapVirtualKeyW(vk_code as u32, MAPVK_VK_TO_VSC) };
  if scan_code == 0 {
    return Err(format!("MapVirtualKeyW failed for vk {vk_code}"));
  }

  let (down_flags, down_data) = mouse_input(button, true);
  let (up_flags, up_data) = mouse_input(button, false);

  let key_down = INPUT {
    r#type: INPUT_KEYBOARD,
    Anonymous: INPUT_0 {
      ki: KEYBDINPUT { wVk: 0, wScan: scan_code as u16, dwFlags: KEYEVENTF_SCANCODE, time: 0, dwExtraInfo: 0 },
    },
  };
  let key_up = INPUT {
    r#type: INPUT_KEYBOARD,
    Anonymous: INPUT_0 {
      ki: KEYBDINPUT { wVk: 0, wScan: scan_code as u16, dwFlags: KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0 },
    },
  };
  let mouse_down = INPUT {
    r#type: INPUT_MOUSE,
    Anonymous: INPUT_0 {
      mi: MOUSEINPUT { dx: 0, dy: 0, mouseData: down_data, dwFlags: down_flags, time: 0, dwExtraInfo: 0 },
    },
  };
  let mouse_up = INPUT {
    r#type: INPUT_MOUSE,
    Anonymous: INPUT_0 {
      mi: MOUSEINPUT { dx: 0, dy: 0, mouseData: up_data, dwFlags: up_flags, time: 0, dwExtraInfo: 0 },
    },
  };

  let mut inputs = [key_down, mouse_down, mouse_up, key_up];
  let sent = unsafe { SendInput(inputs.len() as u32, inputs.as_mut_ptr(), std::mem::size_of::<INPUT>() as i32) };
  if sent != inputs.len() as u32 {
    return Err("slot_click_batch SendInput failed".to_string());
  }
  Ok(())
}

#[cfg(not(target_os = "windows"))]
fn slot_click_batch(_vk_code: u16, _button: MouseButton) -> Result<(), String> { Ok(()) }

/// Attribute swap in one tick: [SpearDown, AxeDown, MouseDown, MouseUp, AxeUp, SpearUp].
/// MC processes spear→axe slot switch then fires the attack, all in the same frame.
/// The spear's reach attribute carries over to the axe hit.
#[cfg(target_os = "windows")]
fn attr_swap_click_batch(spear_vk: u16, axe_vk: u16, button: MouseButton) -> Result<(), String> {
  use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE,
    KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, MAPVK_VK_TO_VSC, MOUSEINPUT,
  };

  let spear_sc = unsafe { MapVirtualKeyW(spear_vk as u32, MAPVK_VK_TO_VSC) };
  let axe_sc   = unsafe { MapVirtualKeyW(axe_vk   as u32, MAPVK_VK_TO_VSC) };
  if spear_sc == 0 || axe_sc == 0 {
    return Err("MapVirtualKeyW failed for spear or axe vk".to_string());
  }

  let (mouse_dn_flags, mouse_dn_data) = mouse_input(button, true);
  let (mouse_up_flags, mouse_up_data) = mouse_input(button, false);

  macro_rules! kb {
    ($sc:expr, $up:expr) => {
      INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
          ki: KEYBDINPUT {
            wVk: 0,
            wScan: $sc as u16,
            dwFlags: KEYEVENTF_SCANCODE | if $up { KEYEVENTF_KEYUP } else { 0 },
            time: 0,
            dwExtraInfo: 0,
          },
        },
      }
    };
  }
  macro_rules! mb {
    ($flags:expr, $data:expr) => {
      INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
          mi: MOUSEINPUT { dx: 0, dy: 0, mouseData: $data, dwFlags: $flags, time: 0, dwExtraInfo: 0 },
        },
      }
    };
  }

  let mut inputs = [
    kb!(spear_sc, false), // spear DOWN
    kb!(axe_sc,   false), // axe   DOWN  → attribute swap happens
    mb!(mouse_dn_flags, mouse_dn_data), // LMB DOWN → attack with axe + spear attr
    mb!(mouse_up_flags, mouse_up_data), // LMB UP
    kb!(axe_sc,   true),  // axe   UP
    kb!(spear_sc, true),  // spear UP
  ];

  let sent = unsafe { SendInput(inputs.len() as u32, inputs.as_mut_ptr(), std::mem::size_of::<INPUT>() as i32) };
  if sent != inputs.len() as u32 {
    return Err("attr_swap_click_batch SendInput failed".to_string());
  }
  Ok(())
}

#[cfg(not(target_os = "windows"))]
fn attr_swap_click_batch(_spear_vk: u16, _axe_vk: u16, _button: MouseButton) -> Result<(), String> { Ok(()) }

fn send_keyboard(vk_code: u16, key_up: bool) -> Result<(), String> {
  use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE,
    MAPVK_VK_TO_VSC,
  };

  let scan_code = unsafe { MapVirtualKeyW(vk_code as u32, MAPVK_VK_TO_VSC) };
  if scan_code == 0 {
    return Err(format!("MapVirtualKeyW failed for vk {vk_code}"));
  }

  let mut input = [INPUT {
    r#type: INPUT_KEYBOARD,
    Anonymous: INPUT_0 {
      ki: KEYBDINPUT {
        wVk: 0,
        wScan: scan_code as u16,
        dwFlags: KEYEVENTF_SCANCODE | if key_up { KEYEVENTF_KEYUP } else { 0 },
        time: 0,
        dwExtraInfo: 0,
      },
    },
  }];

  let sent = unsafe {
    SendInput(
      input.len() as u32,
      input.as_mut_ptr(),
      std::mem::size_of::<INPUT>() as i32,
    )
  };

  if sent != input.len() as u32 {
    return Err("SendInput keyboard event failed".to_string());
  }

  Ok(())
}

#[cfg(target_os = "windows")]
fn tap_keyboard(vk_code: u16, hold_ms: u64) -> Result<(), String> {
  send_keyboard(vk_code, false)?;
  thread::sleep(Duration::from_millis(hold_ms));
  send_keyboard(vk_code, true)
}

#[cfg(target_os = "windows")]
fn toggle_keyboard(vk_code: u16, is_down: bool) -> Result<(), String> {
  send_keyboard(vk_code, !is_down)
}

#[cfg(target_os = "windows")]
fn mouse_input(button: MouseButton, is_down: bool) -> (u32, u32) {
  use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTDOWN,
    MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP,
  };

  match (button, is_down) {
    (MouseButton::Left, true) => (MOUSEEVENTF_LEFTDOWN, 0),
    (MouseButton::Left, false) => (MOUSEEVENTF_LEFTUP, 0),
    (MouseButton::Right, true) => (MOUSEEVENTF_RIGHTDOWN, 0),
    (MouseButton::Right, false) => (MOUSEEVENTF_RIGHTUP, 0),
    (MouseButton::Middle, true) => (MOUSEEVENTF_MIDDLEDOWN, 0),
    (MouseButton::Middle, false) => (MOUSEEVENTF_MIDDLEUP, 0),
    (MouseButton::X1, true) => (MOUSEEVENTF_XDOWN, XBUTTON1_DATA),
    (MouseButton::X1, false) => (MOUSEEVENTF_XUP, XBUTTON1_DATA),
    (MouseButton::X2, true) => (MOUSEEVENTF_XDOWN, XBUTTON2_DATA),
    (MouseButton::X2, false) => (MOUSEEVENTF_XUP, XBUTTON2_DATA),
  }
}

#[cfg(target_os = "windows")]
fn send_mouse(flags: u32, data: u32, dx: i32, dy: i32) -> Result<(), String> {
  use windows_sys::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEINPUT};

  let mut input = [INPUT {
    r#type: INPUT_MOUSE,
    Anonymous: INPUT_0 {
      mi: MOUSEINPUT {
        dx,
        dy,
        mouseData: data,
        dwFlags: flags,
        time: 0,
        dwExtraInfo: 0,
      },
    },
  }];

  let sent = unsafe {
    SendInput(
      input.len() as u32,
      input.as_mut_ptr(),
      std::mem::size_of::<INPUT>() as i32,
    )
  };

  if sent != input.len() as u32 {
    return Err("SendInput mouse event failed".to_string());
  }

  Ok(())
}

#[cfg(target_os = "windows")]
fn toggle_mouse(button: MouseButton, is_down: bool) -> Result<(), String> {
  let (flags, data) = mouse_input(button, is_down);
  send_mouse(flags, data, 0, 0)
}

#[cfg(target_os = "windows")]
fn is_mouse_physically_held(button: &MouseButton) -> bool {
  use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
  let vk: i32 = match button {
    MouseButton::Left   => 0x01, // VK_LBUTTON
    MouseButton::Right  => 0x02, // VK_RBUTTON
    MouseButton::Middle => 0x04, // VK_MBUTTON
    MouseButton::X1     => 0x05, // VK_XBUTTON1
    MouseButton::X2     => 0x06, // VK_XBUTTON2
  };
  // High bit set = key is physically down
  (unsafe { GetAsyncKeyState(vk) } as u16) & 0x8000 != 0
}

#[cfg(target_os = "windows")]
fn click_mouse(button: MouseButton, hold_ms: u64) -> Result<(), String> {
  toggle_mouse(button, true)?;
  thread::sleep(Duration::from_millis(hold_ms));
  toggle_mouse(button, false)
}

/// Like click_mouse but avoids releasing a physically-held button at the end.
/// Used by crystal macros where the user holds LMB/RMB continuously.
#[cfg(target_os = "windows")]
fn click_mouse_held_safe(button: MouseButton, hold_ms: u64) -> Result<(), String> {
  let physically_held = is_mouse_physically_held(&button);
  if physically_held {
    // Send UP+DOWN to register a fresh attack event without permanently releasing
    toggle_mouse(button, false)?;
    thread::sleep(Duration::from_millis(4));
  }
  toggle_mouse(button, true)?;
  thread::sleep(Duration::from_millis(hold_ms));
  if !physically_held {
    toggle_mouse(button, false)?;
  }
  Ok(())
}

#[cfg(target_os = "windows")]
fn move_mouse_relative(dx: i32, dy: i32) -> Result<(), String> {
  use windows_sys::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_MOVE;
  if dx == 0 && dy == 0 {
    return Ok(());
  }
  send_mouse(MOUSEEVENTF_MOVE, 0, dx, dy)
}

#[cfg(target_os = "windows")]
fn scroll_wheel(amount: i32) -> Result<(), String> {
  use windows_sys::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_WHEEL;
  send_mouse(MOUSEEVENTF_WHEEL, (amount * WHEEL_DELTA) as u32, 0, 0)
}

#[cfg(target_os = "windows")]
fn get_fg_hwnd() -> isize {
  unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow() as isize }
}

#[cfg(not(target_os = "windows"))]
fn get_fg_hwnd() -> isize {
  0
}

// ─── Triggerbot pixel scan ───────────────────────────────────────────────────
// Direct GetPixel calls on the desktop DC — no BitBlt, no intermediate bitmap.
// GetWindowInfo.rcClient gives client rect in screen coords (no title-bar math).
// Scans a 5×5 grid at the crosshair center plus cross-shaped arms at ±8px.
// COLORREF from GetPixel: 0x00BBGGRR (R in low byte).

const TB_TOLERANCE: u32 = 130;  // Manhattan distance from pure red/blue

#[cfg(target_os = "windows")]
fn tb_scan_center(hwnd: isize, mode: &str) -> bool {
  use windows_sys::Win32::{
    Foundation::HWND,
    Graphics::Gdi::{GetDC, GetPixel, ReleaseDC},
    UI::WindowsAndMessaging::{GetWindowInfo, WINDOWINFO},
  };

  if hwnd == 0 { return false; }
  let hwnd_val = hwnd as HWND;

  // GetWindowInfo.rcClient = client area in SCREEN coordinates.
  let mut wi: WINDOWINFO = unsafe { std::mem::zeroed() };
  wi.cbSize = std::mem::size_of::<WINDOWINFO>() as u32;
  if unsafe { GetWindowInfo(hwnd_val, &mut wi) } == 0 { return false; }
  let cw = wi.rcClient.right  - wi.rcClient.left;
  let ch = wi.rcClient.bottom - wi.rcClient.top;
  if cw <= 0 || ch <= 0 { return false; }
  let cx = wi.rcClient.left + cw / 2;
  let cy = wi.rcClient.top  + ch / 2;

  let desk_dc = unsafe { GetDC(0 as HWND) };
  if desk_dc.is_null() { return false; }

  let mut found = false;

  // Scan 5×5 block at center + cross arms at ±6 and ±10 pixels out.
  // Minecraft crosshair is a small "+" rendered at exact center.
  'scan: for dy in -2i32..=2i32 {
    for dx in -2i32..=2i32 {
      for &(ox, oy) in &[(0i32, 0i32), (-6, 0), (6, 0), (0, -6), (0, 6),
                                        (-10, 0), (10, 0), (0, -10), (0, 10)] {
        let raw = unsafe { GetPixel(desk_dc, cx + dx + ox, cy + dy + oy) };
        if raw == 0xFFFF_FFFF { continue; }
        let r = (raw         & 0xFF) as u32;
        let g = ((raw >>  8) & 0xFF) as u32;
        let b = ((raw >> 16) & 0xFF) as u32;
        let red_dist  = (255u32.saturating_sub(r)) + g + b;
        let blue_dist = r + g + (255u32.saturating_sub(b));
        let is_red  = r > 100 && red_dist  < TB_TOLERANCE;
        let is_blue = b > 100 && blue_dist < TB_TOLERANCE;
        let hit = match mode { "smart-crit" => is_blue, _ => is_red || is_blue };
        if hit { found = true; break 'scan; }
      }
    }
  }

  unsafe { ReleaseDC(0 as HWND, desk_dc) };
  found
}

#[cfg(not(target_os = "windows"))]
fn tb_scan_center(_hwnd: isize, _mode: &str) -> bool {
  false
}

// Keep this stub for any other code that references it.
#[cfg(not(target_os = "windows"))]
fn sample_crosshair_pixel(_hwnd: isize) -> Option<(u8, u8, u8)> {
  None
}

#[cfg(not(target_os = "windows"))]
fn tap_keyboard(_vk_code: u16, _hold_ms: u64) -> Result<(), String> {
  Ok(())
}

#[cfg(not(target_os = "windows"))]
fn toggle_keyboard(_vk_code: u16, _is_down: bool) -> Result<(), String> {
  Ok(())
}

#[cfg(not(target_os = "windows"))]
fn toggle_mouse(_button: MouseButton, _is_down: bool) -> Result<(), String> {
  Ok(())
}

#[cfg(not(target_os = "windows"))]
fn click_mouse(_button: MouseButton, _hold_ms: u64) -> Result<(), String> {
  Ok(())
}

#[cfg(not(target_os = "windows"))]
fn move_mouse_relative(_dx: i32, _dy: i32) -> Result<(), String> {
  Ok(())
}

#[cfg(not(target_os = "windows"))]
fn scroll_wheel(_amount: i32) -> Result<(), String> {
  Ok(())
}
