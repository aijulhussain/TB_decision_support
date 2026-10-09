"""Referral-loop and follow-up gaps: rule-based on purpose (easy to explain, easy to audit).

G1 tested_not_notified   positive lab result with no notification
G2 notified_not_started  notified, no treatment start recorded
G3 referral_not_closed   referral issued, arrival at the destination facility not recorded
G4 missed_follow_up      on treatment, no adherence mark recently

Each gap opens when the age of the event passes its threshold and stops being a "current" gap after a look-back limit
(older ones are counted as historical losses in the facility index, not chased as live work).
"""
from __future__ import annotations

import pandas as pd

from tbds.config import get_settings
from tbds.pipeline.ingest import Dataset

GAP_LABELS = {
    "tested_not_notified": "Tested positive, not notified", "notified_not_started": "Notified, treatment not started",
    "referral_not_closed": "Referral not closed", "missed_follow_up": "Missed follow-up",
}
LOOKBACK = {"tested_not_notified": 60, "notified_not_started": 90, "referral_not_closed": 90, "missed_follow_up": 60}


def find_gaps(ds: Dataset, exclude: set[str]) -> pd.DataFrame:
    cfg = get_settings().referral_gaps
    as_of = ds.as_of
    fac_dist = ds.facilities.set_index("facility_id").district
    rows = []

    lab = ds.lab_results
    g1 = lab[(lab.notified == 0) & (lab.result == "positive")].copy()
    g1["age"] = (as_of - g1.test_date).dt.days
    g1 = g1[(g1.age >= cfg.tested_not_notified_days) & (g1.age <= LOOKBACK["tested_not_notified"])]
    rows.append(pd.DataFrame({"gap_type": "tested_not_notified", "patient_key": None, "facility_id": g1.facility_id, "reference_date": g1.test_date,
                              "days_open": g1.age, "threshold": cfg.tested_not_notified_days, "record_id": g1.lab_result_id}))

    p = ds.patients[~ds.patients.patient_key.isin(exclude)]
    g2 = p[(p.treatment_start_date.isna()) & (p.status == "pre_treatment_loss")].copy()
    g2["age"] = (as_of - g2.notified_date).dt.days
    g2 = g2[(g2.age >= cfg.notified_not_started_days) & (g2.age <= LOOKBACK["notified_not_started"])]
    rows.append(pd.DataFrame({"gap_type": "notified_not_started", "patient_key": g2.patient_key, "facility_id": g2.facility_id, "reference_date": g2.notified_date,
                              "days_open": g2.age, "threshold": cfg.notified_not_started_days, "record_id": g2.patient_key}))

    r = ds.referrals
    g3 = r[r.closed_date.isna()].copy()
    g3["age"] = (as_of - g3.referral_date).dt.days
    g3 = g3[(g3.age >= cfg.referral_not_closed_days) & (g3.age <= LOOKBACK["referral_not_closed"])]
    g3 = g3[~g3.patient_key.isin(exclude)]
    rows.append(pd.DataFrame({"gap_type": "referral_not_closed", "patient_key": g3.patient_key, "facility_id": g3.facility_id, "reference_date": g3.referral_date,
                              "days_open": g3.age, "threshold": cfg.referral_not_closed_days, "record_id": g3.referral_id}))

    g4 = p[p.status == "on_treatment"].copy()
    g4["age"] = (as_of - g4.last_adherence_date).dt.days
    g4 = g4[(g4.age > cfg.missed_follow_up_days) & (g4.age <= LOOKBACK["missed_follow_up"])]
    rows.append(pd.DataFrame({"gap_type": "missed_follow_up", "patient_key": g4.patient_key, "facility_id": g4.facility_id, "reference_date": g4.last_adherence_date,
                              "days_open": g4.age, "threshold": cfg.missed_follow_up_days, "record_id": g4.patient_key}))

    gaps = pd.concat(rows, ignore_index=True)
    gaps["district"] = gaps.facility_id.map(fac_dist)
    gaps["over_by_days"] = (gaps.days_open - gaps.threshold).clip(lower=0).astype(int)
    gaps["severity"] = pd.cut(gaps.over_by_days, [-1, 7, 21, 10_000], labels=["moderate", "high", "severe"]).astype(str)
    gaps["days_open"] = gaps.days_open.astype(int)
    gaps["label"] = gaps.gap_type.map(GAP_LABELS)
    return gaps.sort_values(["over_by_days"], ascending=False).reset_index(drop=True)


def summarise(gaps: pd.DataFrame, ds: Dataset) -> dict:
    by_type = gaps.groupby("gap_type").agg(open=("record_id", "size"), median_days_open=("days_open", "median"), severe=("severity", lambda s: int((s == "severe").sum()))).reset_index()
    by_fac = gaps.pivot_table(index="facility_id", columns="gap_type", values="record_id", aggfunc="size", fill_value=0).reset_index()
    by_dist = gaps.pivot_table(index="district", columns="gap_type", values="record_id", aggfunc="size", fill_value=0).reset_index()
    return {"by_type": by_type.to_dict(orient="records"), "by_facility": by_fac, "by_district": by_dist}
