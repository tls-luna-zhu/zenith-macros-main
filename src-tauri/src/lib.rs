mod anti_tamper;
mod auth;
mod binds;
mod discord_rpc;
mod focus_lock;
mod input_hook;
mod macro_runtime;

use binds::{compile_keyboard_bindings, parse_binding};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::time::sleep;
use std::{
  env,
  fs,
  path::PathBuf,
  sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, RwLock,
  },
  time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

const APP_STORE_FILE: &str = "zenith-data-v2.json";
const MAX_STORE_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// Community build: no license server, macros always allowed.
const FREE_STANDALONE: bool = cfg!(feature = "free_standalone");

// ── Preset marker ─────────────────────────────────────────────────────────────
// The backend patches the 12 null bytes after "ZNTH_PRESET:" with the disguise
// preset ID (e.g. b"spotify\0\0\0\0\0") when building a customised EXE.
// #[no_mangle] + #[used] guarantees the linker never strips this symbol.
#[no_mangle]
#[used]
static ZENITH_PRESET_MARKER: [u8; 24] =
  *b"ZNTH_PRESET:\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00";

/// Read the preset ID patched into this binary by the backend builder.
/// Returns e.g. `Some("spotify")`, `Some("discord")`, or `None` if unpatched.
fn read_builtin_preset() -> Option<String> {
  let exe = std::env::current_exe().ok()?;
  let data = std::fs::read(exe).ok()?;
  let marker = b"ZNTH_PRESET:";
  let pos = data.windows(marker.len()).position(|w| w == marker)?;
  let payload = &data[pos + marker.len()..pos + marker.len() + 12];
  let end = payload.iter().position(|&b| b == 0).unwrap_or(12);
  if end == 0 { return None; }
  String::from_utf8(payload[..end].to_vec()).ok()
}

/// Map a preset ID to the display name shown in the window title / taskbar.
fn preset_display_name(preset: &str) -> &'static str {
  match preset {
    "spotify" => "Spotify",
    "discord" => "Discord",
    "chrome"  => "Google Chrome",
    "steam"   => "Steam",
    "obs"     => "OBS Studio",
    _         => "Spotify",
  }
}

/// Return the icon PNG bytes for a given preset ID (embedded at compile time).
fn preset_icon_bytes(preset: &str) -> &'static [u8] {
  match preset {
    "discord" => include_bytes!("../icons/preset_discord.png"),
    "chrome"  => include_bytes!("../icons/preset_chrome.png"),
    "steam"   => include_bytes!("../icons/preset_steam.png"),
    "obs"     => include_bytes!("../icons/preset_obs.png"),
    _         => include_bytes!("../icons/preset_spotify.png"),
  }
}
struct AppStore {
  path: PathBuf,
  document: Mutex<Value>,
}

