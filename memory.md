## Project Structure

- `package.json`: root Electron app entry and npm scripts.
- Current workspace is a standalone folder export with no `.git` metadata or configured remotes.
- `electron/`: main-process runtime, preload bridge, updater, licensing, tray, focus lock, settings, anti-debug/anti-vm, native secure wrapper.
- `renderer/`: single-file renderer UI in `index.html`.
- `src-tauri/`: parallel Tauri 2 app scaffold with Rust backend, capabilities, and desktop bundle config.
- `dist-tauri/`: clean Tauri outputs for direct local testing (`ZenithMacros-debug.exe`, `ZenithMacros.exe`, installer EXE, MSI).
- `macros/`: macro engine, input handling, triggerbot, anti-detect, click binds, bundled AHK/script presets.
- `assets/`: app icons and branding.
- `scripts/`: local startup and release/build metadata scripts.
- `analysis/`: migration and parity notes for the Electron -> Tauri port.
- Ancillary repo surfaces (`server/`, `discord-bot/`, `website/`, root `.github/`, root `fly.toml`) have been removed to keep the workspace app-only.
- Root release docs have been trimmed; remaining top-level files are focused on app runtime, packaging, and local memory.
- The old `native/` addon tree has been removed; secure hashing/device-key helpers now live in pure JS under `electron/native-secure.js`.

## Key Systems

- App bootstrap: `scripts/start.js` launches local Electron if installed, otherwise tries a packaged EXE from `dist/win-unpacked`.
- Main process: `electron/main.js` owns window creation, IPC, licensing/runtime lease state, updater flow, global shortcuts, panic/chat hooks, focus lock, optimizer hooks, and shutdown cleanup.
- Renderer bridge: `electron/preload.js` exposes the `window.zenith` IPC surface used by the UI.
- UI: `renderer/index.html` contains the full auth/app shell, styles, and renderer logic. `renderer/tauri-bridge.js` now recreates `window.zenith` for the Tauri runtime while remaining a no-op in Electron.
- Macro runtime: `macros/engine.js`, `macros/input.js`, and `macros/triggerbot.js` coordinate macro execution and input dispatch.
- Macro pages now expose `Crystal`, `Sword`, `Mace`, `Cart`, and `UHC` categories in the renderer; the old `Spear` category and `Macro Studio` page have been removed from the visible UI.
- Security helpers: `electron/native-secure.js` now provides pure JS hashing, HMAC, timing-safe compare, runtime seal, and device-key helpers.
- Tauri runtime: `src-tauri/src/lib.rs` now provides the first backend slice for window controls, release-only auth against the hosted backend, settings/profile/macro-config storage, a compiled macro keybind registry, a Windows low-level keyboard hook service, a native Minecraft window/focus detector, a Rust macro executor for the built-in module set, recorder placeholders, and external link handling.
- Tauri public bundle is now hardened for release packaging: unfinished optimizer/recorder surfaces are removed from the shipped bridge/UI, release bundles are produced through `npm run tauri:build`, and `csp: null` is currently required because the renderer still uses inline handlers/styles.
- Tauri app hotkeys: the same Rust low-level hook now also owns native panic and stealth key listeners from Settings, and the Tauri bridge forwards `toggleStealth`, `setStealthKey`, `setPanicKey`, and `stopAll` into the backend instead of leaving them as no-ops.
- Tauri Discord RPC: `src-tauri/src/discord_rpc.rs` now runs a native Discord Rich Presence worker with fixed Zenith assets/buttons, default-on enablement, and default-on anonymous username masking controlled from Settings.

## Important Relationships

