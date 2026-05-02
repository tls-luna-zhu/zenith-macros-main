import json
from pathlib import Path

CONFIG_DIR  = Path.home() / ".zenith"
CONFIG_FILE = CONFIG_DIR / "shield_break.json"

DEFAULTS = {
    "license_key":    "",
    "session_token":  "",
    "keybind":        "",
    "panic_key":      "",
    "axe_key":        "4",
    "sword_key":      "5",
    "double_click_ms": 2,
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
