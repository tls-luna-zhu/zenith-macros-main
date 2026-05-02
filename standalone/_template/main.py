"""
Zenith Macros — MY MACRO NAME  (standalone CLI)
================================================
HOW TO CREATE A NEW STANDALONE CLI:
  1. Copy this whole _template/ folder → standalone/my_macro_name/
  2. Fill in the 4 constants below (PRODUCT_ID, APP_NAME, VERSION, CONFIG_FILE)
  3. Replace the DEFAULTS dict with your macro's config fields
  4. Implement run_macro(cfg) in macro.py
  5. Customise the settings menu in setup_settings() if needed
  6. Run build.bat to produce the .exe

That's it. Everything else (auth, config save/load, UI, keybind listen) is handled
by the shared/ modules — you don't touch those.

KEY NOTES:
  - The macro needs admin to send keys to other processes. The admin elevation is
    handled automatically below — just keep that block as-is.
  - Add "panic_key" to your DEFAULTS and pass it through cfg; the shared listener
    handles stopping when it's pressed.
  - For input: use keyboard.press/release for keys, mouse.press/release for clicks.
    Import both at the top of macro.py.
"""
import sys
import os

# ── Admin elevation (required for keyboard/mouse injection) ───────────────────
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    os.system("")  # enable ANSI
    import ctypes
    if not ctypes.windll.shell32.IsUserAnAdmin():
        script = sys.argv[0]
        params = " ".join(f'"{a}"' for a in sys.argv[1:])
        if getattr(sys, "frozen", False):
            ctypes.windll.shell32.ShellExecuteW(None, "runas", script, params, None, 1)
        else:
            ctypes.windll.shell32.ShellExecuteW(
                None, "runas", sys.executable, f'"{script}" {params}', None, 1
            )
        sys.exit(0)

# Auto-install required packages if missing
def _ensure_deps():
    import importlib, subprocess
    required = {"keyboard": "keyboard", "mouse": "mouse", "colorama": "colorama"}
    missing  = [pkg for mod, pkg in required.items() if importlib.util.find_spec(mod) is None]
    if missing:
        print(f"  Installing missing packages: {', '.join(missing)} ...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet"] + missing)
        print()
_ensure_deps()

# Add shared/ to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "shared"))

import zenith_config as cfg_mod
import zenith_ui     as ui

# ── CONFIGURE THESE FOUR THINGS ───────────────────────────────────────────────
PRODUCT_ID   = "zenith-my-macro"       # Must match the id in the products table
APP_NAME     = "My Macro"              # Display name shown in the banner
VERSION      = "1.0.0"
CONFIG_FILE  = "my_macro.json"         # Saved in ~/.zenith/
# ─────────────────────────────────────────────────────────────────────────────

# ── YOUR MACRO'S DEFAULT CONFIG ───────────────────────────────────────────────
DEFAULTS = {
    "license_key":     "",
    "session_token":   "",
    "keybind":         "",
    "panic_key":       "",       # instant kill switch — leave blank to disable
    # Add your macro-specific fields here:
    # "delay_ms":      27,
    # "some_key":      "4",
    # "right_click_key": "mouse2",
}
# ─────────────────────────────────────────────────────────────────────────────


def setup_keybind(cfg: dict) -> dict:
    print()
    ui.sep()
    ui.info("Common keys: F, G, H, V, Mouse4, Mouse5 …")
    cfg["keybind"] = ui.prompt("Keybind", cfg.get("keybind") or "F").strip()
    cfg_mod.save(CONFIG_FILE, cfg)
    ui.ok(f"Keybind set to [{cfg['keybind'].upper()}]")
    return cfg


def setup_settings(cfg: dict) -> dict:
    """Customise this for your macro's specific settings."""
    print()
    ui.sep()
    # Example:
    # cfg["delay_ms"] = int(ui.prompt("Delay (ms)", str(cfg.get("delay_ms", 27))) or 27)
    # cfg["some_key"] = ui.prompt("Some slot key", cfg.get("some_key", "4"))

    # Panic key — keep this in every macro
    ui.info("Panic key: press to instantly stop the macro. Leave blank to disable.")
    cfg["panic_key"] = ui.prompt("Panic key", cfg.get("panic_key", "")).strip()

    cfg_mod.save(CONFIG_FILE, cfg)
    ui.ok("Settings saved.")
    return cfg


def show_config(cfg: dict) -> None:
    print()
    ui.sep()
    key = cfg.get("license_key", "")
    masked = (key[:4] + "-****-****-****-" + key[-4:]) if len(key) >= 8 else "(not set)"
    panic  = cfg.get("panic_key", "") or "(none)"
    print(f"  {'License key':<22} {masked}")
    print(f"  {'Keybind':<22} {cfg.get('keybind', '(not set)').upper()}")
    print(f"  {'Panic key':<22} {panic.upper()}")
    # Print your extra fields here:
    # print(f"  {'Delay (ms)':<22} {cfg.get('delay_ms', 27)}")
    ui.sep()


def start_macro(cfg: dict) -> None:
    """Replace the import and call with your macro module."""
    import macro  # noqa: F401  — implement run_macro(cfg) in macro.py
    if not cfg.get("keybind"):
        ui.err("Set a keybind first (option 2).")
        ui.pause()
        return
    print()
    macro.start_listening(cfg)
    print()
    ui.info("Stopped.")
    ui.pause()


def main_menu(cfg: dict) -> None:
    while True:
        print(ui.banner(APP_NAME, VERSION))
        kb    = cfg.get("keybind")  or "(not set)"
        panic = cfg.get("panic_key") or "(none)"
        print(f"  Keybind: [{kb.upper()}]  |  Panic: [{panic.upper()}]")
        print()
        print("  [1] Start")
        print("  [2] Change keybind")
        print("  [3] Change settings")
        print("  [4] View current config")
        print("  [5] Re-verify license")
        print("  [0] Exit")
        print()

        choice = input("  Choice: ").strip()

        if choice == "1":
            start_macro(cfg)
        elif choice == "2":
            cfg = setup_keybind(cfg)
            ui.pause()
        elif choice == "3":
            cfg = setup_settings(cfg)
            ui.pause()
        elif choice == "4":
            show_config(cfg)
            ui.pause()
        elif choice == "5":
            cfg = ui.do_verify(cfg, PRODUCT_ID, CONFIG_FILE, force=True)
            ui.pause()
        elif choice == "0":
            print()
            ui.ok("Goodbye!")
            sys.exit(0)


def main() -> None:
    cfg = cfg_mod.load(CONFIG_FILE, DEFAULTS)
    is_first = not cfg.get("license_key") or not cfg.get("session_token")

    if is_first:
        print(ui.banner(APP_NAME, VERSION))
        ui.info("Welcome! Let's get you set up.")
        cfg = ui.do_verify(cfg, PRODUCT_ID, CONFIG_FILE)
        if not cfg.get("session_token"):
            ui.pause("Press Enter to exit…")
            sys.exit(1)
        cfg = setup_keybind(cfg)
        cfg = setup_settings(cfg)
        print()
        ui.ok("All done! Ready to use.")
        ui.pause("Press Enter to open the main menu…")

    main_menu(cfg)


if __name__ == "__main__":
    main()
