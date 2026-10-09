"""Assemble the self-contained dashboard page: template + app code + data snapshot -> dashboard/index.html.

The page works offline from the embedded snapshot, and can switch to live data by signing in to the API.
"""
from __future__ import annotations

from pathlib import Path

from tbds.config import ROOT

DASH = ROOT / "dashboard"


def _script_safe(text: str) -> str:
    """Keep embedded text from closing the <script> element or breaking older JS parsers."""
    return text.replace("</", "<\\/").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def build_page(data_path: Path = DASH / "dashboard_data.json", out: Path = DASH / "index.html") -> Path:
    template = (DASH / "template.html").read_text(encoding="utf-8")
    app = (DASH / "app.js").read_text(encoding="utf-8")
    data = data_path.read_text(encoding="utf-8").strip()
    for marker in ("/*__DATA__*/null", "/*__APP__*/"):
        if marker not in template:
            raise ValueError(f"dashboard template is missing the {marker} placeholder")
    page = template.replace("/*__DATA__*/null", _script_safe(data), 1).replace("/*__APP__*/", _script_safe(app), 1)
    out.write_text(page, encoding="utf-8")
    return out
