"""Persist pipeline results into PostgreSQL."""
from __future__ import annotations

import os

import bcrypt
import numpy as np
import pandas as pd
from sqlalchemy import delete, insert, text
from sqlalchemy.engine import Engine

from tbds.config import get_settings
from tbds.db import schema as S
from tbds.pipeline.run import clean, df_records


def _date(s):
    return pd.to_datetime(s).dt.date.where(pd.to_datetime(s).notna(), None)


def seed_users(engine: Engine, ds, password: str | None = None) -> int:
    password = password or os.environ.get("TBDS_SEED_PASSWORD", "ChangeMe!2026")
    h = bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=10)).decode()
    pilot = get_settings().pilot.districts
    rows = [
        dict(username="state_admin", password_hash=h, role="state_admin", district=None, facility_id=None, display_name="State TB Cell (demo)"),
        dict(username="data_manager", password_hash=h, role="data_manager", district=None, facility_id=None, display_name="State data manager (demo)"),
    ]
    slug = lambda s: s.lower().replace(" ", "_")
    for d in ds.districts.district:
        rows.append(dict(username=f"dto_{slug(d)}", password_hash=h, role="district_officer", district=d, facility_id=None, display_name=f"District TB Officer, {d} (demo)"))
    for _, f in ds.facilities.iterrows():
        if f.district in pilot:
            rows.append(dict(username=f"tu_{f.facility_id.lower()}", password_hash=h, role="facility_user", district=f.district, facility_id=f.facility_id, display_name=f"{f.facility_name} team (demo)"))
            rows.append(dict(username=f"field_{f.facility_id.lower()}", password_hash=h, role="field_worker", district=f.district, facility_id=f.facility_id, display_name=f"Field staff, {f.facility_name} (demo)"))
    with engine.begin() as c:
        c.execute(delete(S.users))
        c.execute(insert(S.users), [{**r, "active": True} for r in rows])
    return len(rows)


def persist(engine: Engine, R: dict, include_identities: bool = True) -> dict:
    ds = R["ds"]
    S.create_all(engine, drop=False)
    counts = {}
    with engine.begin() as c:
        for t in (S.patient_scores, S.referral_gaps, S.duplicate_candidates, S.facility_scores, S.district_scores, S.artifacts,
                  S.patients, S.facilities, S.districts, S.identities):
            c.execute(delete(t))

    strain = R["strain"].set_index("district")
    dist_out = R["district_outcomes"].set_index("district")
    with engine.begin() as c:
        c.execute(insert(S.districts), [{"district": d, "data": clean({**strain.loc[d].to_dict(), **{"outcomes": dist_out.loc[d].to_dict() if d in dist_out.index else {}}})} for d in strain.index])
        c.execute(insert(S.facilities), [{"facility_id": r.facility_id, "district": r.district, "name": r.facility_name,
                                          "data": clean(r._asdict())} for r in ds.facilities.itertuples(index=False)])
    p = ds.patients[["patient_key", "district", "facility_id", "sex", "age", "status", "notified_date", "treatment_start_date",
                     "final_outcome", "death_date", "last_adherence_date", "drug_resistant", "hiv_positive"]].copy()
    for col in ["notified_date", "treatment_start_date", "death_date", "last_adherence_date"]:
        p[col] = p[col].astype("object").where(p[col].notna(), None)
        p[col] = [v.date() if v is not None and not pd.isna(v) else None for v in p[col]]
    p["hiv_positive"] = p.hiv_positive.astype(float).where(p.hiv_positive.notna(), None)
    p.to_sql("patients", engine, if_exists="append", index=False, chunksize=5000, method="multi")
    counts["patients"] = len(p)

    if include_identities:
        ident = ds.identities[["patient_key", "first_name", "last_name", "guardian_name", "phone", "village", "district", "facility_id"]]
        ident.to_sql("identities", engine, if_exists="append", index=False, chunksize=5000, method="multi")
        counts["identities"] = len(ident)

    sc = R["scores"].drop(columns=["reasons_source"]).copy()
    sc["treatment_start_date"] = pd.to_datetime(sc.treatment_start_date).dt.date
    sc_rows = clean(sc.to_dict(orient="records"))
    with engine.begin() as c:
        c.execute(insert(S.patient_scores), sc_rows)
    counts["patient_scores"] = len(sc_rows)

    fac = R["facilities"]
    rows = []
    for r in fac.to_dict(orient="records"):
        rows.append({"facility_id": r["facility_id"], "district": r["district"], "index_score": float(r["index_score"]), "priority": r["priority"], "data": clean(r)})
    with engine.begin() as c:
        c.execute(insert(S.facility_scores), rows)
        d = R["district_outcomes"]
        c.execute(insert(S.district_scores), [{"district": r["district"], "data": clean(r)} for r in d.to_dict(orient="records")])
    counts["facility_scores"] = len(rows)

    g = R["gaps"][["gap_type", "patient_key", "facility_id", "district", "reference_date", "days_open", "over_by_days", "severity", "record_id"]].copy()
    g["reference_date"] = pd.to_datetime(g.reference_date).dt.date
    g.to_sql("referral_gaps", engine, if_exists="append", index=False, chunksize=5000, method="multi")
    counts["referral_gaps"] = len(g)

    q = R["queue"].copy()
    pk_dist = ds.patients.set_index("patient_key").district
    q["district"] = q.key_a.map(pk_dist)
    q["status"] = "pending"
    q[["key_a", "key_b", "weight", "probability", "band", "agreeing_fields", "disagreeing_fields", "district", "status"]].to_sql(
        "duplicate_candidates", engine, if_exists="append", index=False, chunksize=5000, method="multi")
    counts["duplicate_candidates"] = len(q)

    art = {
        "model_cards": R["cards"], "data_quality": R["quality"], "dedup_evaluation": R["dedup_eval"],
        "facility_validation": R["fac_validation"], "state_series": df_records(R["state_series"]),
        "trends_projection": df_records(R["trends_proj"]), "trends_monthly": df_records(R["trends_wide"]),
        "death_audit": {"timing": R["audit"]["timing"], "factors": R["audit"]["factors"], "facility_oe": df_records(R["audit"]["facility_oe"]),
                        "audit_queue": R["audit"]["audit_queue"],
                        "addressable_share": R["audit"]["early_deaths_with_addressable_factor_share"],
                        "addressable_two_plus_share": R["audit"]["early_deaths_with_two_or_more_addressable_share"]},
        "gap_summary_by_type": R["gap_summary"]["by_type"],
        "meta": {"version": R["version"], "as_of": str(ds.as_of.date()), "source": ds.source, "pilot_districts": get_settings().pilot.districts},
    }
    with engine.begin() as c:
        c.execute(insert(S.artifacts), [{"name": k, "data": clean(v)} for k, v in art.items()])
    seeded = seed_users(engine, ds)
    counts["users"] = seeded
    return counts
