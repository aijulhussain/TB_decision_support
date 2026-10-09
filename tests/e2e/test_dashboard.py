"""End-to-end checks of the dashboard in a real browser: every role and section renders, the main workflows work in
snapshot mode, the layout holds on a phone, and live mode signs in, scopes data and records work."""
import pytest
from sqlalchemy import text

from tests.e2e.conftest import PAGE, PW

ROLES = ["State TB Cell", "District officer", "Facility team", "Data manager"]


def _open(page, hash_=""):
    page.goto(PAGE.as_uri() + hash_)
    page.evaluate("localStorage.clear(); sessionStorage.clear()")
    page.goto(PAGE.as_uri() + hash_)


def _as_role(page, role):
    page.locator(".user-chip").click()
    page.locator("#umenu .um-roles button", has_text=role).click()
    page.keyboard.press("Escape")


def _tabs(page):
    return [b.get_attribute("data-tab") for b in page.locator("#nav .nav-item").all()]


def test_every_role_and_section_renders(page):
    _open(page)
    for role in ROLES:
        _as_role(page, role)
        tabs = _tabs(page)
        assert "overview" in tabs
        for t in tabs:
            page.locator(f'#nav [data-tab="{t}"]').click()
            assert "could not be drawn" not in page.locator("#view").inner_text(), f"{role}/{t}"
    assert not page.errors, page.errors


def test_gap_assign_resolve_and_undo_in_snapshot(page):
    _open(page, "#gaps")
    _as_role(page, "District officer")             # Dibrugarh: a pilot district with listed gaps
    page.locator('#nav [data-tab="gaps"]').click()
    page.locator("#view tbody tr.click").first.click()
    drawer = page.locator("#drawer")
    drawer.locator("select").select_option(index=1)
    drawer.get_by_role("button", name="Assign", exact=True).click()
    assert "Assigned to" in drawer.inner_text()
    drawer.get_by_role("button", name="✓ Mark resolved").click()
    assert "Resolved" in drawer.inner_text()
    page.locator("#toast").get_by_role("button", name="Undo").click()
    page.wait_for_timeout(200)
    assert "Mark resolved" in page.locator("#drawer").inner_text()
    assert not page.errors, page.errors


def test_tasks_page_shows_assigned_gap(page):
    _open(page)
    _as_role(page, "District officer")
    page.locator('#nav [data-tab="gaps"]').click()
    page.locator("#view tbody tr.click").first.click()
    drawer = page.locator("#drawer")
    me = drawer.locator("select option", has_text="Me ·").first.get_attribute("value")
    drawer.locator("select").select_option(me)
    drawer.get_by_role("button", name="Assign", exact=True).click()
    page.keyboard.press("Escape")
    page.locator('#nav [data-tab="tasks"]').click()
    assert page.locator(".task").count() >= 1
    assert "Gaps assigned to me" in page.locator("#view").inner_text()


def test_death_audit_needs_avoidable_before_completing(page):
    _open(page)
    _as_role(page, "District officer")
    page.locator('#nav [data-tab="deaths"]').click()
    page.locator("#view section", has_text="Deaths to audit").locator("tbody tr.click").first.click()
    drawer = page.locator("#drawer")
    drawer.get_by_role("button", name="Completed").click()
    drawer.get_by_role("button", name="Save audit").click()
    assert "avoidable" in page.locator("#toast").inner_text().lower()
    drawer.get_by_role("button", name="Unclear").click()
    drawer.locator(".check input").first.check()
    drawer.get_by_role("button", name="Save audit").click()
    assert "Audit completed" in page.locator("#toast").inner_text()
    assert "Audited" in page.locator("#view").inner_text()


def test_keyboard_moves_through_patients(page):
    _open(page, "#review")
    first = page.locator(".pitem[aria-current='true']").get_attribute("data-key")
    page.keyboard.press("j")
    second = page.locator(".pitem[aria-current='true']").get_attribute("data-key")
    assert first != second
    page.keyboard.press("k")
    assert page.locator(".pitem[aria-current='true']").get_attribute("data-key") == first
    page.keyboard.press("/")
    assert page.evaluate("document.activeElement.type") == "search"


def test_demo_guide_can_be_dismissed(page):
    _open(page)
    assert page.locator(".guide").count() == 1
    page.get_by_role("button", name="Dismiss the demo guide").click()
    assert page.locator(".guide").count() == 0
    page.reload()
    assert page.locator(".guide").count() == 0


def test_phone_layout_has_no_sideways_scroll(browser):
    ctx = browser.new_context(viewport={"width": 390, "height": 844})
    pg = ctx.new_page()
    pg.goto(PAGE.as_uri())
    for t in ["overview", "review", "gaps", "facilities", "evidence"]:
        pg.locator("#menu-btn").click()
        pg.locator(f'#nav [data-tab="{t}"]').click()
        pg.wait_for_timeout(150)
        assert pg.evaluate("document.documentElement.scrollWidth") <= 391, t
    ctx.close()


@pytest.mark.parametrize("user,expect_tabs", [
    ("dto_dibrugarh", {"overview", "tasks", "review", "gaps", "deaths"}),
    ("tu_as-dib-tu01", {"overview", "tasks", "review", "gaps"}),
])
def test_live_sign_in_and_work(page, live_server, user, expect_tabs):
    page.goto(live_server + "/app/")
    page.locator(".user-chip").click()
    page.locator("#umenu").get_by_role("button", name="Sign in for live data").click()
    page.fill("input[name=username]", user)
    page.fill("input[name=password]", PW)
    page.locator("dialog form button[type=submit]").click()
    page.wait_for_selector(".pill.live", timeout=15000)
    assert expect_tabs <= set(_tabs(page))
    # record a note on a gap, then remove it again so the demo database is unchanged
    page.locator('#nav [data-tab="gaps"]').click()
    page.locator("#view tbody tr.click").first.click()
    page.locator("#drawer textarea").fill("e2e-test note")
    page.locator("#drawer").get_by_role("button", name="Add note").click()
    page.wait_for_selector("#drawer .tl-note", timeout=8000)
    assert "e2e-test note" in page.locator("#drawer").inner_text()
    from tbds.db import schema as S
    with S.get_engine().begin() as c:
        c.execute(text("DELETE FROM gap_actions WHERE note = 'e2e-test note'"))
    assert not [e for e in page.errors if "favicon" not in e], page.errors
