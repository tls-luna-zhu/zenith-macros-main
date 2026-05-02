"""Shield Break macro — concurrent slot+click for reliable stun registration."""
import ctypes
import time
import threading

try:
    import keyboard
    import mouse
    _HAS_KEYBOARD = True
except ImportError:
    _HAS_KEYBOARD = False

SLOT_HOLD_MS  = 17
CLICK_HOLD_MS = 10

_running = threading.Event()
_queue   = threading.Semaphore(0)
_stop    = threading.Event()
_lock    = threading.Lock()
_cfg_ref = {}


def _ms(ms): return ms / 1000.0

def _focus_mc():
    """Bring the Minecraft window to foreground so SendInput keyboard goes there."""
    try:
        user32 = ctypes.windll.user32
        hwnd = user32.GetForegroundWindow()
        import ctypes.wintypes
        SUPPORTED = ["minecraft", "badlion", "lunar", "feather", "pvplounge", "forge", "fabric"]
        buf = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(hwnd, buf, 256)
        title = buf.value.lower()
        if any(w in title for w in SUPPORTED):
            return
        def _enum_cb(h, _):
            user32.GetWindowTextW(h, buf, 256)
            t = buf.value.lower()
            if any(w in t for w in SUPPORTED):
                user32.SetForegroundWindow(h)
                return False
            return True
        _EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)
        user32.EnumWindows(_EnumWindowsProc(_enum_cb), 0)
    except Exception:
        pass

def _press(key):
    k = key.lower()
    if k in ("mouse1", "left"):    mouse.press(button="left")
    elif k in ("mouse2", "right"): mouse.press(button="right")
    else: keyboard.press(key)

def _release(key):
    k = key.lower()
    if k in ("mouse1", "left"):    mouse.release(button="left")
    elif k in ("mouse2", "right"): mouse.release(button="right")
    else: keyboard.release(key)

def _tap(key, hold_ms):
    _press(key); time.sleep(_ms(hold_ms)); _release(key)

def _slot_lclick(slot_key):
    """Concurrent slot switch + left click."""
    _press(slot_key)
    _press("left")
    time.sleep(_ms(CLICK_HOLD_MS))
    _release("left")
    remaining = SLOT_HOLD_MS - CLICK_HOLD_MS
    if remaining > 0: time.sleep(_ms(remaining))
    _release(slot_key)


def _run_once(cfg):
    axe_key        = cfg.get("axe_key",        "4")
    sword_key      = cfg.get("sword_key",       "5")
    double_click_ms = max(1, int(cfg.get("double_click_ms", 3)))

    if _stop.is_set(): return

    _focus_mc()
    time.sleep(_ms(5))
    if _stop.is_set(): return

    # Concurrent slot switch to axe + first left-click (stun hit 1)
    _slot_lclick(axe_key)
    if _stop.is_set(): return

    # Tight second click to break shield
    time.sleep(_ms(double_click_ms))
    if _stop.is_set(): return
    _tap("left", 6)
    if _stop.is_set(): return

    # Swap back to sword
    time.sleep(_ms(8))
    if _stop.is_set(): return
    _tap(sword_key, SLOT_HOLD_MS)


def _trigger_cb():
    if _stop.is_set(): return
    _queue.release()
    if not _running.is_set():
        _running.set()
        threading.Thread(target=_execute_loop, daemon=True).start()

def _execute_loop():
    while _queue.acquire(timeout=0.1):
        if _stop.is_set(): break
        with _lock: cfg = dict(_cfg_ref)
        _run_once(cfg)
    _running.clear()


def start_listening(cfg):
    if not _HAS_KEYBOARD:
        print("  [!] keyboard or mouse package missing.")
        return
    keybind   = cfg.get("keybind", "")
    panic_key = cfg.get("panic_key", "")
    if not keybind: print("  [!] No keybind set."); return

    _stop.clear()
    while _queue.acquire(blocking=False): pass
    with _lock: _cfg_ref.clear(); _cfg_ref.update(cfg)

    kb_lower    = keybind.lower()
    panic_lower = panic_key.lower() if panic_key else ""

    def _on_press(event):
        name = (event.name or "").lower()
        if name == kb_lower: _trigger_cb()
        elif panic_lower and name == panic_lower:
            _stop.set()
            while _queue.acquire(blocking=False): pass

    hook = keyboard.on_press(_on_press, suppress=False)
    if panic_key:
        print(f"  Listening — [{keybind.upper()}] to fire | [{panic_key.upper()}] panic | Ctrl+C to stop.")
    else:
        print(f"  Listening — [{keybind.upper()}] to fire | Ctrl+C to stop.")

    try:
        while not _stop.is_set(): time.sleep(0.05)
    except KeyboardInterrupt:
        pass
    finally:
        try: keyboard.unhook(hook)
        except Exception: pass
        _stop.clear()
