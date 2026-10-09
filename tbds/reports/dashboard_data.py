"""Build the static data file behind the published demo dashboard from real pipeline outputs.

The published page cannot call the API, so it embeds a snapshot. The snapshot is generated from the same tables the API
serves, and carries provenance labels (REAL = published NHM Assam data, SYNTHETIC = generated).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from tbds.config import get_settings
from tbds.models import dedup
from tbds.pipeline.run import clean, df_records
from tbds.synth.validation import shrinkage_multiseed
from tbds.api.security import mask


def _r(x, n=4):
    return None if x is None or (isinstance(x, float) and np.isnan(x)) else round(float(x), n)


def build(R: dict, out: Path, include_multiseed: bool = True) -> Path:
    cfg = get_settings()
    ds = R["ds"]
    pilot = cfg.pilot.districts
    pk = ds.patients.set_index("patient_key")

    # ---- districts: REAL planning data + SYNTHETIC outcomes ----
    st = R["strain"].set_index("district")
    do = R["district_outcomes"].set_index("district")
    proj = R["trends_proj"].set_index("district")
    gaps = R["gaps"]
    gcount = gaps.pivot_table(index="district", columns="gap_type", values="record_id", aggfunc="size", fill_value=0)
    on_tx = ds.patients[ds.patients.status == "on_treatment"].groupby("district").size()
    districts = []
    for d in st.index:
        s, o = st.loc[d], do.loc[d]
        districts.append({
            "district": d, "pilot": d in pilot,
            "real": {"tu_count": int(s.tu_count), "tdc_count": int(s.tdc_count), "expected_patients": int(s.expected_patients),
                     "npy_ds_target": int(s.npy_ds_target), "npy_dr_target": int(s.npy_dr_target), "acf_house_visit_target": int(s.acf_house_visit_target),
                     "lab_tests_target": int(s.lab_tests_target), "ppsa_notification_target": int(s.ppsa_notification_target),
                     "tribal_action_plan": int(s.tribal_action_plan), "hill_district": int(s.hill_district),
                     "patients_per_tu": _r(s.patients_per_tu, 0), "patients_per_tdc": _r(s.patients_per_tdc, 0),
                     "lab_tests_per_patient": _r(s.lab_tests_per_patient, 2), "acf_visits_per_patient": _r(s.acf_visits_per_patient, 1),
                     "planning_strain_score": _r(s.planning_strain_score, 1), "planning_tier": s.planning_tier},
            "synthetic": {"outcome_index": _r(o.outcome_index, 1), "early_death_rate": _r(o.early_death_rate), "early_death_lo": _r(o.early_death_rate_lo), "early_death_hi": _r(o.early_death_rate_hi),
                          "pre_treatment_loss": _r(o.pre_treatment_loss), "delay_over_14d": _r(o.diagnosis_to_start_delay), "open_referral_rate": _r(o.open_referral_rate),
                          "missed_follow_up_rate": _r(o.missed_follow_up_rate), "cases_evaluated": int(o.cases_evaluated), "on_treatment": int(on_tx.get(d, 0)),
                          "gaps": {k: int(gcount.loc[d, k]) if d in gcount.index and k in gcount.columns else 0 for k in ["tested_not_notified", "notified_not_started", "referral_not_closed", "missed_follow_up"]},
                          "qoq_change_pct": _r(proj.loc[d, "qoq_change_pct"], 1) if d in proj.index else None,
                          "projected_next_quarter": _r(proj.loc[d, "projected_next_quarter"], 0) if d in proj.index else None,
                          "projected_lo": _r(proj.loc[d, "projected_lo"], 0) if d in proj.index else None,
                          "projected_hi": _r(proj.loc[d, "projected_hi"], 0) if d in proj.index else None,
                          "last_quarter": int(proj.loc[d, "last_quarter"]) if d in proj.index else None,
                          "demand_flag": proj.loc[d, "demand_flag"] if d in proj.index else None},
        })

    # ---- facilities ----
    fac = R["facilities"].copy()
    oe = R["audit"]["facility_oe"].set_index("facility_id")
    gfac = gaps.pivot_table(index="facility_id", columns="gap_type", values="record_id", aggfunc="size", fill_value=0)
    facilities = []
    for r in fac.itertuples():
        g = {k: int(gfac.loc[r.facility_id, k]) if r.facility_id in gfac.index and k in gfac.columns else 0 for k in ["tested_not_notified", "notified_not_started", "referral_not_closed", "missed_follow_up"]}
        o = oe.loc[r.facility_id] if r.facility_id in oe.index else None
        facilities.append({
            "id": r.facility_id, "name": r.facility_name, "district": r.district, "pilot": r.district in pilot,
            "index": _r(r.index_score, 1), "index_naive": _r(r.index_raw_score, 1), "priority": r.priority, "drivers": list(r.drivers),
            "cases": int(r.cases_evaluated), "low_data": bool(r.low_data), "on_treatment": int(r.on_treatment_now),
            "early_death": {"shrunk": _r(r.early_death_rate), "raw": _r(r.early_death_rate_raw), "lo": _r(r.early_death_rate_lo), "hi": _r(r.early_death_rate_hi)},
            "pre_tx_loss": {"shrunk": _r(r.pre_treatment_loss), "raw": _r(r.pre_treatment_loss_raw)},
            "delay_over_14d": _r(r.diagnosis_to_start_delay), "open_referral_rate": _r(r.open_referral_rate), "missed_follow_up_rate": _r(r.missed_follow_up_rate),
            "median_delay_days": _r(r.median_delay_days, 1), "supervision_gap": _r(r.supervision_gap, 2), "last_supervision": r.last_supervision_date,
            "visits_90d": int(r.supervision_visits_90d), "gaps": g,
            "oe": {"observed": int(o.observed), "expected": _r(o.expected, 1), "ratio": _r(o.oe_ratio, 2), "p": _r(o.p_excess), "flag": bool(o.flag)} if o is not None else None,
        })

    # ---- patient review lists (pilot districts only, as in the API) ----
    sc = R["scores"]
    sc = sc[sc.on_review_list & sc.district.isin(pilot)].sort_values("risk", ascending=False)
    review = []
    for r in sc.itertuples():
        a = pk.loc[r.patient_key]
        review.append({"key": r.patient_key, "list": r.list_type, "risk": _r(r.risk, 3), "tier": r.tier, "reasons": r.reasons, "facility": r.facility_id,
                       "district": r.district, "day": int(r.days_since_start), "age": int(a.age), "sex": a.sex, "dr": int(a.drug_resistant), "rank": int(r.rank_in_facility)})

    # ---- gaps (pilot) ----
    gp = gaps[gaps.district.isin(pilot)].head(400)
    gap_rows = [{"type": r.gap_type, "rid": str(r.record_id), "key": r.patient_key, "facility": r.facility_id, "district": r.district, "days": int(r.days_open), "over": int(r.over_by_days), "sev": r.severity, "ref": str(pd.Timestamp(r.reference_date).date())}
                for r in gp.itertuples()]

    # ---- duplicates (masked, as in the API) ----
    ident = ds.identities.set_index("patient_key")
    q = R["queue"].head(80)
    dups = []
    for i, r in enumerate(q.itertuples()):
        a, b = ident.loc[r.key_a], ident.loc[r.key_b]
        dups.append({"id": i + 1, "p": _r(r.probability, 4), "band": r.band, "district": a.district, "matching": r.agreeing_fields.split(",") if r.agreeing_fields else [],
                     "differing": r.disagreeing_fields.split(",") if r.disagreeing_fields else [],
                     "a": {"name": f"{mask(a.first_name)} {mask(a.last_name)}", "village": mask(a.village), "age": int(a.age), "facility": a.facility_id},
                     "b": {"name": f"{mask(b.first_name)} {mask(b.last_name)}", "village": mask(b.village), "age": int(b.age), "facility": b.facility_id}})

    audit = R["audit"]
    audit_q = [x for x in audit["audit_queue"] if x["district"] in pilot][:60]

    cards = {}
    for k, c in R["cards"].items():
        pm = c["performance_holdout"]
        cards[k] = {"model": c["model"], "version": c["version"], "algorithm": c["chosen_algorithm"], "outcome": c["outcome_definition"], "moment": c["scoring_moment"],
                    "intended_use": c["intended_use"], "cohort": c["training_cohort"], "limitations": c["known_limitations"],
                    "baseline_vs_challenger": c["baseline_vs_challenger"], "thresholds": c["tier_thresholds"], "reasons_method": c["reasons_method"],
                    "metrics": {x: pm[x] for x in ["n", "events", "auc", "auc_ci95", "average_precision", "brier", "calibration_slope", "calibration_intercept", "observed_rate",
                                                     "capture_top_5pct", "capture_top_10pct", "capture_top_20pct", "ppv_top_10pct"]},
                    "deciles": pm["decile_calibration"], "subgroups": c["subgroup_performance"], "monitoring": c.get("monitoring_by_month", []),
                    "odds_ratios": {a: round(b, 2) for a, b in sorted(c["odds_ratios"].items(), key=lambda kv: -kv[1])}}

    wide = R["trends_wide"].set_index("month")
    state_monthly = [{"month": m, "notified": int(v)} for m, v in wide.sum(axis=1).items()]

    data = {
        "meta": {"version": R["version"], "as_of": str(ds.as_of.date()), "source": ds.source, "pilot": pilot, "records": int(len(ds.patients)),
                 "facilities": int(len(fac)), "districts": int(len(districts)), "rop_url": "https://nhm.assam.gov.in/sites/default/files/swf_utility_folder/departments/nhm_lipl_in_oid_6/menu/document/district_rop_2024-26_ntep.pdf",
                 "notice": "Decision support only. Scores and flags prompt a review by an authorised person. They do not replace clinical diagnosis or authorised programme decisions."},
        "districts": districts, "facilities": facilities, "review": review, "gaps": gap_rows, "duplicates": dups,
        "gap_totals": {k: int(v) for k, v in gaps.gap_type.value_counts().items()},
        "death_audit": {"timing": audit["timing"], "factors": audit["factors"], "addressable": audit["early_deaths_with_addressable_factor_share"],
                        "addressable2": audit["early_deaths_with_two_or_more_addressable_share"], "queue": audit_q,
                        "flagged_facilities": [f for f in df_records(audit["facility_oe"]) if f["flag"]]},
        "cards": cards, "quality": R["quality"], "dedup_eval": R["dedup_eval"], "facility_validation": R["fac_validation"],
        "state_series": df_records(R["state_series"]), "state_monthly": state_monthly,
        "tier_counts": {k: {t: int(n) for t, n in R["scores"][R["scores"].list_type == k].tier.value_counts().items()} for k in R["scores"].list_type.unique()},
    }
    if include_multiseed:
        data["shrinkage_multiseed"] = shrinkage_multiseed()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(clean(data), separators=(",", ":")), encoding="utf-8")
    return out
