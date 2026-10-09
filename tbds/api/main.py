"""REST API: role-scoped, audit-logged, decision-support only."""
from __future__ import annotations

import csv
import io
import json
from datetime import datetime, timezone
from functools import lru_cache

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, Field
from sqlalchemy import insert, text
from sqlalchemy.engine import Engine

from tbds import __version__
from tbds.api import security as SEC
from tbds.api.security import (DEV_SEED_PASSWORD, Principal, STATE_ROLES, create_token, current_principal, limiter, mask,
                               production_problems, require_roles, scope, verify_password)
from tbds.config import ROOT, get_settings
from tbds.db import schema as S

DASH = ROOT / "dashboard"
GAP_ROLES = ("state_admin", "district_officer", "facility_user", "field_worker")
GAP_WRITE_ROLES = ("district_officer", "facility_user", "field_worker")
AUDIT_FACTORS = ("delay_in_diagnosis", "delay_in_treatment_start", "no_nutrition_support", "missed_follow_up", "comorbidity_not_managed",
                 "referral_not_completed", "drug_resistance_not_detected", "adverse_drug_reaction", "patient_or_social_factors", "other")

NOTICE = ("Decision support only. Scores and flags prompt a review by an authorised person. They do not replace clinical "
          "diagnosis or authorised programme decisions.")


@lru_cache(maxsize=1)
def _engine() -> Engine:
    return S.get_engine()


def get_db() -> Engine:
    return _engine()


def audit(db: Engine, p: Principal, action: str, resource: str, detail: dict | None = None) -> None:
    with db.begin() as c:
        c.execute(insert(S.audit_log).values(username=p.username, role=p.role, action=action, resource=resource, detail=detail or {}))


class ActionIn(BaseModel):
    list_type: str
    action: str = Field(pattern="^(reviewed|acted|disagree|not_applicable)$")
    note: str = Field("", max_length=500)


class DecisionIn(BaseModel):
    decision: str = Field(pattern="^(confirm|reject)$")
    note: str = Field("", max_length=500)


class GapActionIn(BaseModel):
    action: str = Field(pattern="^(assigned|note|resolved|reopened)$")
    assignee: str | None = Field(None, max_length=60)
    note: str = Field("", max_length=500)


class DeathReviewIn(BaseModel):
    status: str = Field(pattern="^(in_progress|completed)$")
    avoidable: str | None = Field(None, pattern="^(yes|no|unclear)$")
    contributing: list[str] = Field(default_factory=list, max_length=len(AUDIT_FACTORS))
    summary: str = Field("", max_length=2000)
    actions_agreed: str = Field("", max_length=2000)


def _demo_password_still_works(db: Engine) -> bool:
    try:
        with db.connect() as c:
            h = c.execute(text("SELECT password_hash FROM users WHERE username='state_admin'")).scalar()
    except Exception:  # noqa: BLE001  (no users table yet: nothing to check)
        return False
    return bool(h) and verify_password(DEV_SEED_PASSWORD, h)


def _revocation_checker(db_fn):
    cache: set[str] = set()

    def check(jti: str) -> bool:
        if jti in cache:
            return True
        try:
            with db_fn().connect() as c:
                hit = c.execute(text("SELECT 1 FROM revoked_tokens WHERE jti=:j"), {"j": jti}).first() is not None
        except Exception:  # noqa: BLE001  (table missing before migration: nothing revoked)
            return False
        if hit:
            cache.add(jti)
        return hit
    return check


