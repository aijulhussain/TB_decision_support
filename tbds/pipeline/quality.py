"""Data-quality report. Run at every refresh; its output is shown to programme managers next to the scores,
because a score built on bad data should look different from one built on good data."""
from __future__ import annotations

import numpy as np
import pandas as pd

from tbds.pipeline.ingest import Dataset

KEY_FIELDS = ["age", "sex", "bmi", "hiv_positive", "diabetes", "bact_confirmed", "treatment_start_date", "diag_to_start_days"]


def quality_report(ds: Dataset) -> dict:
    p = ds.patients
    n = len(p)
    started = p[p.status != "pre_treatment_loss"]
    miss = {c: float(p[c].isna().mean()) for c in KEY_FIELDS}
    miss["treatment_start_date"] = float(started.treatment_start_date.isna().mean())  # expected missing only for pre-treatment loss
    rules = {
        "age_outside_0_100": int(((p.age < 0) | (p.age > 100)).sum()),
        "bmi_implausible_lt10_or_gt50": int(((p.bmi < 10) | (p.bmi > 50)).sum()),
        "treatment_start_before_diagnosis": int((started.treatment_start_date < started.diagnosis_date).sum()),
        "death_before_treatment_start": int((p.death_date < p.treatment_start_date).sum()),
        "notification_in_future": int((p.notified_date > ds.as_of).sum()),
        "diag_to_start_negative": int((p.diag_to_start_days < 0).sum()),
    }
    # late data entry: gap between diagnosis and notification
    lag = (p.notified_date - p.diagnosis_date).dt.days
    # per-facility completeness (share of key fields present) and volume
    comp = p.groupby("facility_id").apply(
        lambda g: pd.Series({"n": len(g), "completeness": 1 - g[["bmi", "hiv_positive", "diabetes", "bact_confirmed"]].isna().mean().mean()}),
        include_groups=False,
    )
    low = comp[(comp.completeness < 0.9) | (comp.n < 20)]
    return {
        "records": int(n),
        "as_of": str(ds.as_of.date()),
        "missingness": {k: round(v, 4) for k, v in miss.items()},
        "rule_violations": rules,
        "notification_lag_days": {"median": float(lag.median()), "p90": float(lag.quantile(0.9))},
        "facilities_low_quality": [{"facility_id": i, "n": int(r.n), "completeness": round(float(r.completeness), 3)} for i, r in low.iterrows()],
        "share_records_usable_for_risk_model": float(((p.bmi.notna()) & (p.age.between(0, 100)) & p.hiv_positive.notna()).mean()),
    }
