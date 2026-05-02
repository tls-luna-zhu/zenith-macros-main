use crate::{
  binds::{
    matching_press_triggers, matching_release_triggers, modifiers_from_pressed, vk_to_code, MacroBinding, ModifierPayload,
  },
  macro_runtime,
};
use serde::Serialize;
use std::{
  collections::HashSet,
  sync::{
    atomic::AtomicBool,
    mpsc, Arc, Mutex, OnceLock, RwLock,
  },
  thread::{self, JoinHandle},
  time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "windows")]
use windows_sys::Win32::{
  Foundation::{LPARAM, LRESULT, WPARAM},
  System::Threading::GetCurrentThreadId,
  UI::{
    WindowsAndMessaging::{
      CallNextHookEx, DispatchMessageW, GetMessageW, KBDLLHOOKSTRUCT, LLKHF_INJECTED, LLKHF_LOWER_IL_INJECTED,
      MSLLHOOKSTRUCT, MSG, PostThreadMessageW, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx,
      WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_LBUTTONUP,
      WM_MBUTTONDOWN, WM_MBUTTONUP, WM_QUIT, WM_RBUTTONDOWN, WM_RBUTTONUP,
      WM_SYSKEYDOWN, WM_SYSKEYUP, WM_XBUTTONDOWN, WM_XBUTTONUP,
    },
  },
};

pub type SharedBindings = Arc<RwLock<Vec<MacroBinding>>>;
pub type SharedStealthState = Arc<AtomicBool>;
/// VK code of the user-configured chat key (0 = disabled/None).
pub type SharedChatVk = Arc<std::sync::atomic::AtomicU32>;

#[derive(Clone, Debug, Default)]
pub struct AppHotkeys {
  pub panic: Option<MacroBinding>,
  pub stealth: Option<MacroBinding>,
}

pub type SharedAppHotkeys = Arc<RwLock<AppHotkeys>>;

#[derive(Clone, Copy, Debug)]
struct RawKeyEvent {
  message: u32,
  vk_code: u32,
  scan_code: u32,
  timestamp_ms: i64,
}

#[derive(Clone, Copy, Debug)]
struct RawMouseEvent {
  /// "Mouse1"–"Mouse5" button code
  button_code: &'static str,
  is_down: bool,
  timestamp_ms: i64,
}

fn mouse_sender_cell() -> &'static Mutex<Option<mpsc::SyncSender<RawMouseEvent>>> {
  static CELL: OnceLock<Mutex<Option<mpsc::SyncSender<RawMouseEvent>>>> = OnceLock::new();
  CELL.get_or_init(|| Mutex::new(None))
}

fn replace_mouse_sender(sender: Option<mpsc::SyncSender<RawMouseEvent>>) {
  if let Ok(mut guard) = mouse_sender_cell().lock() {
    *guard = sender;
  }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MacroKeyEventPayload {
  pub code: String,
  pub vk_code: u32,
  pub scan_code: u32,
  pub modifiers: ModifierPayload,
  pub timestamp_ms: i64,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub repeat: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MacroTriggerPayload {
  pub id: String,
  pub keybind: String,
  pub action: String,
  pub code: String,
  pub modifiers: ModifierPayload,
  pub timestamp_ms: i64,
}

fn now_ms() -> i64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as i64)
    .unwrap_or(0)
}

fn emit_to_main<T: Serialize>(app: &AppHandle, event_name: &str, payload: &T) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.emit(event_name, payload);
  }
}

fn key_code_or_fallback(vk_code: u32) -> String {
  vk_to_code(vk_code).unwrap_or_else(|| format!("VK_{vk_code:X}"))
}

fn is_key_down(message: u32) -> bool {
  #[cfg(target_os = "windows")]
  {
    matches!(message, WM_KEYDOWN | WM_SYSKEYDOWN)
  }

  #[cfg(not(target_os = "windows"))]
  {
    let _ = message;
    false
  }
}

fn is_key_up(message: u32) -> bool {
  #[cfg(target_os = "windows")]
  {
    matches!(message, WM_KEYUP | WM_SYSKEYUP)
  }

  #[cfg(not(target_os = "windows"))]
  {
    let _ = message;
    false
  }
}