struct RuntimeState {
  focus_state: focus_lock::SharedFocusState,
  latest_macro_config: macro_runtime::SharedMacroConfig,
  focus_lock_enabled: macro_runtime::SharedFocusLockEnabled,
  auth_active: macro_runtime::SharedAuthActive,
  chat_paused: macro_runtime::SharedChatPaused,
  chat_vk: input_hook::SharedChatVk,
  click_binds: macro_runtime::SharedClickBinds,
  macro_bindings: input_hook::SharedBindings,
  app_hotkeys: input_hook::SharedAppHotkeys,
  stealth_active: input_hook::SharedStealthState,
  rpc_settings: discord_rpc::SharedRpcSettings,
  macro_runtime: macro_runtime::SharedMacroRuntime,
  rpc_service: Mutex<Option<discord_rpc::DiscordRpcService>>,
  focus_lock_service: Mutex<Option<focus_lock::FocusLockService>>,
  input_hook: Mutex<Option<input_hook::InputHookService>>,
  macro_count: Arc<Mutex<u32>>,
  auth_session: auth::SharedAuthSession,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FocusLockState {
  running: bool,
  focused: bool,
  mode: String,
  preferred_handle: Option<i64>,
  game_window_count: u32,
  effective_window_count: u32,
  requires_selection: bool,
  selected_missing: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowInfo {
  handle: i64,
  title: String,
  class_name: String,
  focused: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfilesPayload {
  profiles: Vec<Value>,
  active_profile: String,
}

impl Default for FocusLockState {
  fn default() -> Self {
    Self {
      running: false,
      focused: false,
      mode: "all".into(),
      preferred_handle: None,
      game_window_count: 0,
      effective_window_count: 0,
      requires_selection: false,
      selected_missing: false,
    }
  }
}

impl Default for RuntimeState {
  fn default() -> Self {
    let focus_state = Arc::new(Mutex::new(FocusLockState::default()));
    let latest_macro_config = Arc::new(Mutex::new(None));
    let focus_lock_enabled = Arc::new(AtomicBool::new(true));
    let auth_active = Arc::new(AtomicBool::new(false));
    let chat_paused = Arc::new(AtomicBool::new(false));
    let chat_vk = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let click_binds = Arc::new(Mutex::new(macro_runtime::ClickBinds::default()));
    let app_hotkeys = Arc::new(RwLock::new(input_hook::AppHotkeys::default()));
    let stealth_active = Arc::new(AtomicBool::new(false));
    let rpc_settings = Arc::new(Mutex::new(discord_rpc::RpcSettings::default()));
    let macro_count = Arc::new(Mutex::new(0u32));
    let macro_runtime = macro_runtime::new(
      Arc::clone(&latest_macro_config),
      Arc::clone(&focus_state),
      Arc::clone(&focus_lock_enabled),
      Arc::clone(&auth_active),
      Arc::clone(&click_binds),
      Arc::clone(&chat_paused),
    );

    Self {
      focus_state,
      latest_macro_config,
      focus_lock_enabled,
      auth_active,
      chat_paused,
      chat_vk,
      click_binds,
      macro_bindings: Arc::new(RwLock::new(Vec::new())),
      app_hotkeys,
      stealth_active,
      rpc_settings,
      macro_runtime,
      rpc_service: Mutex::new(None),
      focus_lock_service: Mutex::new(None),
      input_hook: Mutex::new(None),
      macro_count,
      auth_session: auth::session::new_shared(),
    }
  }
}

impl RuntimeState {
  fn set_authenticated(&self, active: bool) {
    self.auth_active.store(active, Ordering::Relaxed);
    self.macro_runtime.set_authenticated(active);
  }

  fn clear_macro_runtime_state(&self) -> Result<(), String> {
    self.macro_runtime.stop_all();
    *self
      .latest_macro_config
      .lock()
      .map_err(|_| "macro config lock poisoned".to_string())? = None;
    *self
      .macro_bindings
      .write()
      .map_err(|_| "macro binding registry lock poisoned".to_string())? = Vec::new();
    Ok(())
  }

  fn update_macro_config(&self, config: Value) -> Result<(), String> {
    let compiled = compile_keyboard_bindings(&config);

    *self
      .latest_macro_config
      .lock()
      .map_err(|_| "macro config lock poisoned".to_string())? = Some(config);

    *self
      .macro_bindings
      .write()
      .map_err(|_| "macro binding registry lock poisoned".to_string())? = compiled;

    Ok(())
  }

  fn start_input_hook(&self, app: AppHandle) -> Result<(), String> {
    let mut guard = self
      .input_hook
      .lock()
      .map_err(|_| "input hook lock poisoned".to_string())?;

    if guard.is_none() {
      let service = input_hook::InputHookService::start(
        app,
        Arc::clone(&self.macro_bindings),
        Arc::clone(&self.app_hotkeys),
        Arc::clone(&self.stealth_active),
        Arc::clone(&self.macro_runtime),
        Arc::clone(&self.chat_vk),
        Arc::clone(&self.chat_paused),
      )?;
      *guard = Some(service);
    }

    Ok(())
  }

  fn start_focus_lock(&self, app: AppHandle) -> Result<(), String> {
    let mut guard = self
      .focus_lock_service
      .lock()
      .map_err(|_| "focus lock service lock poisoned".to_string())?;

    if guard.is_none() {
      let service = focus_lock::FocusLockService::start(app, Arc::clone(&self.focus_state))?;
      *guard = Some(service);
    }

    Ok(())
  }

  fn start_discord_rpc(&self) -> Result<(), String> {
    let mut guard = self
      .rpc_service
      .lock()
      .map_err(|_| "discord rpc service lock poisoned".to_string())?;

    if guard.is_none() {
      let service = discord_rpc::DiscordRpcService::start(
        Arc::clone(&self.rpc_settings),
        Arc::clone(&self.focus_state),
        Arc::clone(&self.macro_count),
      )?;
      *guard = Some(service);
    }

    Ok(())
  }

  fn set_panic_key(&self, key: Option<&str>) -> Result<(), String> {
    let binding = key.and_then(|value| compile_hotkey_binding("panic", value));
    let mut guard = self
      .app_hotkeys
      .write()
      .map_err(|_| "app hotkey registry lock poisoned".to_string())?;
    guard.panic = binding;
    Ok(())
  }

  fn set_stealth_key(&self, key: Option<&str>) -> Result<(), String> {
    let binding = key.and_then(|value| compile_hotkey_binding("stealth", value));
    let mut guard = self
      .app_hotkeys
      .write()
      .map_err(|_| "app hotkey registry lock poisoned".to_string())?;
    guard.stealth = binding;
    Ok(())
  }

  fn apply_hotkey_settings(&self, settings: &Value) -> Result<(), String> {
    self.set_panic_key(settings.get("panicKey").and_then(Value::as_str))?;
    self.set_stealth_key(settings.get("stealthKey").and_then(Value::as_str))?;
    Ok(())
  }

  fn apply_rpc_settings(&self, settings: &Value) -> Result<(), String> {
    let enabled = settings
      .get("discordRpcEnabled")
      .and_then(Value::as_bool)
      .unwrap_or(true);
    let hide_username = settings
      .get("discordRpcHideUsername")
      .and_then(Value::as_bool)
      .unwrap_or(true);

    let mut guard = self
      .rpc_settings
      .lock()
      .map_err(|_| "discord rpc settings lock poisoned".to_string())?;
    guard.enabled = enabled;
    guard.hide_username = hide_username;
    Ok(())
  }

  fn apply_runtime_settings(&self, settings: &Value) -> Result<(), String> {
    self.apply_hotkey_settings(settings)?;
    self.apply_rpc_settings(settings)?;
    Ok(())
  }
}

impl AppStore {
  fn new() -> Self {
    let path = store_root_dir().join(APP_STORE_FILE);
    let document = load_store_document(&path);
    Self {
      path,
      document: Mutex::new(document),
    }
  }

  fn read_field(&self, key: &str) -> Value {
    let guard = self.document.lock().expect("store lock poisoned");
    guard.get(key).cloned().unwrap_or(Value::Null)
  }

  fn update<R>(&self, f: impl FnOnce(&mut Map<String, Value>) -> R) -> Result<R, String> {
    let mut guard = self.document.lock().map_err(|_| "store lock poisoned".to_string())?;
    let root = ensure_root_object(&mut guard);
    let result = f(root);
    persist_store_document(&self.path, &guard)?;
    Ok(result)
  }
}

fn now_ms() -> i64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as i64)
    .unwrap_or(0)
}

fn store_root_dir() -> PathBuf {
  if let Ok(appdata) = env::var("APPDATA") {
    let trimmed = appdata.trim();
    if !trimmed.is_empty() {
      return PathBuf::from(trimmed).join("zenith-macros");
    }
  }
  env::current_dir()
    .unwrap_or_else(|_| PathBuf::from("."))
    .join(".zenith-macros")
}

fn load_store_document(path: &PathBuf) -> Value {
  // [SECURITY HARDENING] Ignore unexpectedly large local store payloads.
  if let Ok(meta) = fs::metadata(path) {
    if meta.len() > MAX_STORE_FILE_BYTES {
      return json!({});
    }
  }

  match fs::read_to_string(path) {
    Ok(raw) => match serde_json::from_str::<Value>(&raw) {
      Ok(Value::Object(obj)) => Value::Object(obj),
      _ => json!({}),
    },
    Err(_) => json!({}),
  }
}

fn persist_store_document(path: &PathBuf, document: &Value) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
  }
  let payload = serde_json::to_string_pretty(document).map_err(|err| err.to_string())?;
  let payload = format!("{payload}\n");

  // [SECURITY HARDENING] Atomic replace to avoid partial/corrupt writes.
  let tmp_path = path.with_extension("tmp");
  fs::write(&tmp_path, payload.as_bytes()).map_err(|err| err.to_string())?;
  match fs::rename(&tmp_path, path) {
    Ok(_) => Ok(()),
    Err(_) => {
      // Windows may fail rename when target exists; fallback replace.
      let _ = fs::remove_file(path);
      fs::rename(&tmp_path, path).map_err(|err| err.to_string())
    }
  }
}

fn ensure_root_object(value: &mut Value) -> &mut Map<String, Value> {
  if !value.is_object() {
    *value = json!({});
  }
  value.as_object_mut().expect("store root must be object")
}

fn shallow_merge_object(mut base: Value, patch: Value) -> Value {
  if !base.is_object() {
    base = json!({});
  }
  let root = base.as_object_mut().expect("merged object expected");
  if let Some(patch_obj) = patch.as_object() {
    for (key, value) in patch_obj {
      root.insert(key.clone(), value.clone());
    }
  }
  base
}

