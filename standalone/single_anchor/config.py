"""Config load/save for Single Anchor CLI."""
import json
import os
from pathlib import Path

CONFIG_DIR  = Path.home() / ".zenith"
CONFIG_FILE = CONFIG_DIR / "single_anchor.json"

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


def load() -> dict:
    try:
        if CONFIG_FILE.exists():
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            return {**DEFAULTS, **data}
    except Exception:
        pass
    return dict(DEFAULTS)


def save(cfg: dict) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
