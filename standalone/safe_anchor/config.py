import json, os
from pathlib import Path

CONFIG_DIR  = Path.home() / ".zenith"
CONFIG_FILE = CONFIG_DIR / "safe_anchor.json"

DEFAULTS = {
    "license_key":     "",
    "session_token":   "",
    "keybind":         "",
    "panic_key":       "",
    "anchor_key":      "4",
    "glowstone_key":   "5",
    "totem_key":       "9",
    "right_click_key": "mouse2",
    "delay_ms":        27,
    "actions":         ["place", "charge", "explode"],
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