fn save_settings_partial(store: &AppStore, partial: Value) -> Result<Value, String> {
  store.update(|root| {
    let current = root.get("appSettings").cloned().unwrap_or_else(|| json!({}));
    let merged = shallow_merge_object(current, partial);
    root.insert("appSettings".into(), merged.clone());
    merged
  })
}

fn compile_hotkey_binding(id: &str, key: &str) -> Option<binds::MacroBinding> {
  let trimmed = key.trim();
  if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("none") {
    return None;
  }
  parse_binding(id, trimmed)
}

fn default_profile() -> Value {
  json!({
    "id": "default",
    "name": "Default",
    "config": Value::Null,
    "createdAt": now_ms(),
    "updatedAt": now_ms()
  })
}

fn ensure_profiles(root: &mut Map<String, Value>) {
  let needs_default = !root
    .get("profiles")
    .and_then(Value::as_array)
    .map(|profiles| {
      profiles.iter().any(|profile| {
        profile
          .get("id")
          .and_then(Value::as_str)
          .map(|id| id == "default")
          .unwrap_or(false)
      })
    })
    .unwrap_or(false);

  if !root.contains_key("profiles") || !root.get("profiles").map(Value::is_array).unwrap_or(false) {
    root.insert("profiles".into(), Value::Array(vec![default_profile()]));
  } else if needs_default {
    if let Some(profiles) = root.get_mut("profiles").and_then(Value::as_array_mut) {
      profiles.insert(0, default_profile());
    }
  }

  root
    .entry("activeProfile")
    .or_insert_with(|| Value::String("default".into()));
}

fn get_profiles_payload(store: &AppStore) -> Result<ProfilesPayload, String> {
  store.update(|root| {
    ensure_profiles(root);
    let profiles = root
      .get("profiles")
      .and_then(Value::as_array)
      .cloned()
      .unwrap_or_else(|| vec![default_profile()]);
    let active_profile = root
      .get("activeProfile")
      .and_then(Value::as_str)
      .unwrap_or("default")
      .to_string();

    ProfilesPayload {
      profiles,
      active_profile,
    }
  })
}

fn license_api_bases() -> Vec<String> {
  let mut bases: Vec<String> = Vec::new();

  if let Ok(raw) = env::var("ZENITH_LICENSE_API") {
    let trimmed = raw.trim().trim_end_matches('/');
    if !trimmed.is_empty() {
      bases.push(trimmed.to_string());
    }
  }

  if cfg!(debug_assertions) {
    bases.push("http://127.0.0.1:5000".into());
  }
  bases.push("https://zenith-license.fly.dev".into());

  bases.dedup();
  bases
}

async fn refresh_saved_session(store: &AppStore, runtime: &RuntimeState) -> Option<auth::session::AuthSession> {
  let existing = {
    if let Ok(guard) = runtime.auth_session.lock() {
      guard.clone()
    } else {
      None
    }
  }
  .or_else(|| auth::session::AuthSession::load_token(store))?;

  for api_base in license_api_bases() {
    if let Ok(refreshed) = auth::challenge::refresh_auth(&existing.token, &existing.hwid_fp, &api_base).await {
      let session = auth::session::AuthSession {
        token: refreshed.session_token,
        key: existing.key.clone(),
        user_enc_key: existing.user_enc_key,
        tier: refreshed.tier,
        expires_at_ms: 0,
        hwid_fp: refreshed.hwid_fp,
      };
      session.save_token(store);
      if let Ok(mut guard) = runtime.auth_session.lock() {
        *guard = Some(session.clone());
      }
      runtime.set_authenticated(true);
      return Some(session);
    }
  }

  auth::session::AuthSession::clear(store);
  if let Ok(mut guard) = runtime.auth_session.lock() {
    *guard = None;
  }
  runtime.set_authenticated(false);
  let _ = runtime.clear_macro_runtime_state();
  None
}

async fn require_authenticated(
  app: &AppHandle,
  store: &AppStore,
  runtime: &RuntimeState,
) -> Result<auth::session::AuthSession, String> {
  #[cfg(feature = "free_standalone")]
  {
    let _ = (app, store);
    return Ok(auth::session::AuthSession::free_standalone_dummy());
  }

  #[cfg(not(feature = "free_standalone"))]
  {
    if let Ok(guard) = runtime.auth_session.lock() {
      if let Some(session) = guard.clone() {
        if !session.is_expired() {
          return Ok(session);
        }
      }
    }

    if let Some(session) = refresh_saved_session(store, runtime).await {
      return Ok(session);
    }

    runtime.set_authenticated(false);
    let _ = runtime.clear_macro_runtime_state();
    let _ = app.emit("license-revoked", ());
    Err("Authentication required".to_string())
  }
}

fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
  app
    .get_webview_window("main")
    .ok_or_else(|| "main window unavailable".to_string())
}

fn decode_png_icon(png_bytes: &[u8]) -> Option<tauri::image::Image<'static>> {
  use image::GenericImageView;
  let img = image::load_from_memory(png_bytes).ok()?;
  let (w, h) = img.dimensions();
  let rgba = img.to_rgba8().into_raw();
  Some(tauri::image::Image::new_owned(rgba, w, h))
}

pub(crate) fn toggle_stealth_window(
  app: &AppHandle,
  stealth_active: &input_hook::SharedStealthState,
) -> Result<bool, String> {
  let window = main_window(app)?;
  let currently_active = stealth_active.load(Ordering::Relaxed);

  if currently_active {
    window.set_skip_taskbar(false).map_err(|err| err.to_string())?;
    window.show().map_err(|err| err.to_string())?;
    let _ = window.unminimize();
    let _ = window.set_focus();
    stealth_active.store(false, Ordering::Relaxed);
    return Ok(false);
  }

  window.set_skip_taskbar(true).map_err(|err| err.to_string())?;
  window.hide().map_err(|err| err.to_string())?;
  stealth_active.store(true, Ordering::Relaxed);
  Ok(true)
}

pub(crate) fn handle_app_panic(app: &AppHandle, macro_runtime: &macro_runtime::SharedMacroRuntime) -> Result<(), String> {
  macro_runtime.stop_all();
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.emit("panic-all", ());
  }
  main_window(app)?.close().map_err(|err| err.to_string())
}

fn emit_focus_lock_state(app: &AppHandle, runtime: &RuntimeState) -> Result<(), String> {
  let state = runtime
    .focus_state
    .lock()
    .map_err(|_| "focus state lock poisoned".to_string())?
    .clone();
  app.emit("focus-lock-state", &state).map_err(|err| err.to_string())
}

// Holds the pending update between check_for_update and install_update
#[cfg(not(feature = "free_standalone"))]
struct PendingUpdate(Mutex<Option<tauri_plugin_updater::Update>>);

#[cfg(feature = "free_standalone")]
struct PendingUpdate;

#[cfg(not(feature = "free_standalone"))]
impl Default for PendingUpdate {
  fn default() -> Self {
    Self(Mutex::new(None))
  }
}

