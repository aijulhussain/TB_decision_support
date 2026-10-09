import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from tbds.db import schema as S

try:
    with S.get_engine().connect() as c:
        have = bool(c.execute(text("select count(*) from users")).scalar())
except Exception:  # pragma: no cover
    have = False

pytestmark = pytest.mark.skipif(not have, reason="needs the loaded PostgreSQL database (run `python -m tbds.cli run-all`)")

PW = "ChangeMe!2026"


@pytest.fixture(scope="module")
def client():
    from tbds.api.main import app
    return TestClient(app)


def _h(client, user):
    r = client.post("/auth/token", data={"username": user, "password": PW})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def test_auth_required_and_bad_password(client):
    assert client.get("/overview").status_code == 401
    assert client.post("/auth/token", data={"username": "state_admin", "password": "wrong"}).status_code == 401


def test_district_officer_is_scoped_to_own_district(client):
    h = _h(client, "dto_dibrugarh")
    items = client.get("/patients/review-list?limit=200", headers=h).json()["items"]
    assert items and {i["district"] for i in items} == {"Dibrugarh"}
    assert all("first_name" not in i and "phone" not in i for i in items)       # pseudonymous only


def test_live_lists_are_pilot_only(client):
    assert client.get("/patients/review-list", headers=_h(client, "dto_cachar")).status_code == 403


def test_roles_cannot_reach_each_others_resources(client):
    assert client.get("/patients/review-list", headers=_h(client, "data_manager")).status_code == 403
    assert client.get("/facilities/priority", headers=_h(client, "field_as-dib-tu01")).status_code == 403
    assert client.get("/audit/log", headers=_h(client, "dto_dibrugarh")).status_code == 403


def test_facility_user_sees_only_own_facility(client):
    h = _h(client, "tu_as-dib-tu01")
    items = client.get("/patients/review-list?limit=200", headers=h).json()["items"]
    assert {i["facility_id"] for i in items} <= {"AS-DIB-TU01"}


def test_duplicate_names_are_masked(client):
    d = client.get("/duplicates?limit=5", headers=_h(client, "data_manager")).json()["items"][0]
    assert "*" in d["record_a"]["name"] and "*" in d["record_b"]["name"]


def test_identity_needs_a_reason_and_is_audit_logged(client):
    h = _h(client, "dto_dibrugarh")
    key = client.get("/patients/review-list?limit=1", headers=h).json()["items"][0]["patient_key"]
    assert client.get(f"/patients/{key}/identity", headers=h).status_code == 422
    assert client.get(f"/patients/{key}/identity?reason=home visit planning", headers=h).status_code == 200
    log = client.get("/audit/log?action=reveal_identity&limit=5", headers=_h(client, "state_admin")).json()["items"]
    assert any(l["resource"] == f"patient:{key}" and l["detail"]["reason"] == "home visit planning" for l in log)


def test_cannot_act_on_a_patient_outside_scope(client):
    other = client.get("/patients/review-list?limit=1", headers=_h(client, "dto_kamrup_metro")).json()["items"][0]["patient_key"]
    r = client.post(f"/patients/{other}/actions", headers=_h(client, "dto_dibrugarh"), json={"list_type": "early_death", "action": "reviewed"})
    assert r.status_code == 404


def test_exports_are_logged_and_carry_the_notice(client):
    r = client.get("/reports/export?report=facility_priority", headers=_h(client, "state_admin"))
    assert r.status_code == 200 and r.text.startswith("# Decision support only")
    assert client.get("/audit/log?action=export&limit=3", headers=_h(client, "state_admin")).json()["count"] >= 1
