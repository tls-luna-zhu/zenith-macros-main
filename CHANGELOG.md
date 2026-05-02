# Changelog

## 1.2.3 - 2026-04-12
- Added Auto Stun Slam (ASS) macro: automatically fires the full Stun Slam sequence when the crosshair turns blue (requires Adv. Crosshair mod)
- Auto Stun Slam now counts as an active macro and shows an ACTIVE/INACTIVE status indicator on its card, matching Triggerbot
- Auto Stun Slam auto-deactivates when alt-tabbing out of Minecraft
- Fixed Auto Stun Slam first-fire latency: removed unnecessary window enumeration call before each sequence, and pre-cache SS config at toggle time
- Stun Slam: removed redundant window focus call before execution for lower latency
- Added Discord support ticket panel (`/ticketpanel` command) with dropdown select menu (General Support, License Issue, Bug Report, DonutSMP Pay)
- DonutSMP Pay ticket flow prompts for license tier (Monthly / Lifetime) before opening the ticket channel
- Disabled right-click context menu in the app renderer

## 1.2.1 - 2026-04-05
- Added KB Disposal macro (Sword section): bind separate Left and Right keys to instantly flick your view, land a hit, then snap back — server registers your flicked angle for directional knockback
- Fixed macro action toggles: deselecting an action (e.g. EXPLODE, RETURN, SWAP) now actually skips that step at runtime — previously the UI toggle had no effect
- Triggerbot now auto-deactivates when tabbing out of Minecraft
- Fixed blue crosshair detection (relaxed threshold to catch typical PvP blue values)
- Multi-scale arm sampling: triggerbot now samples at three offsets (5, 8, 11 px) to work across all Minecraft GUI scales (1–4)
- Restored fullscreen compatibility: PrintWindow fallback for exclusive fullscreen / hardware-accelerated windows
- Performance: desktop DC opened once per loop tick instead of per pixel (4× fewer GDI calls)
- Added Queue Sniper browser tool to dashboard Downloads → Extras
- Session extended to 24-hour auto-login (no more re-login every 15 minutes)

## 1.2.0 - 2026-04-02
- Migrated primary project baseline to Tauri + Rust client runtime with Python backend auth as the source of truth
- Added backend compatibility routes for website/dashboard and Discord bot flows: `/auth/discord/*`, `/api/dashboard/*`, `/api/pricing`, `/api/create-checkout`, and `/api/bot/*`
- Added secure dashboard session cookie flow with server-side session tracking and Discord OAuth login path
- Kept existing website UI connected to the new backend auth stack (no client-side trust for dashboard data)
- Added Fly migration deploy path for backend + website from one container image (`backend/Dockerfile` + root `fly.toml`)
- Removed legacy Electron/server/native runtime surfaces from the main repo migration baseline

## 1.1.6 - 2026-03-27
- Added Macro Studio improvements and recorder reliability fixes
- Recording toggle now controls mouse movement capture only, while still recording mouse button clicks
- Fixed stale recorder state handling that could show "already recording" incorrectly
- Stability and bug-fix pass across settings/auth persistence and macro runtime behavior

## 1.1.5 - 2026-03-23
- Bug-fix update for focus lock and Minecraft instance detection reliability
- Fixed startup detection race where clients launched after Minecraft could still show "No instance"
- Improved focus-state syncing so background Minecraft is detected consistently and macros remain suspended while unfocused
- Fixed license activation compatibility issues that caused request-signature errors for some users
- General stability fixes for auth/session refresh and runtime behavior

## 1.1.4 - 2026-03-23
- Security hardening release: added packaged build integrity verification for critical app files at startup and periodic runtime checks
- Added native-backed runtime session sealing so macro runtime unlock depends on a native cryptographic seal tied to active license session data
- Added lease-proof verification path in the client for runtime lease responses and server lease-proof signing fields on auth endpoints
- Hardened auth telemetry with build watermark propagation and per-license last-seen client metadata tracking
- Strengthened API version policy with required client version support and explicit minimum-version enforcement
- Packaging hardening pass to reduce bundled reverse-engineering surface by excluding unnecessary dependency source/docs/test artifacts

## 1.1.3 - 2026-03-23
- Premium UI polish pass: improved icon rendering/centering quality, logo animation consistency, and cleaned up horizontal overflow artifacts
- Added shared key normalization across renderer, macro engine, and input runtime so special keys (`PageUp`, `PageDown`, `CapsLock`, `NumLock`, `ScrollLock`, `PrintScreen`, `Alt`, `Ctrl`, etc.) can be set, trigger macros, and be fired by macros reliably
- Macro input reliability optimizations: unified keysender key mapping to fix case-sensitive special-key misses on some Windows devices
- Security/stability hardening pass across client/server/bot surfaces with safer key normalization and stricter runtime handling
- General optimization and bug-fix release for macro execution, bind capture, and release consistency

## 1.1.0 - 2026-03-20
- Triggerbot targeting fix: only fires on valid center crosshair red/blue states, with stricter color filtering to stop random hits on world blocks
- Triggerbot reliability fix: improved center-pixel fallback sampling so red/blue target states are detected more consistently
- Auto Crystal defaults update: default delay set to 25ms across UI and runtime fallbacks
- Added optional `Stream-proof mode` setting (default OFF): screenshots/screenshares are allowed by default and can be blocked when toggled on
- Website release labels updated to show `v1.1.0` as the live build

## 1.0.24 - 2026-03-13
- Triggerbot false-hit hotfix: tightened red/blue signal thresholds to avoid firing on world textures (wood/stone/map colors)
- Triggerbot targeting hotfix: require plus-crosshair signal shape (center/arms) before clicking, reducing random out-of-range hits
- Triggerbot fullscreen/multi-DPI stability: improved center-point coordinate conversion with primary-display fallback probe

## 1.0.23 - 2026-03-13
- Fixed auto-update release path by shipping NSIS + update metadata while keeping portable builds separate
- Removed package bloat by tightening bundled files (server/tmp/debug assets excluded from app bundle)
- Reworked shutdown/update flow to avoid hard process exits and reduce forced-close reports
- Hardened license activation/validation fallback so valid paid keys continue working during transient API outages
- Added stronger HTTP security headers for website/license-server surfaces
- Added dedicated Discord bot key-create API path so `/key_create` works even when admin API/panel is disabled
- Improved Stripe purchase delivery reliability with customer-email fallback lookup, email retry attempts, and purchase email resend support from the website success toast
- Switched Windows distribution to portable-only release output (no installer package)
- Triggerbot reliability hotfix: broader red/blue detection and active-display center sampling (better multi-monitor behavior)
- Triggerbot fullscreen compatibility hotfix: GLFW class matcher widened and monitor-center math corrected for non-primary displays
- Restored branded Windows icon in build output and reverted artifact naming to `ZenithMacros-<version>.exe`

## 1.0.22 - 2026-03-13
- Stability and startup fixes for packaged builds
- Fixed no-window launch behavior in release binaries
- Auto-update feed/package metadata refreshed for reliable updates
- General bug fixes and crash fixes

## 1.0.21 - 2026-03-13
- Bug fixes and crash fixes
- Optimized UI and macros
- Triggerbot fixes and reliability improvements

## 2026-03-13
- Bug fixes and crash fixes
- Optimized UI and macros
- Triggerbot fixes and reliability improvements
