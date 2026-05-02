"""Zenith Macros — Triggerbot (standalone CLI)"""
import sys, os

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    os.system("")
    import ctypes
    if not ctypes.windll.shell32.IsUserAnAdmin():
        script = os.path.abspath(sys.argv[0])
        extra  = " ".join(f'"{a}"' for a in sys.argv[1:])
        if getattr(sys, "frozen", False):
            ctypes.windll.shell32.ShellExecuteW(None, "runas", script, extra or None, None, 1)
        else:
            args = f'"{script}"'
            if extra: args += f" {extra}"
            ctypes.windll.shell32.ShellExecuteW(None, "runas", sys.executable, args, None, 1)
        sys.exit(0)

def _ensure_deps():
    import importlib, subprocess
    required = {
        "mss": "mss", "pyautogui": "pyautogui", "keyboard": "keyboard",
        "psutil": "psutil", "pynput": "pynput", "colorama": "colorama",
    }
    missing = [pkg for mod, pkg in required.items() if importlib.util.find_spec(mod) is None]
    if missing:
        print(f"  Installing: {', '.join(missing)} ...")
        try: subprocess.check_call([sys.executable, "-m", "pip", "install"] + missing,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception as e: print(f"  [!] Auto-install failed: {e}"); input("  Press Enter to exit..."); sys.exit(1)
try: _ensure_deps()
except Exception: pass

try:
    from colorama import init as _cinit, Fore, Style; _cinit(autoreset=True)
except ImportError:
    class _Fake:
        def __getattr__(self, _): return ""
    Fore = Style = _Fake()

import config as cfg_mod, auth as auth_mod, macro as macro_mod

VERSION = "1.0.0"
BANNER  = f"""
{Fore.MAGENTA}╔══════════════════════════════════════════╗
║   Zenith Macros — Triggerbot     v{VERSION}   ║
╚══════════════════════════════════════════╝{Style.RESET_ALL}"""

def print_ok(m):   print(f"  {Fore.GREEN}✓{Style.RESET_ALL} {m}")
def print_err(m):  print(f"  {Fore.RED}✗{Style.RESET_ALL} {m}")
def print_info(m): print(f"  {Fore.CYAN}→{Style.RESET_ALL} {m}")
def sep():         print(f"  {Fore.WHITE}{Style.DIM}{'─'*42}{Style.RESET_ALL}")
def prompt(label, default=""):
    val = input(f"  {label}{f' [{default}]' if default else ''}: ").strip()
    return val if val else default

def do_verify(cfg, force=False):
    key = cfg.get("license_key", "")
    if not key or force:
        print(); sep(); print_info("Enter your Zenith Macros license key (XXXX-XXXX-XXXX-XXXX-XXXX)")
        key = prompt("License key")
        if not key: print_err("No key entered."); return cfg
    print(); print_info("Verifying license…")
    result = auth_mod.verify_license(key)
    if result["ok"]:
        print_ok(f"License valid  ({result.get('tier','unknown')} plan)")
        print_ok(f"Entitlement confirmed — {result.get('product_name','Triggerbot')} is yours")
        cfg["license_key"]   = key.strip().replace("-","").upper()
        cfg["session_token"] = result["session_token"]
        cfg_mod.save(cfg)
    else:
        print_err(result.get("error", "Verification failed"))
        code = result.get("code","")
        if code == "no_entitlement": print_info("Buy Triggerbot at: zenithmacros.store")
        elif code == "hwid_locked":  print_info("Key locked to another device. Contact support on Discord.")
    return cfg

def setup_keybind(cfg):
    print(); sep()
    print_info("Toggle key turns the triggerbot ON/OFF while in-game.")
    cfg["keybind"] = prompt("Toggle key", cfg.get("keybind") or "q").strip()
    cfg_mod.save(cfg); print_ok(f"Toggle key set to [{cfg['keybind'].upper()}]"); return cfg

def setup_settings(cfg):
    print(); sep()
    print_info("Exit / panic key: instantly stops the triggerbot.")
    cfg["panic_key"] = prompt("Exit / panic key", cfg.get("panic_key", "f7") or "f7").strip()
    cfg_mod.save(cfg); print_ok("Settings saved."); return cfg

def show_config(cfg):
    print(); sep()
    key = cfg.get("license_key","")
    masked = (key[:4]+"-****-****-****-"+key[-4:]) if len(key)>=8 else "(not set)"
    print(f"  {'License key':<22} {masked}")
    print(f"  {'Toggle key':<22} {(cfg.get('keybind') or 'q').upper()}")
    print(f"  {'Exit / panic key':<22} {(cfg.get('panic_key') or 'f7').upper()}")
    sep()

def main_menu(cfg):
    while True:
        print(BANNER)
        kb = cfg.get("keybind") or "q"
        panic = cfg.get("panic_key") or "f7"
        print(f"  Toggle: {Fore.YELLOW}[{kb.upper()}]{Style.RESET_ALL}  |  Exit: [{panic.upper()}]")
        print(f"  {Fore.CYAN}→{Style.RESET_ALL} Requires crosshair color mod (mod changes color over enemies)")
        print(f"\n  {Fore.WHITE}[1]{Style.RESET_ALL} Start  (toggle ON/OFF with keybind in-game)")
        print(f"  {Fore.WHITE}[2]{Style.RESET_ALL} Change toggle key")
        print(f"  {Fore.WHITE}[3]{Style.RESET_ALL} Change settings")
        print(f"  {Fore.WHITE}[4]{Style.RESET_ALL} View current config")
        print(f"  {Fore.WHITE}[5]{Style.RESET_ALL} Re-verify license")
        print(f"  {Fore.WHITE}[0]{Style.RESET_ALL} Exit\n")
        choice = input("  Choice: ").strip()
        if choice == "1":
            if not cfg.get("keybind"): print_err("Set a toggle key first (option 2)."); input("  Press Enter…"); continue
            print(); macro_mod.start_listening(cfg); print(); print_info("Stopped."); input("  Press Enter to return to menu…")
        elif choice == "2": cfg = setup_keybind(cfg); input("  Press Enter…")
        elif choice == "3": cfg = setup_settings(cfg); input("  Press Enter…")
        elif choice == "4": show_config(cfg); input("  Press Enter…")
        elif choice == "5": cfg = do_verify(cfg, force=True); input("  Press Enter…")
        elif choice == "0": print(); print_ok("Goodbye!"); sys.exit(0)

def main():
    cfg = cfg_mod.load()
    if not cfg.get("license_key") or not cfg.get("session_token"):
        print(BANNER); print_info("Welcome! Let's get you set up.")
        cfg = do_verify(cfg)
        if not cfg.get("session_token"): input("  Press Enter to exit…"); sys.exit(1)
        cfg = setup_keybind(cfg); cfg = setup_settings(cfg)
        print(); print_ok("All done! Ready to use.")
        input("  Press Enter to open the main menu…")
    main_menu(cfg)

if __name__ == "__main__":
    try: main()
    except Exception as exc:
        import traceback; print(f"\n  [FATAL] {exc}"); traceback.print_exc(); input("\n  Press Enter to exit…")