def create_app() -> FastAPI:
    cfg = get_settings()
    env = cfg.get("app", {}).get("env", "development")
    if env == "production":
        probs = production_problems()
        if _demo_password_still_works(_engine()):
            probs.append("The demo accounts still accept the shared demo password; re-seed with TBDS_SEED_PASSWORD or real accounts")
        if probs:
            raise RuntimeError("Refusing to start in production:\n  - " + "\n  - ".join(probs))
    SEC.is_revoked = _revocation_checker(_engine)

    app = FastAPI(title="TB Risk Stratification & Programme Decision Support", version=__version__,
                  description=NOTICE + " Demo data are synthetic unless `data.source=extract`.")
    origins = list(cfg.get("app", {}).get("cors_origins", ["*"]))
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST"], allow_headers=["Authorization", "Content-Type"])

    @app.middleware("http")
    async def security_headers(request, call_next):
        resp = await call_next(request)
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "no-referrer")
        resp.headers.setdefault("X-Frame-Options", "DENY")
        if request.url.path.startswith(("/patients", "/referral-gaps", "/duplicates", "/death-audit", "/tasks", "/audit")):
            resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.get("/", include_in_schema=False)
    def root():
        return RedirectResponse("/app/")

    @app.get("/app", include_in_schema=False)
    def dashboard_redirect():
        return RedirectResponse("/app/")

    @app.get("/app/", include_in_schema=False)
    def dashboard_page():
        page = DASH / "index.html"
        if not page.exists():
            raise HTTPException(404, "Dashboard page not built. Run: python -m tbds.cli build-dashboard")
        return FileResponse(page, media_type="text/html", headers={"Cache-Control": "no-cache"})

    @app.get("/app/{asset}", include_in_schema=False)
    def dashboard_asset(asset: str):
        files = {"sw.js": "application/javascript", "manifest.webmanifest": "application/manifest+json", "icon.svg": "image/svg+xml"}
        if asset not in files or not (DASH / asset).exists():
            raise HTTPException(404, "Not found")
        return FileResponse(DASH / asset, media_type=files[asset], headers={"Cache-Control": "no-cache"})

    @app.get("/health", tags=["system"])
    def health(db: Engine = Depends(get_db)):
        with db.connect() as c:
            c.execute(text("SELECT 1"))
        return {"status": "ok", "version": __version__}

    # ---- auth ----
    @app.post("/auth/token", tags=["auth"])
    def token(form: OAuth2PasswordRequestForm = Depends(), db: Engine = Depends(get_db)):
        limiter.check(form.username)
        with db.connect() as c:
            u = c.execute(text("SELECT * FROM users WHERE username=:u AND active"), {"u": form.username}).mappings().first()
        if not u or not verify_password(form.password, u["password_hash"]):
            limiter.failed(form.username)
            with db.begin() as c:
                c.execute(insert(S.audit_log).values(username=form.username[:60], role=None, action="login_failed", resource="auth", detail={}))
            raise HTTPException(401, "Incorrect username or password")
        limiter.succeeded(form.username)
        p = Principal(u["username"], u["role"], u["district"], u["facility_id"], u["display_name"] or "")
        audit(db, p, "login", "auth")
        return {"access_token": create_token(p), "token_type": "bearer", "role": p.role, "district": p.district, "facility_id": p.facility_id}

    @app.post("/auth/logout", tags=["auth"])
    def logout(p: Principal = Depends(current_principal), db: Engine = Depends(get_db)):
        """Revoke the current token so it cannot be reused, even before it expires."""
        if p.jti:
            exp = datetime.fromtimestamp(p.exp, timezone.utc) if p.exp else datetime.now(timezone.utc)
            with db.begin() as c:
                c.execute(text("DELETE FROM revoked_tokens WHERE expires_at < now()"))
                c.execute(text("INSERT INTO revoked_tokens (jti, expires_at) VALUES (:j, :e) ON CONFLICT DO NOTHING"), {"j": p.jti, "e": exp})
        audit(db, p, "logout", "auth")
        return {"signed_out": True}

    @app.get("/me", tags=["auth"])
    def me(p: Principal = Depends(current_principal)):
        d = {k: v for k, v in p.__dict__.items() if k not in ("jti", "exp")}
        return d | {"pilot_districts": get_settings().pilot.districts, "notice": NOTICE, "audit_factors": list(AUDIT_FACTORS)}

    # ---- overview ----
    @app.get("/overview", tags=["views"])
    def overview(p: Principal = Depends(current_principal), db: Engine = Depends(get_db)):
        sc, prm = scope(p)
        with db.connect() as c:
            on_tx = c.execute(text(f"SELECT count(*) FROM patients WHERE status='on_treatment' AND {sc}"), prm).scalar()
            gaps = c.execute(text(f"SELECT gap_type, count(*) n FROM referral_gaps WHERE {sc} GROUP BY 1"), prm).mappings().all()
            fac = c.execute(text(f"SELECT priority, count(*) n FROM facility_scores WHERE {sc.replace('facility_id', 'facility_id')} GROUP BY 1"), prm).mappings().all()
            dup = c.execute(text("SELECT count(*) FROM duplicate_candidates WHERE status='pending'" + ("" if p.role in STATE_ROLES else " AND district = :d")),
                            {"d": p.district}).scalar() if p.role != "facility_user" and p.role != "field_worker" else None
            meta = c.execute(text("SELECT data FROM artifacts WHERE name='meta'")).scalar()
        audit(db, p, "view", "overview")
        return {"on_treatment": on_tx, "open_gaps": {g["gap_type"]: g["n"] for g in gaps}, "facility_priority": {f["priority"]: f["n"] for f in fac},
                "pending_duplicate_pairs": dup, "meta": meta, "notice": NOTICE}

    # ---- patient-level risk lists ----
    @app.get("/patients/review-list", tags=["patients"])
    def review_list(list_type: str = Query("early_death", pattern="^(early_death|unfavourable_outcome)$"), tier: str | None = None,
                    facility_id: str | None = None, limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0),
                    p: Principal = Depends(require_roles("state_admin", "district_officer", "facility_user", "field_worker")),
                    db: Engine = Depends(get_db)):
        pilot = get_settings().pilot.districts
        if p.role != "state_admin" and p.district not in pilot:
            raise HTTPException(403, f"Live patient risk lists are enabled only in pilot districts ({', '.join(pilot)}).")
        sc, prm = scope(p, "s.district", "s.facility_id")
        # last_action: the most recent review recorded for this patient on this list, by anyone in scope
        q = f"""SELECT s.patient_key, s.list_type, s.risk, s.tier, s.reasons, s.facility_id, s.district, s.days_since_start, s.rank_in_facility,
                       pt.age, pt.sex, pt.drug_resistant, ra.action AS last_action, ra.note AS last_note, ra.ts AS last_action_at, ra.username AS last_action_by
                FROM patient_scores s JOIN patients pt USING (patient_key)
                LEFT JOIN LATERAL (SELECT action, note, ts, username FROM review_actions r
                                   WHERE r.patient_key = s.patient_key AND r.list_type = s.list_type ORDER BY ts DESC LIMIT 1) ra ON TRUE
                WHERE s.on_review_list AND s.list_type=:lt AND s.district = ANY(:pilot) AND {sc}"""
        params = {"lt": list_type, "pilot": pilot, **prm}
        if tier:
            q += " AND s.tier=:tier"; params["tier"] = tier
        if facility_id:
            q += " AND s.facility_id=:fid"; params["fid"] = facility_id
        q += " ORDER BY s.risk DESC LIMIT :lim OFFSET :off"; params["lim"] = limit; params["off"] = offset
        with db.connect() as c:
            rows = [dict(r) for r in c.execute(text(q), params).mappings()]
        audit(db, p, "view_patient_list", f"review-list:{list_type}", {"rows": len(rows), "facility": facility_id, "tier": tier})
        return {"notice": NOTICE, "pilot_districts": pilot, "list_type": list_type, "count": len(rows), "items": rows}

    @app.post("/patients/{patient_key}/actions", tags=["patients"])
    def record_action(patient_key: str, body: ActionIn, p: Principal = Depends(require_roles("district_officer", "facility_user", "field_worker")),
                      db: Engine = Depends(get_db)):
        sc, prm = scope(p, "district", "facility_id")
        with db.connect() as c:
            ok = c.execute(text(f"SELECT 1 FROM patients WHERE patient_key=:k AND {sc}"), {"k": patient_key, **prm}).first()
        if not ok:
            raise HTTPException(404, "Patient not found in your scope")
        with db.begin() as c:
            c.execute(insert(S.review_actions).values(username=p.username, patient_key=patient_key, list_type=body.list_type, action=body.action, note=body.note))
        audit(db, p, "record_action", f"patient:{patient_key}", {"action": body.action})
        return {"recorded": True, "feedback_use": "Reviewer feedback, including disagreement, is used in model reviews."}

    @app.get("/patients/{patient_key}/identity", tags=["patients"])
    def identity(patient_key: str, reason: str = Query(..., min_length=8, description="Why identifiers are needed (logged)"),
                 p: Principal = Depends(require_roles("district_officer", "facility_user", "field_worker", "data_manager")), db: Engine = Depends(get_db)):
        sc, prm = scope(p, "district", "facility_id")
        with db.connect() as c:
            r = c.execute(text(f"SELECT * FROM identities WHERE patient_key=:k AND {sc}"), {"k": patient_key, **prm}).mappings().first()
        audit(db, p, "reveal_identity", f"patient:{patient_key}", {"reason": reason, "found": bool(r)})
        if not r:
            raise HTTPException(404, "Not found in your scope")
        return dict(r)

    # ---- facilities and districts ----
    @app.get("/facilities/priority", tags=["views"])
    def facility_priority(district: str | None = None, p: Principal = Depends(require_roles("state_admin", "district_officer")), db: Engine = Depends(get_db)):
        sc, prm = scope(p, "district", None)
        q = f"SELECT facility_id, district, index_score, priority, data FROM facility_scores WHERE {sc}"
        if district:
            q += " AND district=:d"; prm["d"] = district
        q += " ORDER BY index_score DESC"
        with db.connect() as c:
            rows = [{**dict(r), "data": r["data"]} for r in c.execute(text(q), prm).mappings()]
        audit(db, p, "view", "facility-priority", {"district": district})
        return {"notice": NOTICE, "items": rows}

    @app.get("/districts/priority", tags=["views"])
    def district_priority(p: Principal = Depends(require_roles("state_admin", "district_officer")), db: Engine = Depends(get_db)):
        with db.connect() as c:
            plan = {r["district"]: r["data"] for r in c.execute(text("SELECT district, data FROM districts")).mappings()}
            outc = {r["district"]: r["data"] for r in c.execute(text("SELECT district, data FROM district_scores")).mappings()}
        items = [{"district": d, "planning": plan[d], "outcomes": outc.get(d)} for d in plan if p.role in STATE_ROLES or d == p.district]
        audit(db, p, "view", "district-priority")
        return {"provenance": {"planning": "REAL: NHM Assam NTEP District RoP 2024-26 (planning targets, not outcomes)",
                               "outcomes": "SYNTHETIC unless data.source=extract"}, "items": items}

    # ---- gaps ----
    @app.get("/referral-gaps", tags=["views"])
    def gaps(gap_type: str | None = None, district: str | None = None, facility_id: str | None = None,
             status_: str | None = Query(None, alias="status", pattern="^(open|assigned|resolved|unresolved)$"),
             assignee: str | None = None, limit: int = Query(200, ge=1, le=1000), offset: int = Query(0, ge=0),
             p: Principal = Depends(require_roles(*GAP_ROLES)), db: Engine = Depends(get_db)):
        sc, prm = scope(p, "g.district", "g.facility_id")
        # Work state comes from the gap's action history: last 'resolved' or 'reopened' sets the status, last 'assigned' sets the owner.
        q = f"""WITH st AS (
                  SELECT g.*,
                    (SELECT action FROM gap_actions a WHERE a.gap_type=g.gap_type AND a.record_id=g.record_id AND a.action IN ('resolved','reopened') ORDER BY ts DESC LIMIT 1) AS res,
                    (SELECT assignee FROM gap_actions a WHERE a.gap_type=g.gap_type AND a.record_id=g.record_id AND a.action='assigned' ORDER BY ts DESC LIMIT 1) AS owner,
                    (SELECT max(ts) FROM gap_actions a WHERE a.gap_type=g.gap_type AND a.record_id=g.record_id) AS last_activity,
                    (SELECT count(*) FROM gap_actions a WHERE a.gap_type=g.gap_type AND a.record_id=g.record_id AND a.action='note') AS notes
                  FROM referral_gaps g WHERE {sc})
                SELECT gap_type, patient_key, facility_id, district, reference_date, days_open, over_by_days, severity, record_id,
                       CASE WHEN res='resolved' THEN 'resolved' WHEN owner IS NOT NULL THEN 'assigned' ELSE 'open' END AS status,
                       owner AS assignee, last_activity, notes
                FROM st WHERE TRUE"""
        for col, val in (("gap_type", gap_type), ("district", district), ("facility_id", facility_id)):
            if val:
                q += f" AND {col}=:{col}"; prm[col] = val
        if status_ == "unresolved":
            q += " AND res IS DISTINCT FROM 'resolved'"
        elif status_ == "resolved":
            q += " AND res='resolved'"
        elif status_ == "assigned":
            q += " AND res IS DISTINCT FROM 'resolved' AND owner IS NOT NULL"
        elif status_ == "open":
            q += " AND res IS DISTINCT FROM 'resolved' AND owner IS NULL"
        if assignee:
            q += " AND owner=:owner"; prm["owner"] = assignee
        q += " ORDER BY over_by_days DESC LIMIT :lim OFFSET :off"; prm["lim"] = limit; prm["off"] = offset
        with db.connect() as c:
            rows = [dict(r) for r in c.execute(text(q), prm).mappings()]
        audit(db, p, "view", "referral-gaps", {"rows": len(rows)})
        return {"count": len(rows), "items": rows}

    def _gap_in_scope(db: Engine, p: Principal, gap_type: str, record_id: str) -> dict:
        sc, prm = scope(p)
        with db.connect() as c:
            g = c.execute(text(f"SELECT gap_type, record_id, patient_key, facility_id, district FROM referral_gaps WHERE gap_type=:t AND record_id=:r AND {sc}"),
                          {"t": gap_type, "r": record_id, **prm}).mappings().first()
        if not g:
            raise HTTPException(404, "Gap not found in your scope")
        return dict(g)

    @app.get("/referral-gaps/{gap_type}/{record_id}/history", tags=["workflow"])
    def gap_history(gap_type: str, record_id: str, p: Principal = Depends(require_roles(*GAP_ROLES)), db: Engine = Depends(get_db)):
        _gap_in_scope(db, p, gap_type, record_id)
        with db.connect() as c:
            rows = [dict(r) for r in c.execute(text("SELECT ts, username, action, assignee, note FROM gap_actions WHERE gap_type=:t AND record_id=:r ORDER BY ts DESC"),
                                               {"t": gap_type, "r": record_id}).mappings()]
        return {"items": rows}

    @app.post("/referral-gaps/{gap_type}/{record_id}/actions", tags=["workflow"])
    def gap_action(gap_type: str, record_id: str, body: GapActionIn, p: Principal = Depends(require_roles(*GAP_WRITE_ROLES)),
                   db: Engine = Depends(get_db)):
        g = _gap_in_scope(db, p, gap_type, record_id)
        if body.action == "assigned":
            if not body.assignee:
                raise HTTPException(422, "Choose someone to assign the gap to")
            with db.connect() as c:
                u = c.execute(text("SELECT role, district, facility_id FROM users WHERE username=:u AND active"), {"u": body.assignee}).mappings().first()
            if not u or u["role"] not in GAP_WRITE_ROLES or u["district"] != g["district"] or (u["facility_id"] and u["facility_id"] != g["facility_id"]):
                raise HTTPException(422, "That person cannot work on gaps at this facility")
        if body.action == "note" and not body.note.strip():
            raise HTTPException(422, "A note cannot be empty")
        with db.begin() as c:
            c.execute(insert(S.gap_actions).values(username=p.username, gap_type=gap_type, record_id=record_id, patient_key=g["patient_key"],
                                                   facility_id=g["facility_id"], district=g["district"], action=body.action,
                                                   assignee=body.assignee if body.action == "assigned" else None, note=body.note.strip()))
        audit(db, p, "gap_action", f"gap:{gap_type}:{record_id}", {"action": body.action, "assignee": body.assignee})
        return {"recorded": True, "action": body.action}

    @app.get("/users/assignable", tags=["workflow"])
    def assignable(facility_id: str, p: Principal = Depends(require_roles(*GAP_WRITE_ROLES)), db: Engine = Depends(get_db)):
        """People who can take a gap at this facility: its facility and field staff, plus the district officer."""
        with db.connect() as c:
            f = c.execute(text("SELECT district FROM facilities WHERE facility_id=:f"), {"f": facility_id}).scalar()
            if not f or (p.role != "district_officer" and p.facility_id != facility_id) or (p.role == "district_officer" and f != p.district):
                raise HTTPException(404, "Facility not found in your scope")
            rows = c.execute(text("""SELECT username, role, display_name FROM users WHERE active AND
                                     ((facility_id=:f AND role IN ('facility_user','field_worker')) OR (role='district_officer' AND district=:d))
                                     ORDER BY role DESC, username"""), {"f": facility_id, "d": f}).mappings().all()
        return {"items": [dict(r) for r in rows]}

    # ---- duplicates ----
    @app.get("/duplicates", tags=["data quality"])
    def duplicates(status_: str = Query("pending", alias="status", pattern="^(pending|confirmed|rejected)$"),
                   limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0),
                   p: Principal = Depends(require_roles("state_admin", "data_manager", "district_officer")), db: Engine = Depends(get_db)):
        sc, prm = scope(p, "d.district", None)
        q = f"""SELECT d.id, d.probability, d.weight, d.band, d.agreeing_fields, d.disagreeing_fields, d.district, d.status,
                       a.first_name fa, a.last_name la, a.village va, a.facility_id fida, b.first_name fb, b.last_name lb, b.village vb, b.facility_id fidb
                FROM duplicate_candidates d JOIN identities a ON a.patient_key=d.key_a JOIN identities b ON b.patient_key=d.key_b
                WHERE d.status=:st AND {sc} ORDER BY d.probability DESC LIMIT :lim OFFSET :off"""
        with db.connect() as c:
            rows = c.execute(text(q), {"st": status_, "lim": limit, "off": offset, **prm}).mappings().all()
        items = [{"id": r["id"], "probability": round(r["probability"], 4), "band": r["band"], "district": r["district"], "status": r["status"],
                  "matching": r["agreeing_fields"], "differing": r["disagreeing_fields"],
                  "record_a": {"name": f"{mask(r['fa'])} {mask(r['la'])}", "village": mask(r["va"]), "facility": r["fida"]},
                  "record_b": {"name": f"{mask(r['fb'])} {mask(r['lb'])}", "village": mask(r["vb"]), "facility": r["fidb"]}} for r in rows]
        audit(db, p, "view", "duplicates", {"rows": len(items)})
        return {"note": "Names are masked. Nothing is merged automatically: a person confirms or rejects each pair.", "count": len(items), "items": items}

    @app.post("/duplicates/{pair_id}/decision", tags=["data quality"])
    def decide(pair_id: int, body: DecisionIn, p: Principal = Depends(require_roles("state_admin", "data_manager", "district_officer")), db: Engine = Depends(get_db)):
        sc, prm = scope(p, "district", None)
        with db.begin() as c:
            r = c.execute(text(f"""UPDATE duplicate_candidates SET status=:s, reviewed_by=:u, reviewed_at=:t, review_note=:n
                                   WHERE id=:i AND status='pending' AND {sc} RETURNING id"""),
                          {"s": "confirmed" if body.decision == "confirm" else "rejected", "u": p.username, "t": datetime.now(timezone.utc), "n": body.note, "i": pair_id, **prm}).first()
        if not r:
            raise HTTPException(404, "Pending pair not found in your scope")
        audit(db, p, "duplicate_decision", f"pair:{pair_id}", {"decision": body.decision})
        return {"id": pair_id, "status": "confirmed" if body.decision == "confirm" else "rejected", "note": "Decision recorded. Records are not merged here: merging is done in Nikshay by authorised staff."}

    # ---- artifacts ----
    def _artifact(name: str, p: Principal, db: Engine):
        with db.connect() as c:
            d = c.execute(text("SELECT data FROM artifacts WHERE name=:n"), {"n": name}).scalar()
        if d is None:
            raise HTTPException(404, f"{name} not available")
        audit(db, p, "view", name)
        return d

    @app.get("/death-audit/summary", tags=["views"])
    def death_summary(p: Principal = Depends(require_roles("state_admin", "district_officer")), db: Engine = Depends(get_db)):
        d = _artifact("death_audit", p, db)
        out = {"timing": d["timing"], "factors": d["factors"], "addressable_share": d["addressable_share"]}
        out["facility_oe"] = d["facility_oe"] if p.role in STATE_ROLES else [f for f in d["facility_oe"] if f["district"] == p.district]
        return out

    def _latest_death_reviews(db: Engine, keys: list[str]) -> dict:
        if not keys:
            return {}
        with db.connect() as c:
            rows = c.execute(text("""SELECT DISTINCT ON (patient_key) patient_key, ts, username, status, avoidable, contributing, summary, actions_agreed
                                     FROM death_reviews WHERE patient_key = ANY(:k) ORDER BY patient_key, ts DESC"""), {"k": keys}).mappings().all()
        return {r["patient_key"]: dict(r) for r in rows}

    @app.get("/death-audit/queue", tags=["views"])
    def death_queue(limit: int = Query(300, ge=1, le=1000), offset: int = Query(0, ge=0),
                    p: Principal = Depends(require_roles("state_admin", "district_officer")), db: Engine = Depends(get_db)):
        d = _artifact("death_audit", p, db)
        items = d["audit_queue"] if p.role in STATE_ROLES else [q for q in d["audit_queue"] if q["district"] == p.district]
        page = items[offset:offset + limit]
        rev = _latest_death_reviews(db, [q["patient_key"] for q in page])
        page = [q | {"review": rev.get(q["patient_key"])} for q in page]
        return {"count": len(items), "items": page, "factors": list(AUDIT_FACTORS)}

    @app.post("/death-audit/{patient_key}/review", tags=["workflow"])
    def death_review(patient_key: str, body: DeathReviewIn, p: Principal = Depends(require_roles("district_officer")), db: Engine = Depends(get_db)):
        """Record (or update) the district's audit of one death. Each save is kept; the latest is the current finding."""
        bad = [f for f in body.contributing if f not in AUDIT_FACTORS]
        if bad:
            raise HTTPException(422, f"Unknown contributing factor(s): {', '.join(bad)}")
        if body.status == "completed" and not body.avoidable:
            raise HTTPException(422, "Say whether the death was avoidable before completing the audit")
        with db.connect() as c:
            pt = c.execute(text("SELECT facility_id, district FROM patients WHERE patient_key=:k AND death_date IS NOT NULL AND district=:d"),
                           {"k": patient_key, "d": p.district}).mappings().first()
        if not pt:
            raise HTTPException(404, "Death not found in your district")
        with db.begin() as c:
            c.execute(insert(S.death_reviews).values(username=p.username, patient_key=patient_key, facility_id=pt["facility_id"], district=pt["district"],
                                                     status=body.status, avoidable=body.avoidable, contributing=body.contributing,
                                                     summary=body.summary.strip(), actions_agreed=body.actions_agreed.strip()))
        audit(db, p, "death_review", f"patient:{patient_key}", {"status": body.status})
        return {"recorded": True, "status": body.status}

    # ---- work lists and feedback ----
    @app.get("/tasks", tags=["workflow"])
    def tasks(p: Principal = Depends(require_roles("district_officer", "facility_user", "field_worker")), db: Engine = Depends(get_db)):
        """What needs doing by me: gaps assigned to me, high-risk patients not yet reviewed, deaths awaiting audit."""
        pilot = get_settings().pilot.districts
        out: dict = {}
        mine = gaps(None, None, None, "assigned", p.username, 200, 0, p, db)["items"]
        out["gaps_assigned"] = mine
        if p.district in pilot:
            sc, prm = scope(p, "s.district", "s.facility_id")
            with db.connect() as c:
                rows = c.execute(text(f"""SELECT s.patient_key, s.list_type, s.risk, s.tier, s.facility_id, s.days_since_start, s.reasons
                                          FROM patient_scores s
                                          WHERE s.on_review_list AND s.tier='high' AND {sc}
                                            AND NOT EXISTS (SELECT 1 FROM review_actions r WHERE r.patient_key=s.patient_key AND r.list_type=s.list_type)
                                          ORDER BY s.risk DESC LIMIT 100"""), prm).mappings().all()
            out["patients_to_review"] = [dict(r) for r in rows]
        else:
            out["patients_to_review"] = []
        if p.role == "district_officer":
            with db.connect() as c:
                d = c.execute(text("SELECT data FROM artifacts WHERE name='death_audit'")).scalar() or {}
            q = [x for x in d.get("audit_queue", []) if x["district"] == p.district and x["audit_priority"] == "high"]
            rev = _latest_death_reviews(db, [x["patient_key"] for x in q])
            out["deaths_to_audit"] = [x for x in q if not rev.get(x["patient_key"]) or rev[x["patient_key"]]["status"] != "completed"][:100]
        else:
            out["deaths_to_audit"] = []
        out["counts"] = {k: len(v) for k, v in out.items() if isinstance(v, list)}
        return out

    @app.get("/feedback/summary", tags=["governance"])
    def feedback(p: Principal = Depends(require_roles("state_admin", "district_officer")), db: Engine = Depends(get_db)):
        """How reviewers responded to flags: the main input to model reviews. Disagreement is signal, not failure."""
        sc, prm = scope(p, "s.district", "s.facility_id")
        with db.connect() as c:
            latest = f"""SELECT DISTINCT ON (r.patient_key, r.list_type) r.patient_key, r.list_type, r.action, s.facility_id, s.reasons
                         FROM review_actions r JOIN patient_scores s ON s.patient_key=r.patient_key AND s.list_type=r.list_type
                         WHERE {sc} ORDER BY r.patient_key, r.list_type, r.ts DESC"""
            rows = c.execute(text(latest), prm).mappings().all()
            listed = c.execute(text(f"SELECT list_type, count(*) FROM patient_scores s WHERE s.on_review_list AND {sc} GROUP BY 1"), prm).all()
        by_action: dict = {}
        by_fac: dict = {}
        by_factor: dict = {}
        for r in rows:
            by_action.setdefault(r["list_type"], {}).setdefault(r["action"], 0)
            by_action[r["list_type"]][r["action"]] += 1
            f = by_fac.setdefault(r["facility_id"], {"reviewed": 0, "disagree": 0})
            f["reviewed"] += 1; f["disagree"] += r["action"] == "disagree"
            for reason in (r["reasons"] or []):
                x = by_factor.setdefault(reason["factor"], {"reviewed": 0, "disagree": 0})
                x["reviewed"] += 1; x["disagree"] += r["action"] == "disagree"
        audit(db, p, "view", "feedback-summary")
        return {"on_lists": {k: v for k, v in listed}, "by_action": by_action,
                "by_facility": [{"facility_id": k, **v} for k, v in sorted(by_fac.items(), key=lambda kv: -kv[1]["reviewed"])],
                "by_factor": [{"factor": k, **v} for k, v in sorted(by_factor.items(), key=lambda kv: -kv[1]["reviewed"])]}

    @app.get("/model/cards", tags=["governance"])
    def cards(p: Principal = Depends(current_principal), db: Engine = Depends(get_db)):
        return _artifact("model_cards", p, db)

    @app.get("/data-quality", tags=["governance"])
    def dq(p: Principal = Depends(require_roles("state_admin", "data_manager", "district_officer")), db: Engine = Depends(get_db)):
        return _artifact("data_quality", p, db)

    @app.get("/trends", tags=["views"])
    def trends(p: Principal = Depends(require_roles("state_admin", "district_officer")), db: Engine = Depends(get_db)):
        d = _artifact("trends_projection", p, db)
        return {"items": d if p.role in STATE_ROLES else [x for x in d if x["district"] == p.district]}

    # ---- exports and audit log ----
    @app.get("/reports/export", tags=["reports"])
    def export(report: str = Query(..., pattern="^(facility_priority|referral_gaps|review_list)$"),
               p: Principal = Depends(require_roles("state_admin", "district_officer", "facility_user")), db: Engine = Depends(get_db)):
        pilot = get_settings().pilot.districts
        if report == "facility_priority":
            if p.role == "facility_user":
                raise HTTPException(403, "Not permitted")
            sc, prm = scope(p, "district", None)
            q, cols = f"SELECT facility_id, district, index_score, priority FROM facility_scores WHERE {sc} ORDER BY index_score DESC", ["facility_id", "district", "index_score", "priority"]
        elif report == "referral_gaps":
            sc, prm = scope(p)
            q, cols = f"SELECT gap_type, facility_id, district, reference_date, days_open, over_by_days, severity, patient_key FROM referral_gaps WHERE {sc} ORDER BY over_by_days DESC", \
                ["gap_type", "facility_id", "district", "reference_date", "days_open", "over_by_days", "severity", "patient_key"]
        else:
            sc, prm = scope(p, "district", "facility_id"); prm["pilot"] = pilot
            q, cols = f"SELECT list_type, patient_key, facility_id, district, round(risk::numeric,3) risk, tier, days_since_start FROM patient_scores WHERE on_review_list AND district = ANY(:pilot) AND {sc} ORDER BY risk DESC", \
                ["list_type", "patient_key", "facility_id", "district", "risk", "tier", "days_since_start"]
        with db.connect() as c:
            rows = c.execute(text(q), prm).all()
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["# " + NOTICE]); w.writerow(cols); w.writerows(rows)
        audit(db, p, "export", f"report:{report}", {"rows": len(rows)})
        buf.seek(0)
        return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv", headers={"Content-Disposition": f"attachment; filename={report}.csv"})

    @app.get("/audit/log", tags=["governance"])
    def audit_log(action: str | None = None, username: str | None = None, limit: int = Query(100, le=1000),
                  p: Principal = Depends(require_roles("state_admin")), db: Engine = Depends(get_db)):
        q = "SELECT ts, username, role, action, resource, detail FROM audit_log WHERE TRUE"
        prm: dict = {}
        if action:
            q += " AND action=:a"; prm["a"] = action
        if username:
            q += " AND username=:u"; prm["u"] = username
        q += " ORDER BY ts DESC LIMIT :l"; prm["l"] = limit
        with db.connect() as c:
            rows = [dict(r) for r in c.execute(text(q), prm).mappings()]
        return {"count": len(rows), "items": rows}

    return app


app = create_app()
