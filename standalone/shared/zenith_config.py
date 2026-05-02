"""
Shared config load/save — reused by all standalone CLI apps.
Each CLI passes its own filename and defaults dict.
"""
import json
from pathlib import Path

CONFIG_DIR = Path.home() / ".zenith"


def load(filename: str, defaults: dict) -> dict:
    path = CONFIG_DIR / filename
    try:
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            return {**defaults, **data}
    except Exception:
        pass
    return dict(defaults)


def save(filename: str, cfg: dict) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    path = CONFIG_DIR / filename
    path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
