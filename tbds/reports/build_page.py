"""Assemble the self-contained dashboard page: template + app modules + data snapshot -> dashboard/index.html.

The app lives in dashboard/src/NN-name.js. Files are joined in name order inside one function scope, so they share
helpers without globals or a bundler. The page works offline from the embedded snapshot and can switch to live data by
signing in to the API.
"""
from __future__ import annotations

from pathlib import Path

from tbds.config import ROOT

DASH = ROOT / "dashboard"
SRC = DASH / "src"


def _script_safe(text: str) -> str:
    """Keep embedded text from closing the <script> element or breaking older JS parsers."""
    return text.replace("</", "<\\/").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def app_source() -> str:
    parts = sorted(SRC.glob("*.js"))
    if not parts:
        raise FileNotFoundError(f"no dashboard modules in {SRC}")
    body = "\n".join(f"// ===== {p.name}\n{p.read_text(encoding='utf-8')}" for p in parts)
    return "(function () {\n'use strict';\n" + body + "\n})();\n"


def build_page(data_path: Path = DASH / "dashboard_data.json", out: Path = DASH / "index.html") -> Path:
    template = (DASH / "template.html").read_text(encoding="utf-8")
    data = data_path.read_text(encoding="utf-8").strip()
    for marker in ("/*__DATA__*/null", "/*__APP__*/"):
        if marker not in template:
            raise ValueError(f"dashboard template is missing the {marker} placeholder")
    page = template.replace("/*__DATA__*/null", _script_safe(data), 1).replace("/*__APP__*/", _script_safe(app_source()), 1)
    out.write_text(page, encoding="utf-8")
    return out
