use crate::{FocusLockState, WindowInfo};
use std::{
  sync::{mpsc, Arc, Mutex},
  thread::{self, JoinHandle},
  time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};

pub type SharedFocusState = Arc<Mutex<FocusLockState>>;

const POLL_MS: u64 = 280;
const FOCUS_DEBOUNCE_TICKS: u32 = 2;

#[cfg(target_os = "windows")]
use windows_sys::Win32::{
  Foundation::{BOOL, HWND, LPARAM},
  UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, IsWindowVisible,
    SetForegroundWindow,
  },
};

#[derive(Clone, Debug)]
struct NativeWindowInfo {
  handle: i64,
  title: String,
  class_name: String,
  focused: bool,
}

fn emit_to_main<T: serde::Serialize>(app: &AppHandle, event_name: &str, payload: &T) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.emit(event_name, payload);
  }
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
  needles.iter().any(|needle| haystack.contains(needle))
}

fn is_browser_title(title: &str) -> bool {
  contains_any(
    title,
    &[
      "- google chrome",
      "- mozilla firefox",
      "- microsoft edge",
      "- opera",
      "- brave browser",
      "- safari",
    ],
  )
}

fn is_mc_class_name(class_name: &str) -> bool {
  if matches!(class_name, "sunawtframe" | "sunawtdialog" | "sunawtcanvas") {
    return true;
  }

  if let Some(rest) = class_name.strip_prefix("glfw") {
    return !rest.is_empty() && rest.chars().all(|ch| ch.is_ascii_digit());
  }

  false
}

fn is_mc_version_title(title: &str) -> bool {
  if title.is_empty() {
    return false;
  }

  if let Some(rest) = title.strip_prefix("1.") {
    let mut parts = rest.split('.');
    let Some(minor) = parts.next() else {
      return false;
    };

    if minor.is_empty() || !minor.chars().all(|ch| ch.is_ascii_digit()) {
      return false;
    }

    if let Some(patch_or_suffix) = parts.next() {
      if patch_or_suffix.is_empty() {
        return false;
      }

      if patch_or_suffix.chars().all(|ch| ch.is_ascii_digit()) {
        return parts.next().is_none();
      }

      let mut chars = patch_or_suffix.chars();
      let Some(first) = chars.next() else {
        return false;
      };
      return first.is_ascii_alphabetic() && chars.all(|ch| ch.is_ascii_digit()) && parts.next().is_none();
    }

    return true;
  }

  if title.len() == 6 {
    let chars = title.as_bytes();
    return chars[0].is_ascii_digit()
      && chars[1].is_ascii_digit()
      && chars[2] == b'w'
      && chars[3].is_ascii_digit()
      && chars[4].is_ascii_digit()
      && chars[5].is_ascii_alphabetic();
  }

  false
}

fn is_mc_game_title(title: &str) -> bool {
  contains_any(
    title,
    &["minecraft", "lunar", "lunarclient", "badlion", "feather", "pvplounge", "cosmic", "salwyrr", "blaze", "crystal"],
  )
}

fn is_mc_title(title: &str) -> bool {
  contains_any(
    title,
    &[
      "minecraft",
      "lunar",
      "lunarclient",
      "badlion",
      "feather",
      "pvplounge",
      "cosmic",
      "salwyrr",
      "blaze",
      "crystal",
      "tlauncher",
      "multimc",
      "prism launcher",
      "atlauncher",
      "gdlauncher",
      "curseforge",
    ],
  )
}

fn is_launcher_title(title: &str) -> bool {
  contains_any(title, &["launcher", "multimc", "prism", "curseforge", "atlauncher", "gdlauncher", "tlauncher"])
}

fn is_mc_game_window(window: &NativeWindowInfo) -> bool {
  let title = window.title.trim().to_lowercase();
  let class_name = window.class_name.trim().to_lowercase();

  if is_browser_title(&title) {
    return false;
  }

  if is_mc_class_name(&class_name) {
    return title.is_empty() || is_mc_game_title(&title) || is_mc_version_title(&title);
  }

  is_mc_game_title(&title) && !is_launcher_title(&title)
}

fn is_mc_window(window: &NativeWindowInfo) -> bool {
  let title = window.title.trim().to_lowercase();
  let class_name = window.class_name.trim().to_lowercase();

  if is_browser_title(&title) {
    return false;
  }

  if is_mc_class_name(&class_name) {
    return title.is_empty() || is_mc_title(&title) || is_mc_version_title(&title);
  }

  is_mc_title(&title)
}

