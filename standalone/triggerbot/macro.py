"""
Zenith Triggerbot — macro engine
Uses mss for fast 3x3 pixel capture at crosshair center.
Requires a crosshair color mod that turns the crosshair blue (R=51 G=51 B=255) over entities.
"""
import ctypes
import os
import sys
import time

try:
    import mss
    import pyautogui
    import keyboard
    import psutil
    from colorama import Fore, Style, init as _cinit
    from pynput.mouse import Button, Controller as MouseController
    _cinit(autoreset=True)
    _HAS_DEPS = True
except ImportError as _ie:
    _HAS_DEPS = False
    _MISSING = str(_ie)

# ── target color (BGRA order from mss) ────────────────────────────────────────
TARGET_R     = 51
TARGET_G     = 51
TARGET_B     = 255
# Euclidean-squared tolerance — only the EXACT center pixel is checked.
# sqrt(600) ≈ 24.5 units of color distance allowed.
TOLERANCE_SQ = 600

COOLDOWN     = 0.60   # seconds between clicks
CLICK_HOLD   = 0.012  # base click hold

SUPPORTED_WINDOWS = ["Minecraft", "Badlion", "Lunar", "Feather", "PvPLounge", "Forge", "Fabric"]
BLOCKED_PROCESSES = ["taskmgr", "anydesk", "processhacker", "fiddler",
                     "ida", "ollydbg", "x64dbg", "cheatengine", "wireshark"]


class ZenithTriggerbot:
    def __init__(self, cfg: dict):
        self.trigger_key = (cfg.get("keybind") or "q").lower()
        self.exit_key    = (cfg.get("panic_key") or "f7").lower()

        self.sct         = mss.mss()
        self.mouse       = MouseController()
        screen_w, screen_h = pyautogui.size()
        self.monitor     = {
            "top":    (screen_h // 2) - 1,
            "left":   (screen_w // 2) - 1,
            "width":  3,
            "height": 3,
        }

        self.running         = False
        self.window_detected = False
        self._exit           = False

    # ── safety ────────────────────────────────────────────────────────────────

    def check_process_safety(self) -> bool:
        for proc in psutil.process_iter(['name']):
            try:
                if any(kw in proc.info['name'].lower() for kw in BLOCKED_PROCESSES):
                    return False
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        return True

    def get_window_title(self) -> str:
        try:
            hwnd   = ctypes.windll.user32.GetForegroundWindow()
            length = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
            buf    = ctypes.create_unicode_buffer(length + 1)
            ctypes.windll.user32.GetWindowTextW(hwnd, buf, length + 1)
            return buf.value
        except Exception:
            return ""

    def check_window(self) -> bool:
        title = self.get_window_title().lower()
        self.window_detected = any(w.lower() in title for w in SUPPORTED_WINDOWS)
        return self.window_detected

    # ── pixel (center-only, Euclidean distance) ───────────────────────────────

    def pixel_matches(self, pixel) -> bool:
        # mss on Windows returns BGRA: pixel[0]=B, pixel[1]=G, pixel[2]=R
        b, g, r = pixel[0], pixel[1], pixel[2]
        dr = r - TARGET_R
        dg = g - TARGET_G
        db = b - TARGET_B
        return (dr * dr + dg * dg + db * db) < TOLERANCE_SQ

    # ── click (pynput — hardware-level SendInput) ─────────────────────────────

    def click(self):
        self.mouse.press(Button.left)
        time.sleep(CLICK_HOLD + (time.time() % 0.01))
        self.mouse.release(Button.left)
        time.sleep(COOLDOWN)

    # ── display ───────────────────────────────────────────────────────────────

    def print_dashboard(self, first_run: bool = False, pixel=None, clicking: bool = False):
        s_col  = Fore.GREEN if self.running         else Fore.RED
        s_text = "ON"       if self.running         else "OFF"
        w_col  = Fore.GREEN if self.window_detected else Fore.RED
        w_text = "Detected" if self.window_detected else "Not Detected"

        px_str = ""
        if pixel is not None:
            b, g, r = pixel[0], pixel[1], pixel[2]
            px_str = f"pixel R={r} G={g} B={b}"

        click_str = f"{Fore.GREEN}>>> CLICKING <<<{Style.RESET_ALL}" if clicking else ""

        if not first_run:
            sys.stdout.write("\033[5A")

        print(f"  {Fore.YELLOW}→{Style.RESET_ALL} toggle:  [{self.trigger_key.upper()}]  status: [{s_col}{s_text}{Style.RESET_ALL}]            ")
        print(f"  {Fore.YELLOW}→{Style.RESET_ALL} exit:    [{self.exit_key.upper()}]                                     ")
        print(f"  {Fore.YELLOW}→{Style.RESET_ALL} window:  [{w_col}{w_text}{Style.RESET_ALL}]                            ")
        print(f"  {Fore.YELLOW}→{Style.RESET_ALL} {px_str:<40}                  ")
        print(f"  {click_str:<50}                  ")

    # ── main loop ─────────────────────────────────────────────────────────────

    def run(self):
        if not self.check_process_safety():
            print(f"  {Fore.RED}✗{Style.RESET_ALL} Unsafe environment detected. Exiting.")
            time.sleep(2)
            return

        os.system('cls')
        print(f"\n{Fore.MAGENTA}  Zenith Macros — Triggerbot{Style.RESET_ALL}")
        print(f"  {'─'*42}")
        print(f"  {Fore.CYAN}→{Style.RESET_ALL} Requires a crosshair color mod.")
        print(f"  {Fore.CYAN}→{Style.RESET_ALL} Crosshair must turn blue over enemies.\n")

        self.print_dashboard(first_run=True)

        prev_window = self.window_detected

        while not self._exit:
            if keyboard.is_pressed(self.exit_key):
                print(f"\n  {Fore.RED}Exiting…{Style.RESET_ALL}")
                break

            if keyboard.is_pressed(self.trigger_key):
                self.running = not self.running
                self.print_dashboard()
                time.sleep(0.3)

            prev_window = self.window_detected
            self.check_window()
            if prev_window != self.window_detected:
                self.print_dashboard()

            if self.running and self.window_detected:
                img    = self.sct.grab(self.monitor)
                center = img.pixel(1, 1)          # center pixel ONLY — avoids env false positives
                hit    = self.pixel_matches(center)
                self.print_dashboard(pixel=center, clicking=hit)
                if hit:
                    self.click()
                else:
                    time.sleep(0.001)
            else:
                time.sleep(0.05)


# ── public API ────────────────────────────────────────────────────────────────

def start_listening(cfg: dict):
    if not _HAS_DEPS:
        print(f"  [!] Missing packages: {_MISSING}")
        return
    bot = ZenithTriggerbot(cfg)
    try:
        bot.run()
    except KeyboardInterrupt:
        bot._exit = True
        print(f"\n  Stopped.")
    finally:
        bot._exit = True
