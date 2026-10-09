"""Configuration loader: YAML defaults, overridden by environment variables TBDS__SECTION__KEY."""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = Path(os.environ.get("TBDS_CONFIG", ROOT / "config" / "default.yaml"))
PUBLIC_DATA = ROOT / "data" / "public"


class Settings(dict):
    """Dict with attribute access for nested sections."""

    def __getattr__(self, item: str) -> Any:
        try:
            value = self[item]
        except KeyError as exc:  # pragma: no cover
            raise AttributeError(item) from exc
        return Settings(value) if isinstance(value, dict) else value


def _coerce(raw: str) -> Any:
    return yaml.safe_load(raw)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    with open(CONFIG_PATH, encoding="utf-8") as fh:
        cfg = yaml.safe_load(fh)
    for key, raw in os.environ.items():
        if not key.startswith("TBDS__"):
            continue
        parts = [p.lower() for p in key.split("__")[1:]]
        node = cfg
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        node[parts[-1]] = _coerce(raw)
    return Settings(cfg)
