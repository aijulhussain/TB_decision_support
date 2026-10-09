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
from tbds.api.security import (Principal, STATE_ROLES, create_token, current_principal, mask, require_roles, scope, verify_password)
from tbds.config import ROOT, get_settings
from tbds.db import schema as S

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


def create_app() -> FastAPI:
    app = FastAPI(title="TB Risk Stratification & Programme Decision Support", version=__version__,
                  description=NOTICE + " Demo data are synthetic unless `data.source=extract`.")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    @app.get("/", include_in_schema=False)
    def root():
        return RedirectResponse("/app")

    @app.get("/app", include_in_schema=False)
    def dashboard_page():
        page = ROOT / "dashboard" / "index.html"
        if not page.exists():
            raise HTTPException(404, "Dashboard page not built. Run: python -m tbds.cli build-dashboard")
        return FileResponse(page, media_type="text/html")

    @app.get("/health", tags=["system"])
    def health(db: Engine = Depends(get_db)):
        with db.connect() as c:
            c.execute(text("SELECT 1"))
        return {"status": "ok", "version": __version__}

    # ---- auth ----
    @app.post("/auth/token", tags=["auth"])
    def token(form: OAuth2PasswordRequestForm = Depends(), db: Engine = Depends(get_db)):
        with db.connect() as c:
            u = c.execute(text("SELECT * FROM users WHERE username=:u AND active"), {"u": form.username}).mappings().first()
        if not u or not verify_password(form.password, u["password_hash"]):
            raise HTTPException(401, "Incorrect username or password")
        p = Principal(u["username"], u["role"], u["district"], u["facility_id"], u["display_name"] or "")
        audit(db, p, "login", "auth")
        return {"access_token": create_token(p), "token_type": "bearer", "role": p.role, "district": p.district, "facility_id": p.facility_id}

    @app.get("/me", tags=["auth"])
    def me(p: Principal = Depends(current_principal)):
        return p.__dict__ | {"pilot_districts": get_settings().pilot.districts, "notice": NOTICE}

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
                    facility_id: str | None = None, limit: int = Query(100, le=500),
                    p: Principal = Depends(require_roles("state_admin", "district_officer", "facility_user", "field_worker")),
                    db: Engine = Depends(get_db)):
        pilot = get_settings().pilot.districts
        if p.role != "state_admin" and p.district not in pilot:
            raise HTTPException(403, f"Live patient risk lists are enabled only in pilot districts ({', '.join(pilot)}).")
        sc, prm = scope(p, "s.district", "s.facility_id")
        q = f"""SELECT s.patient_key, s.list_type, s.risk, s.tier, s.reasons, s.facility_id, s.district, s.days_since_start, s.rank_in_facility,
                       pt.age, pt.sex, pt.drug_resistant
                FROM patient_scores s JOIN patients pt USING (patient_key)
                WHERE s.on_review_list AND s.list_type=:lt AND s.district = ANY(:pilot) AND {sc}"""
        params = {"lt": list_type, "pilot": pilot, **prm}
        if tier:
            q += " AND s.tier=:tier"; params["tier"] = tier
        if facility_id:
            q += " AND s.facility_id=:fid"; params["fid"] = facility_id
        q += " ORDER BY s.risk DESC LIMIT :lim"; params["lim"] = limit
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
    def gaps(gap_type: str | None = None, district: str | None = None, facility_id: str | None = None, limit: int = Query(200, le=1000),
             p: Principal = Depends(require_roles("state_admin", "district_officer", "facility_user", "field_worker")), db: Engine = Depends(get_db)):
        sc, prm = scope(p)
        q = f"SELECT gap_type, patient_key, facility_id, district, reference_date, days_open, over_by_days, severity, record_id FROM referral_gaps WHERE {sc}"
        for col, val in (("gap_type", gap_type), ("district", district), ("facility_id", facility_id)):
            if val:
                q += f" AND {col}=:{col}"; prm[col] = val
        q += " ORDER BY over_by_days DESC LIMIT :lim"; prm["lim"] = limit
        with db.connect() as c:
            rows = [dict(r) for r in c.execute(text(q), prm).mappings()]
        audit(db, p, "view", "referral-gaps", {"rows": len(rows)})
        return {"count": len(rows), "items": rows}

    # ---- duplicates ----
    @app.get("/duplicates", tags=["data quality"])
    def duplicates(status_: str = Query("pending", alias="status", pattern="^(pending|confirmed|rejected)$"), limit: int = Query(100, le=500),
                   p: Principal = Depends(require_roles("state_admin", "data_manager", "district_officer")), db: Engine = Depends(get_db)):
        sc, prm = scope(p, "d.district", None)
        q = f"""SELECT d.id, d.probability, d.weight, d.band, d.agreeing_fields, d.disagreeing_fields, d.district, d.status,
                       a.first_name fa, a.last_name la, a.village va, a.facility_id fida, b.first_name fb, b.last_name lb, b.village vb, b.facility_id fidb
                FROM duplicate_candidates d JOIN identities a ON a.patient_key=d.key_a JOIN identities b ON b.patient_key=d.key_b
                WHERE d.status=:st AND {sc} ORDER BY d.probability DESC LIMIT :lim"""
        with db.connect() as c:
            rows = c.execute(text(q), {"st": status_, "lim": limit, **prm}).mappings().all()
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

    @app.get("/death-audit/queue", tags=["views"])
    def death_queue(p: Principal = Depends(require_roles("state_admin", "district_officer")), db: Engine = Depends(get_db)):
        d = _artifact("death_audit", p, db)
        items = d["audit_queue"] if p.role in STATE_ROLES else [q for q in d["audit_queue"] if q["district"] == p.district]
        return {"count": len(items), "items": items[:300]}

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