#[cfg(feature = "free_standalone")]
impl Default for PendingUpdate {
  fn default() -> Self {
    Self
  }
}

#[tauri::command]
fn app_version() -> String {
  env!("CARGO_PKG_VERSION").to_string()
}

#[cfg(not(feature = "free_standalone"))]
#[tauri::command]
async fn check_for_update(
  app: AppHandle,
  pending: State<'_, PendingUpdate>,
) -> Result<Option<String>, String> {
  use tauri_plugin_updater::UpdaterExt;
  let updater = app.updater().map_err(|e| e.to_string())?;
  match updater.check().await {
    Ok(Some(update)) => {
      let version = update.version.trim_start_matches('v').to_string();
      *pending.0.lock().unwrap() = Some(update);
      Ok(Some(version))
    }
    Ok(None) => {
      *pending.0.lock().unwrap() = None;
      Ok(None)
    }
    Err(e) => Err(e.to_string()),
  }
}

#[cfg(feature = "free_standalone")]
#[tauri::command]
async fn check_for_update(
  _app: AppHandle,
  _pending: State<'_, PendingUpdate>,
) -> Result<Option<String>, String> {
  Ok(None)
}

#[cfg(not(feature = "free_standalone"))]
#[tauri::command]
async fn install_update(
  app: AppHandle,
  pending: State<'_, PendingUpdate>,
) -> Result<bool, String> {
  // Take the update stored by check_for_update; fall back to a fresh check
  let update = pending.0.lock().unwrap().take();
  let update = match update {
    Some(u) => u,
    None => {
      use tauri_plugin_updater::UpdaterExt;
      let updater = app.updater().map_err(|e| e.to_string())?;
      match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => return Ok(false),
        Err(e) => return Err(e.to_string()),
      }
    }
  };
  update.download_and_install(
    |_chunk, _total| {},
    || {},
  ).await.map_err(|e| e.to_string())?;
  let _ = app.emit("update-ready", true);
  Ok(true)
}

#[cfg(feature = "free_standalone")]
#[tauri::command]
async fn install_update(
  _app: AppHandle,
  _pending: State<'_, PendingUpdate>,
) -> Result<bool, String> {
  Ok(false)
}

#[tauri::command]
fn win_minimize(app: AppHandle) -> Result<(), String> {
  main_window(&app)?.minimize().map_err(|err| err.to_string())
}

#[tauri::command]
fn win_maximize(app: AppHandle) -> Result<(), String> {
  let window = main_window(&app)?;
  let maximized = window.is_maximized().map_err(|err| err.to_string())?;
  if maximized {
    window.unmaximize().map_err(|err| err.to_string())
  } else {
    window.maximize().map_err(|err| err.to_string())
  }
}

#[tauri::command]
fn win_close(app: AppHandle) -> Result<(), String> {
  main_window(&app)?.close().map_err(|err| err.to_string())
}

#[tauri::command]
async fn activate_key(
  key: String,
  app: AppHandle,
  store: State<'_, AppStore>,
  runtime: State<'_, RuntimeState>,
) -> Result<Value, String> {
  let normalized: String = key.trim().to_uppercase().chars().filter(|c| *c != '-').collect();
  if normalized.is_empty() {
    return Ok(json!({ "valid": false, "reason": "Invalid license key" }));
  }

  #[cfg(feature = "free_standalone")]
  {
    let _ = &store;
    let session = auth::session::AuthSession::free_standalone_dummy();
    runtime.set_authenticated(true);
    {
      let mut guard = runtime.auth_session.lock().map_err(|_| "auth session lock poisoned".to_string())?;
      *guard = Some(session.clone());
    }
    let license_val = json!({
      "valid": true,
      "key": session.key,
      "plan": session.tier,
      "tier": session.tier,
      "session_token": session.token,
      "hwid_fp": session.hwid_fp,
    });
    let _ = app.emit("license-refreshed", &license_val);
    return Ok(license_val);
  }

  #[cfg(not(feature = "free_standalone"))]
  {
    // Run anti-tamper checks before proceeding
    if let Err(e) = anti_tamper::run_checks() {
      return Ok(json!({ "valid": false, "reason": e }));
    }

    let mut last_error = None;

    let bases = license_api_bases();
    eprintln!("[activate_key] trying {} API bases: {:?}", bases.len(), bases);

    for api_base in bases {
      eprintln!("[activate_key] attempting auth against: {}", api_base);
      match auth::challenge::perform_auth(&normalized, &api_base).await {
        Ok(result) => {
        // Build a zero-padded 32-byte key from whatever was returned
        let mut key_arr = [0u8; 32];
        let src = &result.user_enc_key;
        let len = src.len().min(32);
        key_arr[..len].copy_from_slice(&src[..len]);

        let session = auth::session::AuthSession {
          token: result.session_token.clone(),
          key: normalized.clone(),
          user_enc_key: key_arr,
          tier: result.tier.clone(),
          expires_at_ms: 0, // server-side expiry is in the JWT
          hwid_fp: result.hwid_fp.clone(),
        };
        session.save_token(&store);
        runtime.set_authenticated(true);

        {
          let mut guard = runtime.auth_session.lock().map_err(|_| "auth session lock poisoned")?;
          *guard = Some(session);
        }

        let license_val = json!({
          "valid": true,
          "key": normalized,
          "plan": result.tier,
          "tier": result.tier,
          "expires_at": result.expires_at,
          "session_token": result.session_token,
          "hwid_fp": result.hwid_fp,
        });
        app.emit("license-refreshed", &license_val).map_err(|err| err.to_string())?;
        return Ok(license_val);
        }
        Err(err) => {
          eprintln!("[activate_key] auth failed for {}: {}", api_base, err);
          last_error = Some(err);
        }
      }
    }

    Ok(json!({
      "valid": false,
      "reason": last_error.unwrap_or_else(|| "Authentication failed".to_string())
    }))
  }
}

#[tauri::command]
async fn get_license(store: State<'_, AppStore>, runtime: State<'_, RuntimeState>) -> Result<Value, String> {
  #[cfg(feature = "free_standalone")]
  {
    let _ = (&store, &runtime);
    let d = auth::session::AuthSession::free_standalone_dummy();
    return Ok(json!({
      "valid": true,
      "key": d.key,
      "plan": d.tier,
      "tier": d.tier,
      "session_token": d.token,
      "hwid_fp": d.hwid_fp,
    }));
  }

  #[cfg(not(feature = "free_standalone"))]
  {
    // Check in-memory session first
    if let Ok(guard) = runtime.auth_session.lock() {
      if let Some(ref session) = *guard {
        if !session.is_expired() {
          return Ok(json!({
            "valid": true,
            "key": session.key,
            "plan": session.tier,
            "tier": session.tier,
            "session_token": session.token,
            "hwid_fp": session.hwid_fp,
          }));
        }
      }
    }

    if let Some(session) = refresh_saved_session(&store, &runtime).await {
      return Ok(json!({
        "valid": true,
        "key": session.key,
        "plan": session.tier,
        "tier": session.tier,
        "session_token": session.token,
        "hwid_fp": session.hwid_fp,
      }));
    }

    Ok(json!({ "valid": false }))
  }
}