- `electron/main.js` imports macro modules from `macros/` and settings/tray/focus helpers from `electron/`.
- `renderer/index.html` talks to the main process only through APIs exposed in `electron/preload.js`.
- In Tauri, the renderer targets the same logical `window.zenith` API through `renderer/tauri-bridge.js`, backed by Rust commands in `src-tauri/src/lib.rs`.
- The Tauri keyboard hook lives in `src-tauri/src/input_hook.rs` and consumes the renderer-sent macro config through a Rust bind compiler in `src-tauri/src/binds.rs`.
- The Tauri hook thread now also matches app-level panic/stealth bindings and uses native window controls (`hide/show/set_skip_taskbar`) so those settings work while Minecraft is focused.
- The Tauri Minecraft detector now lives in `src-tauri/src/focus_lock.rs`; it mirrors the Electron GLFW/SunAwt/title heuristics, polls foreground state on Windows, and feeds `list_mc_windows`, `get_focus_lock_state`, `mc-running-changed`, and `focus-lock-changed`.
- The Tauri macro executor now lives in `src-tauri/src/macro_runtime.rs`; the keyboard hook forwards trigger events into Rust-side built-in macro execution, hold-macro loops (`fxp`, `ac`), recorded-sequence playback, and shared click-bind state.
- The Discord RPC worker derives presence from the existing focus-lock state, macro count, and current Minecraft window title; it defaults to `Anonymous-XXXX` usernames unless the new Settings toggle is turned off.
- `send_macro_config` in the Tauri backend now rebuilds the compiled keyboard binding registry immediately, so frontend config changes feed the low-level hook without adding a new transport layer.
- The renderer titlebar minus button is now the actual minimize action again; stealth remains available through the native settings hotkey/backend toggle instead of occupying the visible window control.
- The Settings page now includes `Discord RPC` and `Hide RPC username` toggles, both defaulting on when no saved value exists.
- Tauri release branding now comes from `src-tauri/tauri.conf.json` and regenerated assets in `src-tauri/icons/`, and the shipped Windows EXE no longer depends on the transient dev asset server.
- Packaging includes `electron/**/*`, `macros/**/*`, `renderer/**/*`, and `assets/**/*` only.
- Input-hook integration is now optional at runtime; the app starts cleanly without any compiled addon tree.
- Root npm scripts are now focused on the Electron app and Windows packaging only.
- Packaging excludes have been tightened to match the folders that still exist in the repo.
- Client auth no longer embeds a reusable shared secret; the backend now issues signed challenges and server-signed session JWTs.
- Tauri currently targets `http://127.0.0.1:5000` only, persists its auth session in Windows-protected local storage, and revalidates saved sessions against `/v1/session/refresh` on startup instead of trusting only local cache.
- Backend licenses now carry a rotating `session_nonce`; every successful auth rotates it and refresh rejects stale tokens, so older saved sessions are invalidated server-side after a new login.
- Backend startup now requires a real `ZENITH_SECRET_KEY`; `backend/config.py` loads `backend/.env` directly for localhost use so production no longer falls back to a predictable secret.
- Refresh security is stronger: refresh now verifies the JWT signature even for recently expired tokens, looks up the license by signed token `lid` instead of scanning the whole table, and rotates `session_nonce` on refresh to invalidate the previous token immediately.
- Tauri relaunch auto-login now attempts backend refresh even when the cached JWT is locally expired, so matching-HWID sessions can still recover inside the backend refresh window instead of being cleared client-side first.
- Localhost refresh debugging uncovered a stale Flask-process issue; `backend/auth/session.py` now uses a local `secrets` import inside `refresh_session()` and the refresh route returns a real 500 on commit failure instead of silently succeeding.
- Logout/login flow now resets the auth overlay button/error/input state in the renderer, and Tauri startup no longer clears saved sessions before the backend refresh path has a chance to validate them.
- Tauri now enforces a Rust-side auth guard for the main application commands: protected commands first require a live in-memory session or a successful backend refresh, emit `license-revoked` on failure, and no longer rely on the renderer login gate alone.
- The macro engine itself is now auth-aware: runtime auth state defaults off, startup no longer preloads user macro/settings state before login, logout/revocation clears in-memory bindings/config, and a background session watcher refreshes against the backend every minute so macro execution is shut off if the session goes invalid.
