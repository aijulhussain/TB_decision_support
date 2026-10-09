"""Browser tests for the dashboard (Playwright). Skipped when Playwright or a browser is not installed.

Install once:  pip install playwright && python -m playwright install chromium
On Windows the installed Edge is used automatically if Playwright's own Chromium is missing.
"""
import socket
import threading
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PAGE = ROOT / "dashboard" / "index.html"
PW = "ChangeMe!2026"

sync_api = pytest.importorskip("playwright.sync_api", reason="playwright not installed")


@pytest.fixture(scope="session")
def browser():
    with sync_api.sync_playwright() as p:
        b = None
        for kw in ({}, {"channel": "msedge"}, {"channel": "chrome"}):
            try:
                b = p.chromium.launch(**kw)
                break
            except Exception:  # noqa: BLE001  (try the next browser)
                continue
        if b is None:
            pytest.skip("no Chromium-based browser available for Playwright")
        yield b
        b.close()


@pytest.fixture()
def page(browser):
    if not PAGE.exists():
        pytest.skip("dashboard not built: run `python -m tbds.cli build-dashboard`")
    ctx = browser.new_context(viewport={"width": 1366, "height": 900})
    pg = ctx.new_page()
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.on("console", lambda m: pg.errors.append(m.text) if m.type == "error" else None)
    yield pg
    ctx.close()


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture(scope="session")
def live_server():
    """Run the API in a background thread on a free port. Skips when the database is not loaded."""
    from sqlalchemy import text

    from tbds.db import schema as S
    try:
        with S.get_engine().connect() as c:
            c.execute(text("select 1 from gap_actions limit 1"))
    except Exception:  # noqa: BLE001
        pytest.skip("live tests need the loaded, migrated database (python -m tbds.cli run-all)")
    import uvicorn
    port = _free_port()
    server = uvicorn.Server(uvicorn.Config("tbds.api.main:app", host="127.0.0.1", port=port, log_level="warning"))
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(0.1)
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    t.join(timeout=5)
