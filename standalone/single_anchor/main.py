"""
Zenith Macros — Single Anchor  (standalone CLI)
================================================
Requires: Python 3.10+, keyboard, colorama
Run: python main.py   or   ZenithSingleAnchor.exe
"""
import sys
import os

# Windows: force UTF-8 so box-drawing characters render correctly
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    os.system("")  # enable ANSI escape processing in Windows console

    # Require admin — keyboard/mouse libs need it to inject input into other processes
    import ctypes
    if not ctypes.windll.shell32.IsUserAnAdmin():
        script = os.path.abspath(sys.argv[0])
        extra  = " ".join(f'"{a}"' for a in sys.argv[1:])
        if getattr(sys, "frozen", False):
            ctypes.windll.shell32.ShellExecuteW(None, "runas", script, extra or None, None, 1)
        else:
            args = f'"{script}"'
            if extra:
                args += f" {extra}"
            ctypes.windll.shell32.ShellExecuteW(None, "runas", sys.executable, args, None, 1)
        sys.exit(0)

# Auto-install required packages if missing
def _ensure_deps():
    import importlib, subprocess
    required = {"keyboard": "keyboard", "mouse": "mouse", "colorama": "colorama"}
    missing  = [pkg for mod, pkg in required.items() if importlib.util.find_spec(mod) is None]
    if missing:
        print(f"  Installing missing packages: {', '.join(missing)} ...")
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install"] + missing,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
        except Exception as e:
            print(f"  [!] Auto-install failed: {e}")
            print(f"  Run manually: pip install {' '.join(missing)}")
            input("  Press Enter to exit...")
            sys.exit(1)
        print()
try:
    _ensure_deps()
except Exception:
    pass

try:
    from colorama import init as _cinit, Fore, Style
    _cinit(autoreset=True)
except ImportError:
    class _Fake:
        def __getattr__(self, _): return ""
    Fore = Style = _Fake()

import config as cfg_mod
import auth   as auth_mod
import macro  as macro_mod

PRODUCT_ID   = "zenith-single-anchor"
VERSION      = "1.0.0"
BANNER = f"""
{Fore.MAGENTA}╔══════════════════════════════════════════╗
║   Zenith Macros — Single Anchor  v{VERSION}   ║
╚══════════════════════════════════════════╝{Style.RESET_ALL}
"""

# ── helpers ───────────────────────────────────────────────────────────────────

def print_ok(msg: str)   -> None: print(f"  {Fore.GREEN}✓{Style.RESET_ALL} {msg}")
def print_err(msg: str)  -> None: print(f"  {Fore.RED}✗{Style.RESET_ALL} {msg}")
def print_info(msg: str) -> None: print(f"  {Fore.CYAN}→{Style.RESET_ALL} {msg}")

def sep() -> None: print(f"  {Fore.WHITE}{Style.DIM}{'─' * 42}{Style.RESET_ALL}")

def prompt(label: str, default: str = "") -> str:
    hint = f" [{default}]" if default else ""
    val  = input(f"  {label}{hint}: ").strip()
    return val if val else default

def confirm(label: str, default: bool = True) -> bool:
    hint = "Y/n" if default else "y/N"
    val  = input(f"  {label} [{hint}]: ").strip().lower()
    if not val:
        return default
    return val.startswith("y")

# ── auth flow ─────────────────────────────────────────────────────────────────

def do_verify(cfg: dict, force: bool = False) -> dict:
    """Verify license + entitlement. Returns updated cfg or exits."""
    key = cfg.get("license_key", "")
    if not key or force:
        print()
        sep()
        print_info("Enter your Zenith Macros license key (format: XXXX-XXXX-XXXX-XXXX-XXXX)")
        key = prompt("License key")
        if not key:
            print_err("No key entered.")
            return cfg

    print()
    print_info("Verifying license…")
    result = auth_mod.verify_license(key)

    if result["ok"]:
        print_ok(f"License valid  ({result.get('tier', 'unknown')} plan)")
        print_ok(f"Entitlement confirmed — {result.get('product_name', 'Single Anchor')} is yours")
        cfg["license_key"]   = key.strip().replace("-", "").upper()
        cfg["session_token"] = result["session_token"]
        cfg_mod.save(cfg)
    else:
        code = result.get("code", "")
        print_err(result.get("error", "Verification failed"))
        if code == "no_entitlement":
            print_info("Buy Single Anchor at: zenithmacros.store/checkout-standalone?product_id=zenith-single-anchor")
        elif code == "hwid_locked":
            print_info("Your key is locked to another device. Contact support on Discord.")

    return cfg

# ── settings setup ────────────────────────────────────────────────────────────

def setup_keybind(cfg: dict) -> dict:
    print()
    sep()
    print_info("Common keys: F, G, H, V, Mouse4, Mouse5, F5, F6 …")
    kb = prompt("Keybind", cfg.get("keybind") or "F")
    cfg["keybind"] = kb.strip()
    cfg_mod.save(cfg)
    print_ok(f"Keybind set to [{cfg['keybind'].upper()}]")
    return cfg