#[tauri::command]
fn clear_license(store: State<AppStore>, runtime: State<RuntimeState>) -> Result<bool, String> {
  #[cfg(feature = "free_standalone")]
  {
    if let Ok(mut guard) = runtime.auth_session.lock() {
      *guard = None;
    }
    auth::session::AuthSession::clear(&store);
    runtime.set_authenticated(true);
    return Ok(true);
  }

  #[cfg(not(feature = "free_standalone"))]
  {
    // Clear in-memory session
    if let Ok(mut guard) = runtime.auth_session.lock() {
      *guard = None;
    }
    // Clear persisted session
    auth::session::AuthSession::clear(&store);
    runtime.set_authenticated(false);
    let _ = runtime.clear_macro_runtime_state();
    Ok(true)
  }
}

#[tauri::command]
async fn get_settings(app: AppHandle, store: State<'_, AppStore>, runtime: State<'_, RuntimeState>) -> Result<Value, String> {
  require_authenticated(&app, &store, &runtime).await?;
  match store.read_field("appSettings") {
    Value::Object(_) => Ok(store.read_field("appSettings")),
    _ => Ok(json!({})),
  }
}

#[tauri::command]
async fn save_settings(
  partial: Value,
  app: AppHandle,
  store: State<'_, AppStore>,
  runtime: State<'_, RuntimeState>,
) -> Result<Value, String> {
  require_authenticated(&app, &store, &runtime).await?;
  let merged = save_settings_partial(&store, partial)?;
  runtime.apply_runtime_settings(&merged)?;
  Ok(merged)
}

#[tauri::command]
async fn load_macro_config(app: AppHandle, store: State<'_, AppStore>, runtime: State<'_, RuntimeState>) -> Result<Value, String> {
  require_authenticated(&app, &store, &runtime).await?;
  Ok(store.read_field("macroConfig"))
}

#[tauri::command]
async fn save_macro_config(
  config: Value,
  app: AppHandle,
  store: State<'_, AppStore>,
  runtime: State<'_, RuntimeState>,
) -> Result<bool, String> {
  require_authenticated(&app, &store, &runtime).await?;
  store.update(|root| {
    root.insert("macroConfig".into(), config);
  })?;
  Ok(true)
}

#[tauri::command]
async fn send_macro_config(
  config: Value,
  app: AppHandle,
  store: State<'_, AppStore>,
  runtime: State<'_, RuntimeState>,
) -> Result<bool, String> {
  require_authenticated(&app, &store, &runtime).await?;
  // Merge slotKeys into the config so macros can read centralised bindings
  let mut cfg = config;
  if let Value::Null = cfg.get("slotKeys").unwrap_or(&Value::Null) {
    let slot_keys = store.read_field("slotKeys");
    if !slot_keys.is_null() {
      if let Some(obj) = cfg.as_object_mut() {
        obj.insert("slotKeys".into(), slot_keys);
      }
    }
  }
  runtime.update_macro_config(cfg)?;
  Ok(true)
}

#[tauri::command]
async fn load_slot_keys(
  app: AppHandle,
  store: State<'_, AppStore>,
  runtime: State<'_, RuntimeState>,
) -> Result<Value, String> {
  require_authenticated(&app, &store, &runtime).await?;
  let v = store.read_field("slotKeys");
  if v.is_null() { Ok(json!({})) } else { Ok(v) }
}

#[tauri::command]
async fn save_slot_keys(
  keys: Value,
  app: AppHandle,
  store: State<'_, AppStore>,
  runtime: State<'_, RuntimeState>,
) -> Result<bool, String> {
  require_authenticated(&app, &store, &runtime).await?;
  store.update(|root| {
    root.insert("slotKeys".into(), keys);
  })?;
  Ok(true)
}

#[tauri::command]
async fn stop_all(app: AppHandle, store: State<'_, AppStore>, runtime: State<'_, RuntimeState>) -> Result<bool, String> {
  require_authenticated(&app, &store, &runtime).await?;
  runtime.macro_runtime.stop_all();
  Ok(true)
}

#[tauri::command]
async fn get_profiles(app: AppHandle, store: State<'_, AppStore>, runtime: State<'_, RuntimeState>) -> Result<ProfilesPayload, String> {
  require_authenticated(&app, &store, &runtime).await?;
  get_profiles_payload(&store)
}

#[tauri::command]
async fn save_profile(
  id: String,
  name: String,
  config: Value,
  app: AppHandle,
  store: State<'_, AppStore>,
  runtime: State<'_, RuntimeState>,
) -> Result<bool, String> {
  require_authenticated(&app, &store, &runtime).await?;
  store.update(|root| {
    ensure_profiles(root);
    let profiles = root
      .entry("profiles")
      .or_insert_with(|| Value::Array(vec![default_profile()]));

    if let Some(profile_list) = profiles.as_array_mut() {
      if let Some(existing) = profile_list.iter_mut().find(|profile| profile.get("id").and_then(Value::as_str) == Some(id.as_str())) {
        if let Some(existing_obj) = existing.as_object_mut() {
          existing_obj.insert("name".into(), Value::String(name.clone()));
          existing_obj.insert("config".into(), config.clone());
          existing_obj.insert("updatedAt".into(), Value::from(now_ms()));
        }
      } else {
        profile_list.push(json!({
          "id": id,
          "name": name,
          "config": config,
          "createdAt": now_ms(),
          "updatedAt": now_ms()
        }));
      }
    }
  })?;
  Ok(true)
}

#[tauri::command]
async fn rename_profile(
  id: String,
  name: String,
  app: AppHandle,
  store: State<'_, AppStore>,
  runtime: State<'_, RuntimeState>,
) -> Result<bool, String> {
  require_authenticated(&app, &store, &runtime).await?;
  let next_name = name.trim();
  if next_name.is_empty() {
    return Ok(false);
  }

  store.update(|root| {
    ensure_profiles(root);
    if let Some(profile_list) = root.get_mut("profiles").and_then(Value::as_array_mut) {
      if let Some(existing) = profile_list.iter_mut().find(|profile| profile.get("id").and_then(Value::as_str) == Some(id.as_str())) {
        if let Some(existing_obj) = existing.as_object_mut() {
          existing_obj.insert("name".into(), Value::String(next_name.to_string()));
          existing_obj.insert("updatedAt".into(), Value::from(now_ms()));
        }
      }
    }
  })?;
  Ok(true)
}

