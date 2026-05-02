use crate::FocusLockState;
use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use std::{
  collections::hash_map::DefaultHasher,
  env,
  hash::{Hash, Hasher},
  sync::{mpsc, Arc, Mutex},
  thread::{self, JoinHandle},
  time::{Duration, SystemTime, UNIX_EPOCH},
};

const CLIENT_ID: &str = "1488562648214929429";
const DISCORD_BUTTON_LABEL: &str = "Join Zenith Discord";
const DISCORD_BUTTON_URL: &str = "https://discord.gg/tGtPqqE9ms";
const BUY_BUTTON_LABEL: &str = "Buy Zenith Now";
const BUY_BUTTON_URL: &str = "https://zenithmacros.store/";
const POLL_MS: u64 = 1000;

pub type SharedRpcSettings = Arc<Mutex<RpcSettings>>;

#[derive(Clone, Debug)]
pub struct RpcSettings {
  pub enabled: bool,
  pub hide_username: bool,
}

impl Default for RpcSettings {
  fn default() -> Self {
    Self {
      enabled: true,
      hide_username: true,
    }
  }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PresenceSnapshot {
  details: String,
  state: String,
  large_image: String,
  large_text: String,
  /// Unix seconds — kept constant per session so the timer never resets
  start_time: i64,
}

pub struct DiscordRpcService {
  stop_tx: Option<mpsc::Sender<()>>,
  thread: Option<JoinHandle<()>>,
}

impl DiscordRpcService {
  pub fn start(
    rpc_settings: SharedRpcSettings,
    focus_state: Arc<Mutex<FocusLockState>>,
    macro_count: Arc<Mutex<u32>>,
  ) -> Result<Self, String> {
    let (stop_tx, stop_rx) = mpsc::channel::<()>();

    // Capture session start once — this is what drives the elapsed timer in Discord
    let session_start = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .unwrap_or_default()
      .as_secs() as i64;

    let thread = thread::spawn(move || {
      let mut client: Option<DiscordIpcClient> = None;
      let mut last_presence: Option<PresenceSnapshot> = None;

      loop {
        let settings = rpc_settings.lock().map(|v| v.clone()).unwrap_or_default();

        if !settings.enabled {
          if let Some(mut connected) = client.take() {
            let _ = connected.clear_activity();
            let _ = connected.close();
          }
          last_presence = None;
        } else {
          if client.is_none() {
            client = connect_client();
            if client.is_some() {
              last_presence = None;
            }
          }

          let presence = build_presence(
            &focus_state,
            &macro_count,
            settings.hide_username,
            session_start,
          );

          if last_presence.as_ref() != Some(&presence) {
            if let Some(connected) = client.as_mut() {
              if set_activity(connected, &presence).is_ok() {
                last_presence = Some(presence);
              } else {
                let _ = connected.close();
                client = None;
                last_presence = None;
              }
            }
          }
        }

        match stop_rx.recv_timeout(Duration::from_millis(POLL_MS)) {
          Ok(_) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
          Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
      }

      if let Some(mut connected) = client {
        let _ = connected.clear_activity();
        let _ = connected.close();
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

impl Drop for DiscordRpcService {
  fn drop(&mut self) {
    self.stop();
  }
}

fn connect_client() -> Option<DiscordIpcClient> {
  let mut client = DiscordIpcClient::new(CLIENT_ID).ok()?;
  client.connect().ok()?;
  Some(client)
}

fn rpc_large_image() -> &'static str {
  if cfg!(debug_assertions) { "zenith-dev" } else { "zenith" }
}

fn rpc_title() -> &'static str {
  if cfg!(debug_assertions) { "Developer Build" } else { "Best Minecraft Macros" }
}

fn set_activity(client: &mut DiscordIpcClient, presence: &PresenceSnapshot) -> Result<(), String> {
  let payload = activity::Activity::new()
    .activity_type(activity::ActivityType::Playing)
    .details(&presence.details)
    .state(&presence.state)
    .timestamps(activity::Timestamps::new().start(presence.start_time))
    .assets(
      activity::Assets::new()
        .large_image(&presence.large_image)
        .large_text(&presence.large_text),
    )
    .buttons(vec![
      activity::Button::new(DISCORD_BUTTON_LABEL, DISCORD_BUTTON_URL),
      activity::Button::new(BUY_BUTTON_LABEL, BUY_BUTTON_URL),
    ]);

  client.set_activity(payload).map_err(|e| e.to_string())
}

fn build_presence(
  focus_state: &Arc<Mutex<FocusLockState>>,
  macro_count: &Arc<Mutex<u32>>,
  hide_username: bool,
  start_time: i64,
) -> PresenceSnapshot {
  let _focus = focus_state.lock().map(|v| v.clone()).unwrap_or_default();
  let count = macro_count.lock().map(|v| *v).unwrap_or(0);

  let username = if hide_username { anonymous_username() } else { visible_username() };
  let ver = env!("CARGO_PKG_VERSION");

  // Details line — dynamic: show active macro count when any are running
  let details = if count > 0 {
    format!("Running {} macro{}", count, if count == 1 { "" } else { "s" })
  } else {
    rpc_title().to_string()
  };

  // State line — "Anonymous-5F84 • v1.2.7"
  let state = truncate_text(&format!("{username} • v{ver}"), 120);

  // Large image tooltip
  let large_text = truncate_text(&format!("Zenith Macros v{ver} • {username}"), 120);

  PresenceSnapshot {
    details,
    state,
    large_image: rpc_large_image().to_string(),
    large_text,
    start_time,
  }
}

fn visible_username() -> String {
  let raw = env::var("USERNAME")
    .or_else(|_| env::var("USER"))
    .unwrap_or_else(|_| "Player".to_string());
  truncate_text(raw.trim(), 24)
}

fn anonymous_username() -> String {
  let source = visible_username();
  let mut hasher = DefaultHasher::new();
  source.hash(&mut hasher);
  format!("Anonymous-{:04X}", (hasher.finish() & 0xFFFF) as u16)
}

fn truncate_text(value: &str, max_chars: usize) -> String {
  let trimmed = value.trim();
  if trimmed.is_empty() {
    return "Unknown".to_string();
  }
  let collected: String = trimmed.chars().take(max_chars).collect();
  if collected.is_empty() { "Unknown".to_string() } else { collected }
}
