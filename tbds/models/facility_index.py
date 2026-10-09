"""Facility (TU) and district prioritisation for supervision, active case finding and diagnostic deployment.

Two layers, kept separate because their provenance differs:

1. OUTCOME-BASED INDEX (per TU and per district). Rates such as early-death rate or pre-treatment loss are noisy when
   a facility has few cases: one extra death can move a small TU to the top of a naive ranking. We therefore use
   empirical-Bayes (beta-binomial) shrinkage towards the district rate, which in turn is shrunk towards the state
   rate. Facilities with little data are pulled towards their district and carry wide intervals instead of
   dominating the list. The index is a weighted sum of z-scores of the SHRUNK rates, and each facility shows its
   top drivers so a supervisor sees why it ranks where it does.

2. PLANNING-CAPACITY STRAIN (per district). Built only from the published NHM Assam NTEP District RoP 2024-26:
   expected patient load per TU and per TDC, lab tests and house-visit targets per expected patient. These are
   planning targets, not outcomes: they say where workload is high relative to planned capacity.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy import stats

from tbds.config import get_settings
from tbds.pipeline.ingest import Dataset

DRIVER_LABELS = {
    "early_death_rate": "Early deaths", "pre_treatment_loss": "Pre-treatment loss", "diagnosis_to_start_delay": "Slow start of treatment",
    "open_referral_rate": "Unclosed referrals", "missed_follow_up_rate": "Missed follow-up", "supervision_gap": "Long since last supervision",
}


def eb_shrink(x: pd.Series, n: pd.Series, group: pd.Series) -> pd.DataFrame:
    """Beta-binomial shrinkage: facility -> district -> state. Returns raw rate, shrunk rate and an 80% interval."""
    x, n = x.astype(float), n.astype(float)
    ok = n > 0
    state = x[ok].sum() / n[ok].sum()
    rate = (x / n.where(ok)).where(ok)
    noise = (state * (1 - state) / n[ok]).mean()
    tau2 = max(float(rate[ok].var(ddof=1)) - noise, 1e-8)
    k = float(np.clip(state * (1 - state) / tau2 - 1, 8, 400))
    gx, gn = x.groupby(group).transform("sum"), n.groupby(group).transform("sum")
    prior_mean = (gx + k * state) / (gn + k)
    a = x + k * prior_mean
    b = (n - x) + k * (1 - prior_mean)
    post = a / (a + b)
    return pd.DataFrame({"raw": rate.fillna(state), "shrunk": post, "lo": stats.beta.ppf(0.10, a, b), "hi": stats.beta.ppf(0.90, a, b),
                         "n": n, "k": k})


def _facility_metrics(ds: Dataset, exclude: set[str]) -> pd.DataFrame:
    cfg = get_settings()
    p = ds.patients[~ds.patients.patient_key.isin(exclude)].copy()
    as_of = ds.as_of
    window = p[(p.notified_date >= as_of - pd.Timedelta(days=450)) & (p.notified_date <= as_of - pd.Timedelta(days=75))]
    started = window[window.status != "pre_treatment_loss"]
    started_mat = started[(as_of - started.treatment_start_date).dt.days >= cfg.risk_model.early_death_days]
    early = ((started_mat.final_outcome == "died") & ((started_mat.death_date - started_mat.treatment_start_date).dt.days < cfg.risk_model.early_death_days))
    fac = ds.facilities[["facility_id", "facility_name", "district", "last_supervision_date", "supervision_visits_90d"]].copy().set_index("facility_id")

    g = lambda s: s.groupby(window.facility_id if len(s) == len(window) else None)
    out = pd.DataFrame(index=fac.index)
    out["early_death_x"] = early.groupby(started_mat.facility_id).sum()
    out["early_death_n"] = started_mat.groupby("facility_id").size()
    out["pre_tx_x"] = (window.status == "pre_treatment_loss").groupby(window.facility_id).sum()
    out["pre_tx_n"] = window.groupby("facility_id").size()
    out["delay_x"] = (started.diag_to_start_days > 14).groupby(started.facility_id).sum()
    out["delay_n"] = started.groupby("facility_id").size()
    out["median_delay_days"] = started.groupby("facility_id").diag_to_start_days.median()

    r = ds.referrals
    rr = r[(r.referral_date >= as_of - pd.Timedelta(days=450)) & (r.referral_date <= as_of - pd.Timedelta(days=14))]
    out["ref_x"] = rr.closed_date.isna().groupby(rr.facility_id).sum()
    out["ref_n"] = rr.groupby("facility_id").size()

    on = ds.patients[(ds.patients.status == "on_treatment") & ~ds.patients.patient_key.isin(exclude)]
    gap_days = (as_of - on.last_adherence_date).dt.days
    out["fu_x"] = (gap_days > cfg.referral_gaps.missed_follow_up_days).groupby(on.facility_id).sum()
    out["fu_n"] = on.groupby("facility_id").size()

    out = out.fillna(0)
    out["supervision_gap"] = np.minimum((as_of - pd.to_datetime(fac.last_supervision_date)).dt.days / 180.0, 1.0)
    out["district"] = fac.district
    out["facility_name"] = fac.facility_name
    out["supervision_visits_90d"] = fac.supervision_visits_90d
    out["last_supervision_date"] = fac.last_supervision_date
    return out


def facility_index(ds: Dataset, exclude: set[str]) -> tuple[pd.DataFrame, dict]:
    cfg = get_settings().facility_index
    m = _facility_metrics(ds, exclude)
    spec = {"early_death_rate": ("early_death_x", "early_death_n"), "pre_treatment_loss": ("pre_tx_x", "pre_tx_n"),
            "diagnosis_to_start_delay": ("delay_x", "delay_n"), "open_referral_rate": ("ref_x", "ref_n"),
            "missed_follow_up_rate": ("fu_x", "fu_n")}
    res, raw_z, shr_z = {}, {}, {}
    for name, (xc, nc) in spec.items():
        s = eb_shrink(m[xc], m[nc], m.district)
        res[name] = s
        raw_z[name] = (s.raw - s.raw.mean()) / (s.raw.std() or 1)
        shr_z[name] = (s.shrunk - s.shrunk.mean()) / (s.shrunk.std() or 1)
    sup = m.supervision_gap
    raw_z["supervision_gap"] = shr_z["supervision_gap"] = (sup - sup.mean()) / (sup.std() or 1)

    w = cfg.weights
    contrib = pd.DataFrame({k: w[k] * shr_z[k] for k in w})
    idx_shrunk = contrib.sum(axis=1)
    idx_raw = sum(w[k] * raw_z[k] for k in w)
    out = pd.DataFrame({"facility_id": m.index, "facility_name": m.facility_name.values, "district": m.district.values}).set_index("facility_id")
    out["index_score"] = idx_shrunk.rank(pct=True) * 100
    out["index_raw_score"] = pd.Series(idx_raw, index=m.index).rank(pct=True) * 100
    out["priority"] = np.where(out.index_score >= 80, "supervise_first", np.where(out.index_score >= 60, "watch", "routine"))
    for k, s in res.items():
        out[f"{k}"] = s.shrunk.round(4)
        out[f"{k}_raw"] = s.raw.round(4)
        out[f"{k}_lo"] = s.lo.round(4)
        out[f"{k}_hi"] = s.hi.round(4)
    out["supervision_gap"] = sup.round(3)
    out["median_delay_days"] = m.median_delay_days
    out["cases_evaluated"] = m.early_death_n.astype(int)
    out["on_treatment_now"] = m.fu_n.astype(int)
    out["low_data"] = out.cases_evaluated < cfg.min_cases_for_stable_rate
    out["last_supervision_date"] = m.last_supervision_date
    out["supervision_visits_90d"] = m.supervision_visits_90d
    drivers = []
    for fid in out.index:
        top = contrib.loc[fid].sort_values(ascending=False)
        drivers.append([DRIVER_LABELS[k] for k, v in top.items() if v > 0.15][:2])
    out["drivers"] = drivers
    out["contrib"] = contrib.round(3).to_dict(orient="index").values()

    validation = {}
    if ds.truth_facility_effect is not None and "true_early_death_prob" in ds.truth_facility_effect:
        validation = validate_early_death_estimates(m, ds.truth_facility_effect)
    return out.reset_index(), validation


def district_outcomes(ds: Dataset, exclude: set[str]) -> pd.DataFrame:
    """District-level shrunk rates (district pooled counts shrunk towards the state)."""
    m = _facility_metrics(ds, exclude)
    d = m.groupby("district")[["early_death_x", "early_death_n", "pre_tx_x", "pre_tx_n", "delay_x", "delay_n", "ref_x", "ref_n", "fu_x", "fu_n"]].sum()
    grp = pd.Series("state", index=d.index)
    out = pd.DataFrame(index=d.index)
    for name, (xc, nc) in {"early_death_rate": ("early_death_x", "early_death_n"), "pre_treatment_loss": ("pre_tx_x", "pre_tx_n"),
                           "diagnosis_to_start_delay": ("delay_x", "delay_n"), "open_referral_rate": ("ref_x", "ref_n"),
                           "missed_follow_up_rate": ("fu_x", "fu_n")}.items():
        s = eb_shrink(d[xc], d[nc], grp)
        out[name], out[name + "_raw"], out[name + "_lo"], out[name + "_hi"] = s.shrunk.round(4), s.raw.round(4), s.lo.round(4), s.hi.round(4)
    out["cases_evaluated"] = d.early_death_n.astype(int)
    out["on_treatment_now"] = d.fu_n.astype(int)
    out["supervision_gap"] = m.groupby("district").supervision_gap.mean().round(3)
    w = get_settings().facility_index.weights
    z = lambda s: (s - s.mean()) / (s.std() or 1)
    comp = sum(w[k] * z(out[k]) for k in w if k != "supervision_gap") + w["supervision_gap"] * z(out.supervision_gap)
    out["outcome_index"] = comp.rank(pct=True) * 100
    return out.reset_index()


def planning_strain(districts: pd.DataFrame) -> pd.DataFrame:
    """District planning-capacity strain from the REAL NHM Assam RoP 2024-26 table (planning targets, not outcomes)."""
    d = districts.copy()
    d["expected_patients"] = d.npy_ds_target + d.npy_dr_target
    d["patients_per_tu"] = d.expected_patients / d.tu_count
    d["patients_per_tdc"] = d.expected_patients / d.tdc_count
    d["lab_tests_per_patient"] = d.lab_tests_target / d.expected_patients
    d["acf_visits_per_patient"] = d.acf_house_visit_target / d.expected_patients
    d["dr_share"] = d.npy_dr_target / d.expected_patients
    d["private_target_share"] = d.ppsa_notification_target / (d.expected_patients)
    z = lambda s: (s - s.mean()) / s.std(ddof=0)
    strain = (z(d.patients_per_tu) + z(d.patients_per_tdc)) / 2 - (z(d.lab_tests_per_patient) + z(d.acf_visits_per_patient)) / 2
    d["planning_strain_score"] = strain.rank(pct=True) * 100
    d["planning_tier"] = np.where(d.planning_strain_score >= 75, "highest_strain", np.where(d.planning_strain_score >= 50, "elevated", "lower"))
    return d


def validate_early_death_estimates(m: pd.DataFrame, truth: pd.DataFrame) -> dict:
    """Synthetic data only. Compare naive and shrunk early-death rates with each facility's TRUE early-death probability."""
    t = truth.set_index("facility_id").true_early_death_prob.reindex(m.index)
    e = eb_shrink(m.early_death_x, m.early_death_n, m.district)
    raw, shr = e.raw.reindex(m.index), e.shrunk.reindex(m.index)
    small = m.early_death_n < 50
    top = set(t.sort_values(ascending=False).head(20).index)
    hit = lambda v: len(top & set(v.sort_values(ascending=False).head(20).index)) / 20
    return {
        "note": "Synthetic data only: estimates are compared with the facility's true early-death probability used to generate the data.",
        "mse_naive": float(((raw - t) ** 2).mean()), "mse_shrunk": float(((shr - t) ** 2).mean()),
        "mse_naive_small_facilities": float(((raw - t)[small] ** 2).mean()) if small.any() else None,
        "mse_shrunk_small_facilities": float(((shr - t)[small] ** 2).mean()) if small.any() else None,
        "small_facilities_under_50_cases": int(small.sum()),
        "spearman_naive": float(stats.spearmanr(raw, t).statistic), "spearman_shrunk": float(stats.spearmanr(shr, t).statistic),
        "top20_recall_naive": hit(raw), "top20_recall_shrunk": hit(shr),
    }