def setup_settings(cfg: dict) -> dict:
    print()
    sep()
    print_info("Slot keys correspond to your Minecraft hotbar numbers.")
    cfg["anchor_key"]      = prompt("Anchor slot key",         cfg.get("anchor_key",      "4"))
    cfg["glowstone_key"]   = prompt("Glowstone slot key",      cfg.get("glowstone_key",   "5"))
    cfg["totem_key"]       = prompt("Totem (explode) slot key", cfg.get("totem_key",       "9"))
    cfg["right_click_key"] = prompt("Right-click key",         cfg.get("right_click_key", "mouse2"))
    cfg["delay_ms"]        = int(prompt("Delay between steps (ms)", str(cfg.get("delay_ms", 27))) or 27)

    print()
    print_info("Panic key: press once to instantly kill the macro and stop all input.")
    print_info("Leave blank to disable.")
    panic = prompt("Panic key", cfg.get("panic_key", "")).strip()
    cfg["panic_key"] = panic

    print()
    print_info("Actions: which steps fire when you press the keybind.")
    cfg["actions"] = []
    for action in ["place", "charge", "explode"]:
        cur = action in (cfg.get("actions") or ["place", "charge", "explode"])
        if confirm(f"  Enable {action.upper()}?", default=cur):
            cfg["actions"].append(action)
    if not cfg["actions"]:
        cfg["actions"] = ["place", "charge", "explode"]
        print_info("No actions selected — defaulting to all three.")

    cfg_mod.save(cfg)
    print_ok("Settings saved.")
    return cfg

# ── view config ───────────────────────────────────────────────────────────────

def show_config(cfg: dict) -> None:
    print()
    sep()
    key = cfg.get("license_key", "")
    if key and len(key) >= 8:
        masked = key[:4] + "-****-****-****-" + key[-4:]
    else:
        masked = "(not set)"
    panic = cfg.get('panic_key', '') or '(none)'
    print(f"  {'License key':<22} {masked}")
    print(f"  {'Keybind':<22} {cfg.get('keybind', '(not set)').upper()}")
    print(f"  {'Panic key':<22} {panic.upper()}")
    print(f"  {'Anchor key':<22} {cfg.get('anchor_key', '4')}")
    print(f"  {'Glowstone key':<22} {cfg.get('glowstone_key', '5')}")
    print(f"  {'Totem key':<22} {cfg.get('totem_key', '9')}")
    print(f"  {'Right-click key':<22} {cfg.get('right_click_key', 'mouse2')}")
    print(f"  {'Delay (ms)':<22} {cfg.get('delay_ms', 27)}")
    print(f"  {'Actions':<22} {', '.join(cfg.get('actions', [])).upper()}")
    sep()

# ── first launch ──────────────────────────────────────────────────────────────

def first_launch(cfg: dict) -> dict:
    print(BANNER)
    print_info("Welcome! Let's get you set up.")
    cfg = do_verify(cfg)
    if not cfg.get("session_token"):
        return cfg
    cfg = setup_keybind(cfg)
    cfg = setup_settings(cfg)
    print()
    print_ok("All done! Ready to use.")
    return cfg

# ── main menu ─────────────────────────────────────────────────────────────────

def main_menu(cfg: dict) -> None:
    while True:
        print(BANNER)
        kb = cfg.get("keybind") or "(not set)"
        print(f"  Keybind: {Fore.YELLOW}[{kb.upper()}]{Style.RESET_ALL}  |  "
              f"Delay: {cfg.get('delay_ms', 27)}ms  |  "
              f"Actions: {', '.join(cfg.get('actions', [])).upper()}")
        print()
        print(f"  {Fore.WHITE}[1]{Style.RESET_ALL} Start  (press keybind to fire — Ctrl+C to stop)")
        print(f"  {Fore.WHITE}[2]{Style.RESET_ALL} Change keybind")
        print(f"  {Fore.WHITE}[3]{Style.RESET_ALL} Change settings")
        print(f"  {Fore.WHITE}[4]{Style.RESET_ALL} View current config")
        print(f"  {Fore.WHITE}[5]{Style.RESET_ALL} Re-verify license")
        print(f"  {Fore.WHITE}[0]{Style.RESET_ALL} Exit")
        print()

        choice = input("  Choice: ").strip()

        if choice == "1":
            if not cfg.get("keybind"):
                print_err("Set a keybind first (option 2).")
                input("  Press Enter to continue…")
                continue
            print()
            macro_mod.start_listening(cfg)
            print()
            print_info("Stopped.")
            input("  Press Enter to return to menu…")

        elif choice == "2":
            cfg = setup_keybind(cfg)
            input("  Press Enter to continue…")

        elif choice == "3":
            cfg = setup_settings(cfg)
            input("  Press Enter to continue…")

        elif choice == "4":
            show_config(cfg)
            input("  Press Enter to continue…")

        elif choice == "5":
            cfg = do_verify(cfg, force=True)
            input("  Press Enter to continue…")

        elif choice == "0":
            print()
            print_ok("Goodbye!")
            sys.exit(0)

# ── entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    cfg = cfg_mod.load()
    is_first = not cfg.get("license_key") or not cfg.get("session_token")

    if is_first:
        cfg = first_launch(cfg)
        if not cfg.get("session_token"):
            input("  Press Enter to exit…")
            sys.exit(1)
        input("  Press Enter to open the main menu…")

    main_menu(cfg)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        import traceback
        print(f"\n  [FATAL] {exc}")
        traceback.print_exc()
        input("\n  Press Enter to exit…")
