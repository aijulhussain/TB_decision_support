"""Death-audit analytics: where and why do deaths cluster, and which deaths merit a structured review?

Descriptive and explicitly non-causal. Outputs:
* timing: how soon after starting treatment people die (very early deaths point to late presentation or diagnosis)
* factor prevalence among deaths versus all started patients (rate ratio with 95% interval)
* observed vs expected early deaths per facility, where expected comes from the validated M1 risk model, so a facility is
  not flagged merely for treating older or sicker patients
* an audit queue of recent deaths with the factors that were present
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy import stats

from tbds.config import get_settings
from tbds.pipeline.ingest import Dataset

FACTORS = {
    "Severe undernutrition (BMI < 16)": lambda d: (d.bmi.between(10, 15.99)) & (d.age >= 15),
    "HIV positive": lambda d: d.hiv_positive == 1,
    "HIV status not recorded": lambda d: d.hiv_positive.isna(),
    "Age 60 or older": lambda d: d.age >= 60,
    "Drug-resistant TB": lambda d: d.drug_resistant == 1,
    "Treatment started more than 14 days after diagnosis": lambda d: d.diag_to_start_days > 14,
    "No Nikshay Poshan enrolment by day 15": lambda d: d.npy_enrolled_by_day15.astype(float) == 0,
    "Not bacteriologically confirmed": lambda d: d.bact_confirmed == 0,
    "Diabetes": lambda d: d.diabetes == 1,
}
SYSTEM_FACTORS = ["Treatment started more than 14 days after diagnosis", "No Nikshay Poshan enrolment by day 15", "HIV status not recorded"]


def _rr(a_x, a_n, b_x, b_n):
    """Rate ratio with Wald 95% interval on the log scale (0.5 continuity correction)."""
    a_x, b_x = a_x + 0.5, b_x + 0.5
    rr = (a_x / (a_n + 1)) / (b_x / (b_n + 1))
    se = np.sqrt(1 / a_x + 1 / b_x - 1 / (a_n + 1) - 1 / (b_n + 1))
    return float(rr), float(np.exp(np.log(rr) - 1.96 * se)), float(np.exp(np.log(rr) + 1.96 * se))


def analyse(ds: Dataset, exclude: set[str], cohort_scores: pd.DataFrame) -> dict:
    cfg = get_settings()
    early_days = cfg.risk_model.early_death_days
    p = ds.patients[~ds.patients.patient_key.isin(exclude) & (ds.patients.status != "pre_treatment_loss")].copy()
    deaths = p[(p.final_outcome == "died") & p.death_date.notna()].copy()
    deaths["days_to_death"] = (deaths.death_date - deaths.treatment_start_date).dt.days
    deaths["early"] = deaths.days_to_death < early_days
    n_started = len(p)

    timing = {
        "deaths": int(len(deaths)), "share_of_started": float(len(deaths) / n_started),
        "early_deaths": int(deaths.early.sum()), "share_early": float(deaths.early.mean()),
        "median_days_to_death": float(deaths.days_to_death.median()),
        "within_14_days": int((deaths.days_to_death <= 14).sum()), "within_14_days_share": float((deaths.days_to_death <= 14).mean()),
        "histogram": [{"bin": f"{a}-{b - 1}", "deaths": int(((deaths.days_to_death >= a) & (deaths.days_to_death < b)).sum())}
                      for a, b in [(0, 8), (8, 15), (15, 30), (30, 60), (60, 120), (120, 400)]],
    }

    matured = p[(ds.as_of - p.treatment_start_date).dt.days >= early_days]
    early_d = deaths[deaths.early]
    factor_rows = []
    for name, fn in FACTORS.items():
        in_deaths = fn(early_d).fillna(False)
        in_all = fn(matured).fillna(False)
        rr, lo, hi = _rr(int(in_deaths.sum()), len(early_d), int(in_all.sum()), len(matured))
        factor_rows.append({"factor": name, "share_of_early_deaths": float(in_deaths.mean()), "share_of_all_started": float(in_all.mean()),
                            "ratio": rr, "ratio_lo": lo, "ratio_hi": hi})
    factor_rows.sort(key=lambda r: -r["ratio"])

    cs = cohort_scores.copy()
    f = cs.groupby("facility_id").agg(observed=("y", "sum"), expected=("risk", "sum"), n=("y", "size"), district=("district", "first")).reset_index()
    f["oe_ratio"] = f.observed / f.expected
    # exact Poisson tail: probability of seeing at least this many deaths if the model's expected count were true
    f["p_excess"] = [float(stats.poisson.sf(o - 1, e)) if e > 0 else 1.0 for o, e in zip(f.observed, f.expected)]
    f["flag"] = (f.oe_ratio >= 1.5) & (f.p_excess < 0.10)
    f["expected"] = f.expected.round(2)
    f["oe_ratio"] = f.oe_ratio.round(2)
    f["p_excess"] = f.p_excess.round(4)

    recent = deaths[deaths.death_date >= ds.as_of - pd.Timedelta(days=90)].copy()
    queue_rows = []
    for _, r in recent.sort_values("death_date", ascending=False).iterrows():
        present = [name for name, fn in FACTORS.items() if bool(fn(r.to_frame().T.infer_objects()).iloc[0])]
        queue_rows.append({"patient_key": r.patient_key, "facility_id": r.facility_id, "district": r.district, "death_date": str(r.death_date.date()),
                           "days_after_start": int(r.days_to_death), "age": int(r.age), "sex": r.sex, "factors": present,
                           "addressable_factors": [x for x in present if x in SYSTEM_FACTORS],
                           "audit_priority": "high" if (r.days_to_death < 15 or len([x for x in present if x in SYSTEM_FACTORS]) >= 2) else "standard"})
    sysf = np.zeros(len(early_d), dtype=int)
    for s in SYSTEM_FACTORS:
        sysf += FACTORS[s](early_d).fillna(False).astype(int).values
    return {"timing": timing, "factors": factor_rows, "facility_oe": f, "audit_queue": queue_rows,
            "early_deaths_with_addressable_factor_share": float((sysf >= 1).mean()) if len(early_d) else None,
            "early_deaths_with_two_or_more_addressable_share": float((sysf >= 2).mean()) if len(early_d) else None}
