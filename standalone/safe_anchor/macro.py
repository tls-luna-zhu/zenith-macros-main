"""Safe Anchor macro — port of runSA from the app."""
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

ACTION_ORDER = ["place", "charge", "explode"]


def _ms(ms): return ms / 1000.0

def _press(key):
    k = key.lower()
    if k in ("mouse1", "left"):   mouse.press(button="left")
    elif k in ("mouse2", "right"): mouse.press(button="right")
    elif k in ("mouse3", "middle"): mouse.press(button="middle")
    else: keyboard.press(key)

def _release(key):
    k = key.lower()
    if k in ("mouse1", "left"):   mouse.release(button="left")
    elif k in ("mouse2", "right"): mouse.release(button="right")
    elif k in ("mouse3", "middle"): mouse.release(button="middle")
    else: keyboard.release(key)

def _tap(key, hold_ms):
    _press(key); time.sleep(_ms(hold_ms)); _release(key)

def _slot_click(slot_key, right_click_key="mouse2"):
    _press(slot_key)
    time.sleep(_ms(4))
    _press(right_click_key)
    time.sleep(_ms(CLICK_HOLD_MS))
    _release(right_click_key)
    remaining = SLOT_HOLD_MS - CLICK_HOLD_MS - 4
    if remaining > 0: time.sleep(_ms(remaining))
    _release(slot_key)

def _run_once(cfg):
    delay_ms  = max(0, int(cfg.get("delay_ms", 27)))
    anchor    = cfg.get("anchor_key",    "4")
    glowstone = cfg.get("glowstone_key", "5")
    detonate  = cfg.get("totem_key",     "9")
    right_key = cfg.get("right_click_key", "mouse2")

    enabled = cfg.get("actions") or list(ACTION_ORDER)
    actions = [a for a in ACTION_ORDER if a in enabled]
    if not actions: actions = list(ACTION_ORDER)

    mapping = {"place": anchor, "charge": glowstone, "explode": detonate}

    for i, action in enumerate(actions):
        if _stop.is_set(): return
        _slot_click(mapping[action], right_key)
        if i < len(actions) - 1:
            time.sleep(_ms(delay_ms))

    if actions and not _stop.is_set():
        last = actions[-1]
        if last == "place":
            time.sleep(_ms(delay_ms)); _tap(glowstone, SLOT_HOLD_MS)
        elif last == "charge":
            time.sleep(_ms(delay_ms)); _tap(detonate, SLOT_HOLD_MS)


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