fn sender_cell() -> &'static Mutex<Option<mpsc::SyncSender<RawKeyEvent>>> {
  static CELL: OnceLock<Mutex<Option<mpsc::SyncSender<RawKeyEvent>>>> = OnceLock::new();
  CELL.get_or_init(|| Mutex::new(None))
}

fn replace_sender(sender: Option<mpsc::SyncSender<RawKeyEvent>>) {
  if let Ok(mut guard) = sender_cell().lock() {
    *guard = sender;
  }
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn keyboard_hook_proc(n_code: i32, w_param: WPARAM, l_param: LPARAM) -> LRESULT {
  if n_code >= 0 {
    let data = &*(l_param as *const KBDLLHOOKSTRUCT);
    let injected = (data.flags & LLKHF_INJECTED) != 0 || (data.flags & LLKHF_LOWER_IL_INJECTED) != 0;

    if !injected {
      if let Ok(guard) = sender_cell().lock() {
        if let Some(sender) = guard.as_ref() {
          let _ = sender.try_send(RawKeyEvent {
            message: w_param as u32,
            vk_code: data.vkCode,
            scan_code: data.scanCode,
            timestamp_ms: now_ms(),
          });
        }
      }
    }
  }

  CallNextHookEx(std::ptr::null_mut(), n_code, w_param, l_param)
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn mouse_hook_proc(n_code: i32, w_param: WPARAM, l_param: LPARAM) -> LRESULT {
  if n_code >= 0 {
    let data = &*(l_param as *const MSLLHOOKSTRUCT);
    // Only fire on physical mouse clicks (not injected)
    let injected = (data.flags & 0x1) != 0;
    if !injected {
      let msg = w_param as u32;
      let btn: Option<(&'static str, bool)> = match msg {
        WM_LBUTTONDOWN => Some(("Mouse1", true)),
        WM_LBUTTONUP   => Some(("Mouse1", false)),
        WM_RBUTTONDOWN => Some(("Mouse2", true)),
        WM_RBUTTONUP   => Some(("Mouse2", false)),
        WM_MBUTTONDOWN => Some(("Mouse3", true)),
        WM_MBUTTONUP   => Some(("Mouse3", false)),
        WM_XBUTTONDOWN | WM_XBUTTONUP => {
          let hi = (data.mouseData >> 16) as u16;
          let code = if hi == 1 { "Mouse4" } else { "Mouse5" };
          let is_down = msg == WM_XBUTTONDOWN;
          Some((code, is_down))
        }
        _ => None,
      };
      if let Some((code, is_down)) = btn {
        if let Ok(guard) = mouse_sender_cell().lock() {
          if let Some(sender) = guard.as_ref() {
            let _ = sender.try_send(RawMouseEvent { button_code: code, is_down, timestamp_ms: now_ms() });
          }
        }
      }
    }
  }
  CallNextHookEx(std::ptr::null_mut(), n_code, w_param, l_param)
}

fn spawn_worker(
  app: AppHandle,
  bindings: SharedBindings,
  hotkeys: SharedAppHotkeys,
  stealth_active: SharedStealthState,
  macro_runtime: macro_runtime::SharedMacroRuntime,
  chat_vk: SharedChatVk,
  chat_paused: macro_runtime::SharedChatPaused,
  rx: mpsc::Receiver<RawKeyEvent>,
) -> JoinHandle<()> {
  use std::sync::atomic::Ordering;
  // VK_OEM_2 = 0xBF = slash — always opens command chat in Minecraft.
  // VK_ESCAPE = 0x1B — closes chat.
  const VK_SLASH: u32 = 0xBF;
  const VK_ESCAPE: u32 = 0x1B;

  thread::spawn(move || {
    let mut pressed = HashSet::<u32>::new();

    while let Ok(raw) = rx.recv() {
      let code = key_code_or_fallback(raw.vk_code);
      let is_down = is_key_down(raw.message);
      let is_up = is_key_up(raw.message);

      if !is_down && !is_up {
        continue;
      }

      let repeat = is_down && pressed.contains(&raw.vk_code);

      if is_down {
        pressed.insert(raw.vk_code);
      } else {
        pressed.remove(&raw.vk_code);
      }

      let modifiers = modifiers_from_pressed(&pressed);

      // ── Chat-pause intercept ──────────────────────────────────────────────
      // Must happen BEFORE macro triggers so chat key can't fire a macro.
      if is_down && !repeat {
        let configured_vk = chat_vk.load(Ordering::Relaxed);
        let is_chat_key = configured_vk != 0 && raw.vk_code == configured_vk;
        let is_slash = raw.vk_code == VK_SLASH;

        if (is_chat_key || is_slash) && !chat_paused.load(Ordering::Relaxed) {
          // Set paused atomically so macros can't fire this tick.
          chat_paused.store(true, Ordering::Relaxed);
          macro_runtime.set_chat_paused(true);
          emit_to_main(&app, "chat-paused", &());
          // Fall through to emit macro-key-down (renderer uses it for UI).
        } else if raw.vk_code == VK_ESCAPE && chat_paused.load(Ordering::Relaxed) {
          // Escape closes Minecraft chat → resume macros.
          chat_paused.store(false, Ordering::Relaxed);
          macro_runtime.set_chat_paused(false);
          emit_to_main(&app, "chat-resumed", &());
        }
      }
      // ─────────────────────────────────────────────────────────────────────

      if is_down {
        emit_to_main(
          &app,
          "macro-key-down",
          &MacroKeyEventPayload {
            code: code.clone(),
            vk_code: raw.vk_code,
            scan_code: raw.scan_code,
            modifiers,
            timestamp_ms: raw.timestamp_ms,
            repeat: Some(repeat),
          },
        );
      } else {
        emit_to_main(
          &app,
          "macro-key-up",
          &MacroKeyEventPayload {
            code: code.clone(),
            vk_code: raw.vk_code,
            scan_code: raw.scan_code,
            modifiers,
            timestamp_ms: raw.timestamp_ms,
            repeat: None,
          },
        );
      }

      if is_down && !repeat {
        let hotkey_snapshot = hotkeys
          .read()
          .map(|items| items.clone())
          .unwrap_or_default();

        if hotkey_matches(hotkey_snapshot.panic.as_ref(), raw.vk_code, modifiers) {
          let _ = crate::handle_app_panic(&app, &macro_runtime);
          continue;
        }

        if hotkey_matches(hotkey_snapshot.stealth.as_ref(), raw.vk_code, modifiers) {
          let _ = crate::toggle_stealth_window(&app, &stealth_active);
          continue;
        }
      }

      let binding_snapshot = bindings
        .read()
        .map(|items| items.clone())
        .unwrap_or_else(|_| Vec::<MacroBinding>::new());

      let triggers = if is_down {
        // Skip auto-repeat key events for press triggers — only fire on the
        // initial key-down. Hold macros are already guarded by their own
        // "already running" checks; toggle macros (like TB) would double-fire
        // on each auto-repeat keystroke otherwise.
        if repeat {
          Vec::new()
        } else {
          matching_press_triggers(&binding_snapshot, raw.vk_code, modifiers)
        }
      } else {
        matching_release_triggers(&binding_snapshot, raw.vk_code)
      };

      for trigger in triggers {
        macro_runtime.handle_trigger(trigger.id.clone(), trigger.action);
        emit_to_main(
          &app,
          "macro-trigger",
          &MacroTriggerPayload {
            id: trigger.id,
            keybind: trigger.keybind,
            action: trigger.action.to_string(),
            code: code.clone(),
            modifiers,
            timestamp_ms: raw.timestamp_ms,
          },
        );
      }
    }
  })
}

fn hotkey_matches(binding: Option<&MacroBinding>, vk_code: u32, modifiers: ModifierPayload) -> bool {
  binding
    .map(|item| !matching_press_triggers(std::slice::from_ref(item), vk_code, modifiers).is_empty())
    .unwrap_or(false)
}

fn spawn_mouse_worker(
  macro_runtime: macro_runtime::SharedMacroRuntime,
  bindings: SharedBindings,
  rx: mpsc::Receiver<RawMouseEvent>,
) -> JoinHandle<()> {
  thread::spawn(move || {
    while let Ok(raw) = rx.recv() {
      let binding_snapshot = bindings
        .read()
        .map(|b| b.clone())
        .unwrap_or_default();
      // Find any binding whose keybind matches this mouse button
      let event = if raw.is_down { "press" } else { "release" };
      for binding in &binding_snapshot {
        if binding.keybind.eq_ignore_ascii_case(raw.button_code) {
          macro_runtime.handle_trigger(binding.id.clone(), event);
        }
      }
    }
  })
}

pub struct InputHookService {
  #[cfg(target_os = "windows")]
  hook_thread_id: u32,
  hook_thread: Option<JoinHandle<()>>,
  worker_thread: Option<JoinHandle<()>>,
  mouse_worker_thread: Option<JoinHandle<()>>,
  sender: Option<mpsc::SyncSender<RawKeyEvent>>,
}

impl InputHookService {
  #[cfg(target_os = "windows")]
  pub fn start(
    app: AppHandle,
    bindings: SharedBindings,
    hotkeys: SharedAppHotkeys,
    stealth_active: SharedStealthState,
    macro_runtime: macro_runtime::SharedMacroRuntime,
    chat_vk: SharedChatVk,
    chat_paused: macro_runtime::SharedChatPaused,
  ) -> Result<Self, String> {
    let (tx, rx) = mpsc::sync_channel::<RawKeyEvent>(256);
    let (mouse_tx, mouse_rx) = mpsc::sync_channel::<RawMouseEvent>(256);

    let mouse_worker_thread = spawn_mouse_worker(Arc::clone(&macro_runtime), Arc::clone(&bindings), mouse_rx);
    let worker_thread = spawn_worker(app, bindings, hotkeys, stealth_active, macro_runtime, chat_vk, chat_paused, rx);

    replace_sender(Some(tx.clone()));
    replace_mouse_sender(Some(mouse_tx));

    let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();
    let hook_thread = thread::spawn(move || unsafe {
      let hook_thread_id = GetCurrentThreadId();
      let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook_proc), std::ptr::null_mut(), 0);

      if hook.is_null() {
        let _ = ready_tx.send(Err("SetWindowsHookExW(WH_KEYBOARD_LL) failed".to_string()));
        return;
      }

      let mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook_proc), std::ptr::null_mut(), 0);

      let _ = ready_tx.send(Ok(hook_thread_id));

      let mut msg = std::mem::zeroed::<MSG>();
      while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
      }

      if !mouse_hook.is_null() {
        UnhookWindowsHookEx(mouse_hook);
      }
      UnhookWindowsHookEx(hook);
    });

    let hook_thread_id = ready_rx
      .recv()
      .map_err(|_| "keyboard hook thread did not initialize".to_string())??;

    Ok(Self {
      hook_thread_id,
      hook_thread: Some(hook_thread),
      worker_thread: Some(worker_thread),
      mouse_worker_thread: Some(mouse_worker_thread),
      sender: Some(tx),
    })
  }

  #[cfg(not(target_os = "windows"))]
  pub fn start(
    _app: AppHandle,
    _bindings: SharedBindings,
    _hotkeys: SharedAppHotkeys,
    _stealth_active: SharedStealthState,
    _macro_runtime: macro_runtime::SharedMacroRuntime,
    _chat_vk: SharedChatVk,
    _chat_paused: macro_runtime::SharedChatPaused,
  ) -> Result<Self, String> {
    Ok(Self {
      hook_thread: None,
      worker_thread: None,
      mouse_worker_thread: None,
      sender: None,
    })
  }

  pub fn stop(&mut self) {
    replace_sender(None);
    replace_mouse_sender(None);
    self.sender.take();

    #[cfg(target_os = "windows")]
    {
      if self.hook_thread_id != 0 {
        unsafe {
          PostThreadMessageW(self.hook_thread_id, WM_QUIT, 0, 0);
        }
        self.hook_thread_id = 0;
      }
    }

    if let Some(handle) = self.hook_thread.take() {
      let _ = handle.join();
    }

    if let Some(handle) = self.worker_thread.take() {
      let _ = handle.join();
    }

    if let Some(handle) = self.mouse_worker_thread.take() {
      let _ = handle.join();
    }
  }
}

impl Drop for InputHookService {
  fn drop(&mut self) {
    self.stop();
  }
}
