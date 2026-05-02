(function () {
  if (window.zenith) return;

  const tauri = window.__TAURI__ || {};
  const internals = window.__TAURI_INTERNALS__ || {};
  const invoke = tauri?.core?.invoke || internals?.invoke;
  const listen = tauri?.event?.listen;

  if (typeof invoke !== 'function') {
    window.__zenithBridgeError = 'Tauri invoke bridge unavailable';
    return;
  }

  const defaultFocusState = () => ({
    running: false,
    focused: false,
    mode: 'all',
    preferredHandle: null,
    gameWindowCount: 0,
    effectiveWindowCount: 0,
    requiresSelection: false,
    selectedMissing: false,
  });

  const defaultProfiles = () => ({
    profiles: [{ id: 'default', name: 'Default', config: null, createdAt: Date.now(), updatedAt: Date.now() }],
    activeProfile: 'default',
  });

  const command = (name, args = {}, fallback = null) =>
    invoke(name, args).catch((error) => {
      console.error(`[zenith bridge] command failed: ${name}`, error);
      return fallback;
    });

  const fireAndForget = (name, args = {}) => {
    invoke(name, args).catch((error) => {
      console.error(`[zenith bridge] fire-and-forget failed: ${name}`, error);
    });
  };

  const subscribe = (eventName, cb) => {
    if (typeof listen !== 'function') return;
    Promise.resolve(
      listen(eventName, (event) => cb?.(event?.payload))
    ).catch(() => {});
  };

  window.zenith = {
    version: '1.2.8',
    getAppVersion: () => command('app_version', {}, '1.2.8'),
    isDevAuthEnabled: () => Promise.resolve(false),
    minimize: () => fireAndForget('win_minimize'),
    maximize: () => fireAndForget('win_maximize'),
    close: () => fireAndForget('win_close'),

    activateKey: (key) => command('activate_key', { key }, { valid: false, reason: 'not-implemented' }),
    getLicense: () => command('get_license', {}, null),
    clearLicense: () => command('clear_license', {}, true),
    onLicenseRevoked: (cb) => subscribe('license-revoked', cb),
    onLicenseRefreshed: (cb) => subscribe('license-refreshed', cb),

    sendMacroConfig: (config) => fireAndForget('send_macro_config', { config }),
    startMacroRecorder: undefined,
    stopMacroRecorder: undefined,
    getMacroRecorderStatus: undefined,
    onMacroKeyDown: (cb) => subscribe('macro-key-down', cb),
    onMacroKeyUp: (cb) => subscribe('macro-key-up', cb),
    onMacroTrigger: (cb) => subscribe('macro-trigger', cb),
    setRecorderHotkey: undefined,
    onRecorderHotkey: undefined,
    onRecorderEvent: undefined,
    stopAll: () => fireAndForget('stop_all'),
    setFocusLock: (enabled) => fireAndForget('set_focus_lock', { enabled }),
    setFocusTarget: (handle) => fireAndForget('set_focus_target', { handle }),
    setFocusTargetMode: (mode) => fireAndForget('set_focus_target_mode', { mode }),
    listMcWindows: () => command('list_mc_windows', {}, []),
    getFocusLockState: () => command('get_focus_lock_state', {}, defaultFocusState()),
    sendMacroCount: (count) => fireAndForget('set_macro_count', { count }),

    toggleStealth: () => command('toggle_stealth', {}, false),
    setStealthKey: (key) => fireAndForget('set_stealth_key', { key }),
    setPanicKey: (key) => fireAndForget('set_panic_key', { key }),

    getSettings: () => command('get_settings', {}, {}),
    saveSettings: (settings) => fireAndForget('save_settings', { partial: settings }),
    pickMcExe: () => command('pick_mc_exe', {}, null),

    loadMacroConfig: () => command('load_macro_config', {}, null),
    saveMacroConfig: (config) => fireAndForget('save_macro_config', { config }),

    loadSlotKeys: () => command('load_slot_keys', {}, {}),
    saveSlotKeys: (keys) => fireAndForget('save_slot_keys', { keys }),

    getProfiles: () => command('get_profiles', {}, defaultProfiles()),
    saveProfile: (id, name, config) => fireAndForget('save_profile', { id, name, config }),
    renameProfile: (id, name) => fireAndForget('rename_profile', { id, name }),
    deleteProfile: (id) => fireAndForget('delete_profile', { id }),
    switchProfile: (id) => fireAndForget('switch_profile', { id }),

    onFocusChanged: (cb) => subscribe('focus-lock-changed', cb),
    onMcRunning: (cb) => subscribe('mc-running-changed', cb),
    onFocusLockState: (cb) => subscribe('focus-lock-state', cb),
    onPanicAll: (cb) => subscribe('panic-all', () => cb?.()),

    setClickBinds: (cfg) => fireAndForget('set_click_binds', {
      left: cfg?.left || null,
      right: cfg?.right || null,
    }),

    applyOpt: undefined,
    revertOpt: undefined,
    getAppliedOpts: undefined,

    setChatKey: (key) => fireAndForget('set_chat_key', { key: key || 'None' }),
    setChatTimer: () => {},
    setChatPaused: (paused) => fireAndForget('set_chat_paused', { paused }),
    onChatPaused: (cb) => subscribe('chat-paused', () => cb?.()),
    onChatResumed: (cb) => subscribe('chat-resumed', () => cb?.()),

    setStreamProof: (enabled) => fireAndForget('set_stream_proof', { enabled }),
    setDisguiseApp: (enabled) => fireAndForget('set_disguise_app', { enabled }),

    checkForUpdate: () => command('check_for_update', {}, null),
    installUpdate: () => command('install_update', {}, false),
    onUpdateReady: (cb) => subscribe('update-ready', () => cb?.()),

    openExternal: (url) => fireAndForget('open_external', { url }),
    onTbStatus: (cb) => subscribe('tb-status', cb),
    onTbDetecting: (cb) => subscribe('tb-detecting', cb),
    onAssStatus: (cb) => subscribe('ass-status', cb),
  };
})();