#[tauri::command]
async fn delete_profile(
  id: String,
  app: AppHandle,
  store: State<'_, AppStore>,
  runtime: State<'_, RuntimeState>,
) -> Result<bool, String> {
  require_authenticated(&app, &store, &runtime).await?;
  if id == "default" {
    return Ok(false);
  }

  store.update(|root| {
    ensure_profiles(root);
    if let Some(profile_list) = root.get_mut("profiles").and_then(Value::as_array_mut) {
      profile_list.retain(|profile| profile.get("id").and_then(Value::as_str) != Some(id.as_str()));
    }
    if root.get("activeProfile").and_then(Value::as_str) == Some(id.as_str()) {
      root.insert("activeProfile".into(), Value::String("default".into()));
    }
  })?;
  Ok(true)
}

#[tauri::command]
async fn switch_profile(
  id: String,
  app: AppHandle,
  store: State<'_, AppStore>,
  runtime: State<'_, RuntimeState>,
) -> Result<bool, String> {
  require_authenticated(&app, &store, &runtime).await?;
  store.update(|root| {
    ensure_profiles(root);
    root.insert("activeProfile".into(), Value::String(id));
  })?;
  Ok(true)
}

#[tauri::command]
async fn set_focus_lock(
  enabled: bool,
  app: AppHandle,
  store: State<'_, AppStore>,
  runtime: State<'_, RuntimeState>,
) -> Result<bool, String> {
  require_authenticated(&app, &store, &runtime).await?;
  runtime.focus_lock_enabled.store(enabled, Ordering::Relaxed);
  runtime.macro_runtime.set_focus_lock_enabled(enabled);
  let mut state = runtime
    .focus_state
    .lock()
    .map_err(|_| "focus state lock poisoned".to_string())?;
  if !enabled {
    state.focused = false;
  }
  drop(state);
  emit_focus_lock_state(&app, &runtime)?;
  Ok(true)
}

#[tauri::command]
async fn toggle_stealth(app: AppHandle, _store: State<'_, AppStore>, runtime: State<'_, RuntimeState>) -> Result<bool, String> {
  toggle_stealth_window(&app, &runtime.stealth_active)
}

#[tauri::command]
async fn set_stealth_key(
  key: String,
  _app: AppHandle,
  store: State<'_, AppStore>,
  runtime: State<'_, RuntimeState>,
) -> Result<bool, String> {
  runtime.set_stealth_key(Some(key.as_str()))?;
  save_settings_partial(&store, json!({ "stealthKey": key }))?;
  Ok(true)
}

#[tauri::command]
async fn set_panic_key(
  key: String,
  app: AppHandle,
  store: State<'_, AppStore>,
  runtime: State<'_, RuntimeState>,
) -> Result<bool, String> {
  require_authenticated(&app, &store, &runtime).await?;
  runtime.set_panic_key(Some(key.as_str()))?;
  save_settings_partial(&store, json!({ "panicKey": key }))?;
  Ok(true)
}

#[tauri::command]
async fn set_click_binds(
  left: Option<String>,
  right: Option<String>,
  app: AppHandle,
  store: State<'_, AppStore>,
  runtime: State<'_, RuntimeState>,
) -> Result<bool, String> {
  require_authenticated(&app, &store, &runtime).await?;
  runtime.macro_runtime.set_click_binds(left.clone(), right.clone());

  let mut binds = runtime
    .click_binds
    .lock()
    .map_err(|_| "click binds lock poisoned".to_string())?;
  if let Some(value) = left.filter(|value| !value.trim().is_empty()) {
    binds.left = value;
  }
  if let Some(value) = right.filter(|value| !value.trim().is_empty()) {
    binds.right = value;
  }
  Ok(true)
}

#[tauri::command]
async fn set_focus_target(
  handle: Option<i64>,
  app: AppHandle,
  store: State<'_, AppStore>,
  runtime: State<'_, RuntimeState>,
) -> Result<bool, String> {
  require_authenticated(&app, &store, &runtime).await?;
  let mut state = runtime
    .focus_state
    .lock()
    .map_err(|_| "focus state lock poisoned".to_string())?;
  state.preferred_handle = handle;
  state.selected_missing = state.mode == "specific";
  drop(state);
  let _ = focus_lock::current_snapshot(&runtime.focus_state);
  emit_focus_lock_state(&app, &runtime)?;
  Ok(true)
}

#[tauri::command]
async fn set_focus_target_mode(
  mode: String,
  app: AppHandle,
  store: State<'_, AppStore>,
  runtime: State<'_, RuntimeState>,
) -> Result<bool, String> {
  require_authenticated(&app, &store, &runtime).await?;
  let normalized = match mode.trim().to_lowercase().as_str() {
    "specific" => "specific",
    _ => "all",
  };

  let mut state = runtime
    .focus_state
    .lock()
    .map_err(|_| "focus state lock poisoned".to_string())?;
  state.mode = normalized.to_string();
  state.selected_missing = normalized == "specific";
  drop(state);
  let _ = focus_lock::current_snapshot(&runtime.focus_state);
  emit_focus_lock_state(&app, &runtime)?;
  Ok(true)
}

#[tauri::command]
async fn list_mc_windows(app: AppHandle, store: State<'_, AppStore>, runtime: State<'_, RuntimeState>) -> Result<Vec<WindowInfo>, String> {
  require_authenticated(&app, &store, &runtime).await?;
  Ok(focus_lock::list_game_windows())
}

#[tauri::command]
async fn get_focus_lock_state(
  app: AppHandle,
  store: State<'_, AppStore>,
  runtime: State<'_, RuntimeState>,
) -> Result<FocusLockState, String> {
  require_authenticated(&app, &store, &runtime).await?;
  Ok(focus_lock::current_snapshot(&runtime.focus_state))
}

#[tauri::command]
async fn set_macro_count(
  count: u32,
  app: AppHandle,
  store: State<'_, AppStore>,
  runtime: State<'_, RuntimeState>,
) -> Result<bool, String> {
  require_authenticated(&app, &store, &runtime).await?;
  *runtime
    .macro_count
    .lock()
    .map_err(|_| "macro count lock poisoned".to_string())? = count;
  Ok(true)
}

#[tauri::command]
async fn pick_mc_exe(app: AppHandle, store: State<'_, AppStore>, runtime: State<'_, RuntimeState>) -> Result<Option<String>, String> {
  require_authenticated(&app, &store, &runtime).await?;
  let picked = rfd::FileDialog::new()
    .add_filter("Executables", &["exe"])
    .pick_file()
    .map(|path| path.display().to_string());

  if let Some(ref exe_path) = picked {
    store.update(|root| {
      let current = root.get("appSettings").cloned().unwrap_or_else(|| json!({}));
      let merged = shallow_merge_object(current, json!({ "mcExePath": exe_path }));
      root.insert("appSettings".into(), merged);
    })?;
  }

  Ok(picked)
}

