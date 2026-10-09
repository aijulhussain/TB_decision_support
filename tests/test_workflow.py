"""Workflow and security endpoints: gap actions, death-audit reviews, work lists, feedback, sign-out, lockout, prod guard."""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from tbds.db import schema as S

try:
    with S.get_engine().connect() as c:
        have = bool(c.execute(text("select count(*) from users")).scalar()) and \
            bool(c.execute(text("select count(*) from information_schema.tables where table_name='gap_actions'")).scalar())
except Exception:  # pragma: no cover
    have = False

pytestmark = pytest.mark.skipif(not have, reason="needs the loaded, migrated PostgreSQL database (run `python -m tbds.cli run-all`)")

PW = "ChangeMe!2026"
MARK = "pytest-workflow"


@pytest.fixture(scope="module")
def client():
    from tbds.api.main import app
    yield TestClient(app)
    with S.get_engine().begin() as c:          # leave the demo database as we found it
        c.execute(text("DELETE FROM gap_actions WHERE note LIKE :m"), {"m": MARK + "%"})
        c.execute(text("DELETE FROM death_reviews WHERE summary LIKE :m"), {"m": MARK + "%"})


def _h(client, user):
    r = client.post("/auth/token", data={"username": user, "password": PW})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _open_gap(client, h):
    items = client.get("/referral-gaps?status=open&limit=50", headers=h).json()["items"]
    assert items, "no open gaps in scope"
    return items[0]


def test_gap_assign_appears_in_tasks_then_resolve(client):
    dto = _h(client, "dto_dibrugarh")
    g = _open_gap(client, dto)
    assert g["status"] == "open"
    people = client.get(f"/users/assignable?facility_id={g['facility_id']}", headers=dto).json()["items"]
    tu = next(u["username"] for u in people if u["role"] == "facility_user")
    url = f"/referral-gaps/{g['gap_type']}/{g['record_id']}/actions"
    assert client.post(url, json={"action": "assigned", "assignee": tu, "note": MARK}, headers=dto).status_code == 200

    row = next(x for x in client.get(f"/referral-gaps?facility_id={g['facility_id']}&limit=1000", headers=dto).json()["items"]
               if x["record_id"] == g["record_id"] and x["gap_type"] == g["gap_type"])
    assert row["status"] == "assigned" and row["assignee"] == tu

    mine = client.get("/tasks", headers=_h(client, tu)).json()
    assert any(x["record_id"] == g["record_id"] for x in mine["gaps_assigned"])

    assert client.post(url, json={"action": "resolved", "note": MARK + " closed"}, headers=dto).status_code == 200
    hist = client.get(f"/referral-gaps/{g['gap_type']}/{g['record_id']}/history", headers=dto).json()["items"]
    assert [h["action"] for h in hist][:2] == ["resolved", "assigned"]
    resolved = client.get("/referral-gaps?status=resolved&limit=1000", headers=dto).json()["items"]
    assert any(x["record_id"] == g["record_id"] for x in resolved)


def test_gap_actions_are_scoped(client):
    g = _open_gap(client, _h(client, "dto_dibrugarh"))
    url = f"/referral-gaps/{g['gap_type']}/{g['record_id']}/actions"
    assert client.post(url, json={"action": "note", "note": MARK}, headers=_h(client, "dto_cachar")).status_code == 404
    assert client.post(url, json={"action": "note", "note": MARK}, headers=_h(client, "state_admin")).status_code == 403
    # cannot assign to someone outside the facility
    other = "tu_as-kmm-tu01"
    r = client.post(url, json={"action": "assigned", "assignee": other, "note": MARK}, headers=_h(client, "dto_dibrugarh"))
    assert r.status_code == 422


def test_death_review_rules(client):
    dto = _h(client, "dto_dibrugarh")
    q = client.get("/death-audit/queue?limit=20", headers=dto).json()
    assert q["factors"] and q["items"]
    k = q["items"][0]["patient_key"]
    url = f"/death-audit/{k}/review"
    assert client.post(url, json={"status": "completed", "summary": MARK}, headers=dto).status_code == 422          # avoidable required
    assert client.post(url, json={"status": "in_progress", "contributing": ["nope"], "summary": MARK}, headers=dto).status_code == 422
    r = client.post(url, json={"status": "completed", "avoidable": "unclear", "contributing": ["delay_in_treatment_start"], "summary": MARK}, headers=dto)
    assert r.status_code == 200
    item = next(x for x in client.get("/death-audit/queue?limit=20", headers=dto).json()["items"] if x["patient_key"] == k)
    assert item["review"]["status"] == "completed" and item["review"]["avoidable"] == "unclear"
    assert client.post(url, json={"status": "in_progress", "summary": MARK}, headers=_h(client, "dto_cachar")).status_code == 404


def test_review_list_carries_saved_status_and_paging(client):
    h = _h(client, "dto_dibrugarh")
    a = client.get("/patients/review-list?limit=5", headers=h).json()["items"]
    b = client.get("/patients/review-list?limit=5&offset=5", headers=h).json()["items"]
    assert a and b and not {x["patient_key"] for x in a} & {x["patient_key"] for x in b}
    assert "last_action" in a[0]


def test_feedback_summary_roles(client):
    assert client.get("/feedback/summary", headers=_h(client, "state_admin")).status_code == 200
    assert client.get("/feedback/summary", headers=_h(client, "tu_as-dib-tu01")).status_code == 403


def test_logout_revokes_token(client):
    h = _h(client, "data_manager")
    assert client.get("/me", headers=h).status_code == 200
    assert client.post("/auth/logout", headers=h).status_code == 200
    assert client.get("/me", headers=h).status_code == 401


def test_repeated_failed_logins_lock_the_username(client):
    user = "pytest_nobody"
    codes = [client.post("/auth/token", data={"username": user, "password": "x"}).status_code for _ in range(6)]
    assert codes[:5] == [401] * 5 and codes[5] == 429


def test_production_guard_lists_development_defaults():
    from tbds.api.security import production_problems
    probs = " ".join(production_problems())
    assert "JWT_SECRET" in probs and "PSEUDONYM_SALT" in probs and "CORS" in probs
