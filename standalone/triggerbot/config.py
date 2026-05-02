import json
from pathlib import Path

CONFIG_DIR  = Path.home() / ".zenith"
CONFIG_FILE = CONFIG_DIR / "triggerbot.json"

DEFAULTS = {
    "license_key":      "",
    "session_token":    "",
    "keybind":          "q",
    "panic_key":        "f7",
    "attack_cooldown":  0.60,   # seconds between clicks
    "tolerance":        30,     # color match tolerance (0-100)
    "target_r":         255,    # target crosshair color (red = entity detected)
    "target_g":         0,
    "target_b":         0,
}

def load():
    try:
        if CONFIG_FILE.exists():
            return {**DEFAULTS, **json.loads(CONFIG_FILE.read_text(encoding="utf-8"))}
    except Exception: pass
    return dict(DEFAULTS)

def save(cfg):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