#[tauri::command]
fn open_external(url: String) -> Result<bool, String> {
  webbrowser::open(&url)
    .map(|_| true)
    .map_err(|err| err.to_string())
}

#[tauri::command]
async fn set_chat_paused(
  paused: bool,
  app: AppHandle,
  store: State<'_, AppStore>,
  runtime: State<'_, RuntimeState>,
) -> Result<bool, String> {
  require_authenticated(&app, &store, &runtime).await?;
  runtime.chat_paused.store(paused, Ordering::Relaxed);
  runtime.macro_runtime.set_chat_paused(paused);
  if paused {
    runtime.macro_runtime.stop_all();
  }
  Ok(true)
}

#[tauri::command]
fn set_chat_key(
  key: String,
  runtime: State<'_, RuntimeState>,
) -> Result<bool, String> {
  use crate::binds::code_to_vks;
  let vk: u32 = if key.trim().is_empty() || key.trim().eq_ignore_ascii_case("none") {
    0
  } else {
    code_to_vks(key.trim())
      .and_then(|vks| vks.into_iter().next())
      .unwrap_or(0)
  };
  runtime.chat_vk.store(vk, Ordering::Relaxed);
  Ok(true)
}

#[tauri::command]
async fn set_stream_proof(
  enabled: bool,
  app: AppHandle,
  store: State<'_, AppStore>,
  _runtime: State<'_, RuntimeState>,
) -> Result<bool, String> {
  #[cfg(target_os = "windows")]
  {
    use windows_sys::Win32::UI::WindowsAndMessaging::SetWindowDisplayAffinity;
    const WDA_NONE: u32 = 0x00000000;
    const WDA_EXCLUDEFROMCAPTURE: u32 = 0x00000011;
    const WDA_MONITOR: u32 = 0x00000001;
    let window = main_window(&app)?;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    let raw_hwnd = hwnd.0 as windows_sys::Win32::Foundation::HWND;
    if enabled {
      let ok = unsafe { SetWindowDisplayAffinity(raw_hwnd, WDA_EXCLUDEFROMCAPTURE) };
      if ok == 0 {
        // Fallback for older Windows 10 builds
        let ok2 = unsafe { SetWindowDisplayAffinity(raw_hwnd, WDA_MONITOR) };
        if ok2 == 0 {
          return Err("SetWindowDisplayAffinity failed — your Windows version may not support stream-proof mode".into());
        }
      }
    } else {
      unsafe { SetWindowDisplayAffinity(raw_hwnd, WDA_NONE); }
    }
  }
  save_settings_partial(&store, json!({ "streamProofMode": enabled }))?;
  Ok(true)
}

#[tauri::command]
async fn set_disguise_app(
  enabled: bool,
  app: AppHandle,
  store: State<'_, AppStore>,
  _runtime: State<'_, RuntimeState>,
) -> Result<bool, String> {
  if let Some(window) = app.get_webview_window("main") {
    if enabled {
      let settings = store.read_field("appSettings");
      // Prefer the preset baked into this binary; fall back to the user-saved name
      let preset = read_builtin_preset();
      let title = preset
        .as_deref()
        .map(preset_display_name)
        .unwrap_or_else(|| {
          settings.get("disguiseName")
            .and_then(|v| v.as_str())
            .unwrap_or("Spotify")
        });
      let _ = window.set_title(title);
      let icon_bytes = preset.as_deref().map(preset_icon_bytes)
        .unwrap_or_else(|| include_bytes!("../icons/preset_spotify.png"));
      if let Some(img) = decode_png_icon(icon_bytes) {
        let _ = window.set_icon(img);
      }
    } else {
      let _ = window.set_title("CoreRuntime");
      if let Some(img) = decode_png_icon(include_bytes!("../icons/icon.png")) {
        let _ = window.set_icon(img);
      }
    }
    // Hide window content from taskbar thumbnail + screenshots when disguised
    #[cfg(target_os = "windows")]
    {
      use windows_sys::Win32::{
        Graphics::Dwm::DwmSetWindowAttribute,
        UI::WindowsAndMessaging::SetWindowDisplayAffinity,
      };
      const WDA_NONE: u32 = 0x00000000;
      const WDA_EXCLUDEFROMCAPTURE: u32 = 0x00000011;
      const WDA_MONITOR: u32 = 0x00000001;
      // DWMWA_FORCE_ICONIC_REPRESENTATION = 7: forces DWM to use a blank thumbnail
      const DWMWA_FORCE_ICONIC_REPRESENTATION: u32 = 7;
      // DWMWA_HAS_ICONIC_BITMAP = 10: signals we supply our own thumbnail (we don't, so it stays blank)
      const DWMWA_HAS_ICONIC_BITMAP: u32 = 10;
      let hwnd = window.hwnd().map_err(|e| e.to_string())?;
      let raw_hwnd = hwnd.0 as windows_sys::Win32::Foundation::HWND;
      if enabled {
        let ok = unsafe { SetWindowDisplayAffinity(raw_hwnd, WDA_EXCLUDEFROMCAPTURE) };
        if ok == 0 {
          unsafe { SetWindowDisplayAffinity(raw_hwnd, WDA_MONITOR); }
        }
        // Force DWM to show a blank thumbnail instead of the real window content
        let one: u32 = 1;
        unsafe {
          DwmSetWindowAttribute(raw_hwnd, DWMWA_FORCE_ICONIC_REPRESENTATION, &one as *const _ as _, 4);
          DwmSetWindowAttribute(raw_hwnd, DWMWA_HAS_ICONIC_BITMAP, &one as *const _ as _, 4);
        }
      } else {
        // Only clear affinity if stream proof isn't separately enabled
        let settings = store.read_field("appSettings");
        let stream_proof_on = settings.get("streamProofMode").and_then(|v| v.as_bool()).unwrap_or(false);
        if !stream_proof_on {
          unsafe { SetWindowDisplayAffinity(raw_hwnd, WDA_NONE); }
        }
        // Restore live DWM thumbnail
        let zero: u32 = 0;
        unsafe {
          DwmSetWindowAttribute(raw_hwnd, DWMWA_FORCE_ICONIC_REPRESENTATION, &zero as *const _ as _, 4);
          DwmSetWindowAttribute(raw_hwnd, DWMWA_HAS_ICONIC_BITMAP, &zero as *const _ as _, 4);
        }
      }
    }
  }
  save_settings_partial(&store, json!({ "disguiseApp": enabled }))?;
  Ok(true)
}