fn compute_focus_state(mode: String, preferred_handle: Option<i64>, windows: &[NativeWindowInfo]) -> FocusLockState {
  let mc_windows = windows.iter().filter(|window| is_mc_window(window)).cloned().collect::<Vec<_>>();
  let game_windows = mc_windows
    .iter()
    .filter(|window| is_mc_game_window(window))
    .cloned()
    .collect::<Vec<_>>();

  let game_window_count = game_windows.len() as u32;
  let normalized_mode = if mode.trim().eq_ignore_ascii_case("specific") {
    "specific".to_string()
  } else {
    "all".to_string()
  };

  let (effective_window_count, selected_missing, focused) = if normalized_mode == "specific" {
    if let Some(target) = preferred_handle {
      let scoped = game_windows
        .iter()
        .filter(|window| window.handle == target)
        .cloned()
        .collect::<Vec<_>>();
      let selected_missing = scoped.is_empty();
      let focused = scoped.iter().any(|window| window.focused);
      (if selected_missing { 0 } else { scoped.len() as u32 }, selected_missing, focused)
    } else {
      (0, true, false)
    }
  } else {
    (game_window_count, false, game_windows.iter().any(|window| window.focused))
  };

  FocusLockState {
    running: !mc_windows.is_empty(),
    focused,
    mode: normalized_mode,
    preferred_handle,
    game_window_count,
    effective_window_count,
    requires_selection: false,
    selected_missing,
  }
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_windows_proc(hwnd: HWND, l_param: LPARAM) -> BOOL {
  if IsWindowVisible(hwnd) == 0 {
    return 1;
  }

  let windows = &mut *(l_param as *mut Vec<NativeWindowInfo>);
  let handle = hwnd as isize as i64;
  if handle <= 0 {
    return 1;
  }

  let title_len = GetWindowTextLengthW(hwnd);
  let mut title_buf = vec![0u16; (title_len.max(0) as usize) + 1];
  let copied_title = GetWindowTextW(hwnd, title_buf.as_mut_ptr(), title_buf.len() as i32);
  let title = String::from_utf16_lossy(&title_buf[..(copied_title.max(0) as usize)]);

  let mut class_buf = [0u16; 256];
  let copied_class = GetClassNameW(hwnd, class_buf.as_mut_ptr(), class_buf.len() as i32);
  let class_name = String::from_utf16_lossy(&class_buf[..(copied_class.max(0) as usize)]);

  if title.trim().is_empty() && class_name.trim().is_empty() {
    return 1;
  }

  let foreground = GetForegroundWindow();
  windows.push(NativeWindowInfo {
    handle,
    title,
    class_name,
    focused: foreground == hwnd,
  });

  1
}

#[cfg(target_os = "windows")]
fn native_windows() -> Vec<NativeWindowInfo> {
  let mut windows = Vec::<NativeWindowInfo>::new();
  unsafe {
    EnumWindows(Some(enum_windows_proc), &mut windows as *mut _ as LPARAM);
  }
  windows
}

#[cfg(not(target_os = "windows"))]
fn native_windows() -> Vec<NativeWindowInfo> {
  Vec::new()
}

pub fn list_game_windows() -> Vec<WindowInfo> {
  native_windows()
    .into_iter()
    .filter(is_mc_game_window)
    .map(|window| WindowInfo {
      handle: window.handle,
      title: window.title,
      class_name: window.class_name,
      focused: window.focused,
    })
    .collect()
}

pub fn focus_minecraft(shared_state: &SharedFocusState) -> bool {
  let preferred_handle = {
    let state = shared_state.lock().expect("focus state lock poisoned");
    state.preferred_handle
  };

  let windows = native_windows()
    .into_iter()
    .filter(is_mc_game_window)
    .collect::<Vec<_>>();

  let target = windows
    .iter()
    .find(|window| window.focused)
    .or_else(|| preferred_handle.and_then(|handle| windows.iter().find(|window| window.handle == handle)))
    .or_else(|| windows.first());

  #[cfg(target_os = "windows")]
  {
    if let Some(window) = target {
      // If MC is already the foreground window, don't call SetForegroundWindow —
      // doing so while the user holds movement keys can briefly disrupt input.
      if window.focused {
        return true;
      }
      return unsafe { SetForegroundWindow(window.handle as isize as HWND) != 0 };
    }
  }

  false
}

fn refresh_state(shared_state: &SharedFocusState) -> FocusLockState {
  let (mode, preferred_handle) = {
    let state = shared_state.lock().expect("focus state lock poisoned");
    (state.mode.clone(), state.preferred_handle)
  };

  compute_focus_state(mode, preferred_handle, &native_windows())
}

pub fn current_snapshot(shared_state: &SharedFocusState) -> FocusLockState {
  let snapshot = refresh_state(shared_state);
  {
    let mut state = shared_state.lock().expect("focus state lock poisoned");
    *state = snapshot.clone();
  }
  snapshot
}

pub struct FocusLockService {
  stop_tx: Option<mpsc::Sender<()>>,
  thread: Option<JoinHandle<()>>,
}

impl FocusLockService {
  pub fn start(app: AppHandle, shared_state: SharedFocusState) -> Result<Self, String> {
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let thread = thread::spawn(move || {
      let mut last_running: Option<bool> = None;
      let mut last_focused: Option<bool> = None;
      let mut last_signature = String::new();
      let mut focus_pending_ticks = 0u32;

      loop {
        let snapshot = refresh_state(&shared_state);
        let mut debounced = snapshot.clone();

        if snapshot.focused {
          focus_pending_ticks += 1;
          if focus_pending_ticks < FOCUS_DEBOUNCE_TICKS {
            debounced.focused = false;
          }
        } else {
          focus_pending_ticks = 0;
        }

        {
          let mut state = shared_state.lock().expect("focus state lock poisoned");
          *state = debounced.clone();
        }

        if last_running != Some(debounced.running) {
          last_running = Some(debounced.running);
          emit_to_main(&app, "mc-running-changed", &debounced.running);
        }

        if last_focused != Some(debounced.focused) {
          last_focused = Some(debounced.focused);
          emit_to_main(&app, "focus-lock-changed", &debounced.focused);
        }

        let signature = serde_json::to_string(&debounced).unwrap_or_default();
        if signature != last_signature {
          last_signature = signature;
          emit_to_main(&app, "focus-lock-state", &debounced);
        }

        match stop_rx.recv_timeout(Duration::from_millis(POLL_MS)) {
          Ok(_) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
          Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
      }
    });

    Ok(Self {
      stop_tx: Some(stop_tx),
      thread: Some(thread),
    })
  }

  pub fn stop(&mut self) {
    if let Some(tx) = self.stop_tx.take() {
      let _ = tx.send(());
    }

    if let Some(thread) = self.thread.take() {
      let _ = thread.join();
    }
  }
}

impl Drop for FocusLockService {
  fn drop(&mut self) {
    self.stop();
  }
}
