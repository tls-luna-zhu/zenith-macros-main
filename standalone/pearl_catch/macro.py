"""Pearl Catch macro — port of runPC from the app."""
import random
import time
import threading

try:
    import keyboard
    import mouse
    _HAS_KEYBOARD = True
except ImportError:
    _HAS_KEYBOARD = False

KEY_HOLD_MS   = 20
CLICK_HOLD_MS = 10

_running = threading.Event()
_queue   = threading.Semaphore(0)
_stop    = threading.Event()
_lock    = threading.Lock()
_cfg_ref = {}


def _ms(ms): return ms / 1000.0

def _vary(ms):
    return max(0, ms + random.randint(-3, 3))

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

def _rclick_vary():
    _tap("right", _vary(CLICK_HOLD_MS))


def _run_once(cfg):
    pearl_key       = cfg.get("pearl_key",       "4")
    wind_charge_key = cfg.get("wind_charge_key", "5")
    delay_ms        = max(0, int(cfg.get("delay_ms", 27)))

    if _stop.is_set(): return
    time.sleep(_ms(30))
    if _stop.is_set(): return

    # Swap to pearl
    _tap(pearl_key, KEY_HOLD_MS)
    if _stop.is_set(): return

    # Right-click (throw pearl)
    _rclick_vary()
    if _stop.is_set(): return

    # Gap
    time.sleep(_ms(_vary(delay_ms)))
    if _stop.is_set(): return

    # Swap to wind charge
    _tap(wind_charge_key, KEY_HOLD_MS)
    if _stop.is_set(): return

    # Right-click (throw wind charge)
    _rclick_vary()


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