#[tauri::command]
async fn set_disguise_name(
  name: String,
  app: AppHandle,
  store: State<'_, AppStore>,
) -> Result<bool, String> {
  save_settings_partial(&store, json!({ "disguiseName": name }))?;
  // If disguise is currently active, update the window title immediately
  let settings = store.read_field("appSettings");
  let disguise_on = settings.get("disguiseApp").and_then(|v| v.as_bool()).unwrap_or(false);
  if disguise_on {
    if let Some(window) = app.get_webview_window("main") {
      let _ = window.set_title(&name);
    }
  }
  Ok(true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let mut builder = tauri::Builder::default();
  #[cfg(not(feature = "free_standalone"))]
  {
    builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
  }
  builder
    .manage(AppStore::new())
    .manage(RuntimeState::default())
    .manage(PendingUpdate::default())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      let runtime = app.state::<RuntimeState>();
      if FREE_STANDALONE {
        runtime.set_authenticated(true);
      } else {
        runtime.set_authenticated(false);
        let _ = runtime.clear_macro_runtime_state();
      }
      runtime.macro_runtime.set_app_handle(app.handle().clone());
      // Check disguise setting and apply on startup
      {
        let store = app.state::<AppStore>();
        let settings = store.read_field("appSettings");
        let disguise_on = settings.get("disguiseApp").and_then(|v| v.as_bool()).unwrap_or(false);
        if let Some(window) = app.get_webview_window("main") {
          if disguise_on {
            let preset = read_builtin_preset();
            let title = preset
              .as_deref()
              .map(preset_display_name)
              .unwrap_or_else(|| {
                settings.get("disguiseName")
                  .and_then(|v| v.as_str())
                  .unwrap_or("Spotify")
              });
            let _ = window.set_title(title);
            let icon_bytes = preset.as_deref().map(preset_icon_bytes)
              .unwrap_or_else(|| include_bytes!("../icons/preset_spotify.png"));
            if let Some(img) = decode_png_icon(icon_bytes) {
              let _ = window.set_icon(img);
            }
            // Hide window content from taskbar preview when disguised
            #[cfg(target_os = "windows")]
            {
              use windows_sys::Win32::UI::WindowsAndMessaging::SetWindowDisplayAffinity;
              const WDA_EXCLUDEFROMCAPTURE: u32 = 0x00000011;
              const WDA_MONITOR: u32 = 0x00000001;
              if let Ok(hwnd) = window.hwnd() {
                let raw = hwnd.0 as windows_sys::Win32::Foundation::HWND;
                let ok = unsafe { SetWindowDisplayAffinity(raw, WDA_EXCLUDEFROMCAPTURE) };
                if ok == 0 { unsafe { SetWindowDisplayAffinity(raw, WDA_MONITOR); } }
              }
            }
          } else {
            let _ = window.set_title("CoreRuntime");
          }
          // Re-apply stream proof on startup only if explicitly enabled.
          // Do NOT use `|| disguise_on` here — disguise mode handles its own
          // SetWindowDisplayAffinity above, and OR-ing them causes stream proof
          // to stay active even when the user has it turned off.
          let stream_proof_on = settings.get("streamProofMode").and_then(|v| v.as_bool()).unwrap_or(false);
          if stream_proof_on {
            #[cfg(target_os = "windows")]
            {
              use windows_sys::Win32::UI::WindowsAndMessaging::SetWindowDisplayAffinity;
              const WDA_EXCLUDEFROMCAPTURE2: u32 = 0x00000011;
              const WDA_MONITOR2: u32 = 0x00000001;
              if let Ok(hwnd2) = window.hwnd() {
                let raw2 = hwnd2.0 as windows_sys::Win32::Foundation::HWND;
                let ok = unsafe { SetWindowDisplayAffinity(raw2, WDA_EXCLUDEFROMCAPTURE2) };
                if ok == 0 { unsafe { SetWindowDisplayAffinity(raw2, WDA_MONITOR2); } }
              }
            }
          }
        }
      }
      runtime
        .start_focus_lock(app.handle().clone())
        .map_err(|err| std::io::Error::other(err))?;
      // Apply saved RPC settings before starting the service so the initial
      // enabled/disabled state matches what the user last saved. Without this,
      // RpcSettings::default() (enabled=true) is used and Discord presence shows
      // even when the user has turned it off.
      {
        let store = app.state::<AppStore>();
        let settings = store.read_field("appSettings");
        let _ = runtime.apply_rpc_settings(&settings);
      }
      runtime
        .start_discord_rpc()
        .map_err(|err| std::io::Error::other(err))?;
      runtime
        .start_input_hook(app.handle().clone())
        .map_err(|err| std::io::Error::other(err))?;

      #[cfg(not(feature = "free_standalone"))]
      {
      let app_handle = app.handle().clone();
      tauri::async_runtime::spawn(async move {
        let mut refresh_fail_count: u32 = 0;
        loop {
          sleep(Duration::from_secs(60)).await;

          let store = app_handle.state::<AppStore>();
          let runtime = app_handle.state::<RuntimeState>();

          // Continuous anti-tamper: kill session immediately if a debugger
          // is detected mid-session. Cost: ~1 Win32 call + microsecond loop.
          if anti_tamper::run_checks().is_err() {
            refresh_fail_count = 0;
            runtime.set_authenticated(false);
            let _ = runtime.clear_macro_runtime_state();
            auth::session::AuthSession::clear(&store);
            if let Ok(mut guard) = runtime.auth_session.lock() {
              *guard = None;
            }
            let _ = app_handle.emit("license-revoked", ());
            continue;
          }

          let has_session = runtime
            .auth_session
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
            .is_some()
            || auth::session::AuthSession::load_token(&store).is_some();

          if !has_session {
            refresh_fail_count = 0;
            runtime.set_authenticated(false);
            continue;
          }

          if refresh_saved_session(&store, &runtime).await.is_none() {
            refresh_fail_count += 1;
            // Only sign out after 3 consecutive failures (~3 min of server downtime).
            // A single blip or brief restart won't kick the user out.
            if refresh_fail_count >= 3 {
              refresh_fail_count = 0;
              runtime.set_authenticated(false);
              let _ = runtime.clear_macro_runtime_state();
              let _ = app_handle.emit("license-revoked", ());
            }
          } else {
            refresh_fail_count = 0;
          }
        }
      });
      }

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      app_version,
      win_minimize,
      win_maximize,
      win_close,
      activate_key,
      get_license,
      clear_license,
      get_settings,
      save_settings,
      load_macro_config,
      save_macro_config,
      send_macro_config,
      stop_all,
      get_profiles,
      save_profile,
      rename_profile,
      delete_profile,
      switch_profile,
      set_focus_lock,
      toggle_stealth,
      set_stealth_key,
      set_panic_key,
      set_click_binds,
      set_focus_target,
      set_focus_target_mode,
      list_mc_windows,
      get_focus_lock_state,
      set_macro_count,
      pick_mc_exe,
      open_external,
      set_chat_paused,
      set_chat_key,
      set_stream_proof,
      set_disguise_app,
      set_disguise_name,
      check_for_update,
      install_update,
      load_slot_keys,
      save_slot_keys
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
