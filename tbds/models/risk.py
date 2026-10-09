"""Patient risk stratification (decision support only).

Two outcomes, each with its own scoring moment so that nothing known only later leaks into the score:

  M1  early death   death within `early_death_days` of treatment start. Scored at treatment start, baseline data only.
  M2  unfavourable  death, loss to follow-up or failure. Scored at day 30, baseline data plus first-month signals
                    (missed doses, Nikshay Poshan enrolment by day 15).

Primary model: L2-regularised logistic regression on clinically meaningful bands (age, BMI, delay, adherence). It is
transparent: each factor has an odds ratio and a patient's reasons are the risk-raising factors that apply to them.
Challenger: gradient boosting with raw continuous inputs. It replaces the baseline only if it beats it on the
hold-out by at least `gbm_material_auc_gain`; otherwise the simpler model stays (config: risk_model).

Validation is time-ordered (train on earlier starts, test on the latest 30%), reports discrimination AND calibration,
the share of events captured in the top tiers at list sizes a district can review, and subgroup performance.
Scores prompt a REVIEW by an authorised person. They never trigger treatment or programme decisions.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score

from tbds.config import ROOT, get_settings

UNFAVOURABLE = ["died", "lost_to_follow_up", "treatment_failed"]

BASE_FEATURES = [
    "age_lt15", "age_60_74", "age_75p", "male", "bmi_lt16", "bmi_16_185", "bmi_missing", "hiv_pos", "hiv_unknown",
    "diabetes", "diabetes_unknown", "drug_resistant", "extrapulmonary", "not_bact_confirmed", "bact_unknown", "prior_tb",
    "alcohol", "tobacco", "migrant", "tribal", "tea_garden", "private_sector", "hard_to_reach_district",
    "delay_8_14", "delay_15_30", "delay_gt30",
]
DAY30_FEATURES = ["no_npy15", "missed_1_3", "missed_4_7", "missed_8p"]
CONTINUOUS = ["age", "bmi_clean", "delay_days"]
CONTINUOUS_DAY30 = ["missed_doses"]

REASON_TEXT = {
    "age_60_74": "Age 60 to 74", "age_75p": "Age 75 or older", "male": "Male sex",
    "bmi_lt16": "Severe undernutrition (BMI below 16)", "bmi_16_185": "Undernutrition (BMI 16 to 18.5)",
    "hiv_pos": "HIV positive", "hiv_unknown": "HIV status not recorded", "diabetes": "Diabetes",
    "diabetes_unknown": "Diabetes status not recorded", "drug_resistant": "Drug-resistant TB",
    "extrapulmonary": "Extrapulmonary TB", "not_bact_confirmed": "Not bacteriologically confirmed",
    "bact_unknown": "Bacteriological status not recorded", "prior_tb": "Previous TB treatment",
    "alcohol": "Alcohol use recorded", "tobacco": "Tobacco use recorded", "migrant": "Migrant worker",
    "tea_garden": "Tea-garden resident", "tribal": "Tribal community", "private_sector": "Notified by private sector",
    "hard_to_reach_district": "Hard-to-reach district", "delay_8_14": "Treatment started 8 to 14 days after diagnosis",
    "delay_15_30": "Treatment started 15 to 30 days after diagnosis", "delay_gt30": "Treatment started over 30 days after diagnosis",
    "no_npy15": "No Nikshay Poshan enrolment by day 15", "missed_1_3": "1 to 3 doses missed in first month",
    "missed_4_7": "4 to 7 doses missed in first month", "missed_8p": "8 or more doses missed in first month",
}


def build_features(p: pd.DataFrame, districts: pd.DataFrame) -> pd.DataFrame:
    """Band features. Uses ONLY information available at the scoring moment (see module docstring)."""
    hard = districts.set_index("district")[["hill_district", "tribal_action_plan"]].max(axis=1)
    bmi = p.bmi.where(p.bmi.between(10, 50))
    delay = p.diag_to_start_days
    X = pd.DataFrame(index=p.index)
    X["age_lt15"] = (p.age < 15).astype(int)
    X["age_60_74"] = p.age.between(60, 74).astype(int)
    X["age_75p"] = (p.age >= 75).astype(int)
    X["male"] = (p.sex == "M").astype(int)
    adult = p.age >= 15
    X["bmi_lt16"] = ((bmi < 16) & adult).astype(int)
    X["bmi_16_185"] = ((bmi >= 16) & (bmi < 18.5) & adult).astype(int)
    X["bmi_missing"] = bmi.isna().astype(int)
    X["hiv_pos"] = (p.hiv_positive == 1).astype(int)
    X["hiv_unknown"] = p.hiv_positive.isna().astype(int)
    X["diabetes"] = (p.diabetes == 1).astype(int)
    X["diabetes_unknown"] = p.diabetes.isna().astype(int)
    X["drug_resistant"] = (p.drug_resistant == 1).astype(int)
    X["extrapulmonary"] = (p.extrapulmonary == 1).astype(int)
    X["not_bact_confirmed"] = (p.bact_confirmed == 0).astype(int)
    X["bact_unknown"] = p.bact_confirmed.isna().astype(int)
    X["prior_tb"] = (p.prior_tb == 1).astype(int)
    for c in ["alcohol_use", "tobacco_use", "migrant", "tribal", "tea_garden", "private_sector"]:
        X[{"alcohol_use": "alcohol", "tobacco_use": "tobacco"}.get(c, c)] = (p[c].astype(float) == 1).astype(int)
    X["hard_to_reach_district"] = p.district.map(hard).fillna(0).astype(int)
    X["delay_8_14"] = delay.between(8, 14).astype(int)
    X["delay_15_30"] = delay.between(15, 30).astype(int)
    X["delay_gt30"] = (delay > 30).astype(int)
    # day-30 signals
    m = p.missed_doses_first30d.astype(float)
    X["no_npy15"] = (p.npy_enrolled_by_day15.astype(float) == 0).astype(int)
    X["missed_1_3"] = m.between(1, 3).astype(int)
    X["missed_4_7"] = m.between(4, 7).astype(int)
    X["missed_8p"] = (m >= 8).astype(int)
    # continuous inputs for the challenger only
    X["age"] = p.age.astype(float)
    X["bmi_clean"] = bmi.fillna(bmi.median())
    X["delay_days"] = delay.fillna(delay.median())
    X["missed_doses"] = m.fillna(0)
    return X


@dataclass
class ModelSpec:
    name: str
    features: list[str]
    gbm_features: list[str]
    outcome: str


M1 = ModelSpec("early_death", BASE_FEATURES, BASE_FEATURES + CONTINUOUS, "early_death")
M2 = ModelSpec("unfavourable_outcome", BASE_FEATURES + DAY30_FEATURES, BASE_FEATURES + DAY30_FEATURES + CONTINUOUS + CONTINUOUS_DAY30, "unfavourable")


def add_labels(p: pd.DataFrame, as_of: pd.Timestamp, cfg=None) -> pd.DataFrame:
    cfg = cfg or get_settings().risk_model
    out = p.copy()
    start = out.treatment_start_date
    out["days_since_start"] = (as_of - start).dt.days
    died_early = (out.final_outcome == "died") & ((out.death_date - start).dt.days < cfg.early_death_days)
    out["early_death"] = died_early.astype(int)
    out["early_label_ready"] = start.notna() & (out.days_since_start >= cfg.early_death_days)
    maturity = np.where(out.drug_resistant == 1, 365, 190) + 5
    out["unfavourable"] = out.final_outcome.isin(UNFAVOURABLE).astype(int)
    out["unfav_label_ready"] = start.notna() & (out.days_since_start >= maturity)
    return out


def _calib(y: np.ndarray, p: np.ndarray) -> dict:
    p = np.clip(p, 1e-6, 1 - 1e-6)
    lg = np.log(p / (1 - p)).reshape(-1, 1)
    lr = LogisticRegression(C=1e6, max_iter=500).fit(lg, y)
    return {"calibration_slope": float(lr.coef_[0][0]), "calibration_intercept": float(lr.intercept_[0]),
            "observed_rate": float(y.mean()), "mean_predicted": float(p.mean())}


def metrics(y: np.ndarray, p: np.ndarray, seed: int = 11) -> dict:
    rng = np.random.default_rng(seed)
    out = {"n": int(len(y)), "events": int(y.sum()), "auc": float(roc_auc_score(y, p)),
           "average_precision": float(average_precision_score(y, p)), "brier": float(brier_score_loss(y, p))}
    boots = []
    for _ in range(200):
        i = rng.integers(0, len(y), len(y))
        if y[i].min() != y[i].max():
            boots.append(roc_auc_score(y[i], p[i]))
    out["auc_ci95"] = [float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))]
    out.update(_calib(y, p))
    order = np.argsort(-p)
    for frac in (0.05, 0.10, 0.20):
        k = max(1, int(len(y) * frac))
        out[f"capture_top_{int(frac * 100)}pct"] = float(y[order[:k]].sum() / max(1, y.sum()))
        out[f"ppv_top_{int(frac * 100)}pct"] = float(y[order[:k]].mean())
    # calibration by decile
    q = pd.qcut(pd.Series(p).rank(method="first"), 10, labels=False)
    out["decile_calibration"] = [
        {"decile": int(d) + 1, "mean_predicted": float(p[q == d].mean()), "observed": float(y[q == d].mean()), "n": int((q == d).sum())}
        for d in range(10)
    ]
    return out


def subgroup_table(X: pd.DataFrame, meta: pd.DataFrame, y: np.ndarray, p: np.ndarray, overall_auc: float) -> list[dict]:
    rows = []
    groups = {
        "sex": meta.sex.map({"M": "Male", "F": "Female"}),
        "age_band": pd.cut(meta.age, [-1, 14, 44, 59, 200], labels=["0-14", "15-44", "45-59", "60+"]).astype(str),
        "tribal_community": meta.tribal.map({1: "Tribal", 0: "Non-tribal"}),
        "tea_garden": meta.tea_garden.map({1: "Tea-garden", 0: "Other"}),
        "terrain": X.hard_to_reach_district.map({1: "Hill / tribal-plan district", 0: "Plains district"}),
        "sector": meta.private_sector.map({1: "Private notification", 0: "Public notification"}),
    }
    for g, ser in groups.items():
        for level in sorted(ser.dropna().unique()):
            m = (ser == level).values
            yy, pp = y[m], p[m]
            if len(yy) < 100 or yy.sum() < 8:
                continue
            auc = roc_auc_score(yy, pp) if yy.min() != yy.max() else float("nan")
            oe = float(yy.sum() / max(1e-9, pp.sum()))
            rows.append({"group": g, "level": level, "n": int(len(yy)), "events": int(yy.sum()), "auc": float(auc),
                         "observed_over_expected": oe,
                         "flag": bool((auc < overall_auc - 0.05) or not (0.7 <= oe <= 1.4))})
    return rows


def time_split(df: pd.DataFrame, frac_test: float) -> tuple[pd.Index, pd.Index]:
    order = df.sort_values("treatment_start_date").index
    cut = int(len(order) * (1 - frac_test))
    return order[:cut], order[cut:]


def _lr() -> LogisticRegression:
    return LogisticRegression(C=0.5, max_iter=2000)


def _gbm() -> HistGradientBoostingClassifier:
    return HistGradientBoostingClassifier(max_depth=3, learning_rate=0.06, max_iter=250, l2_regularization=1.0, random_state=3)


def reasons_for(coefs: pd.Series, row: pd.Series, k: int = 3) -> list[dict]:
    active = [(f, c) for f, c in coefs.items() if f in REASON_TEXT and row.get(f, 0) == 1 and c > 0.15]
    active.sort(key=lambda t: -t[1])
    return [{"factor": REASON_TEXT[f], "odds_ratio": round(float(np.exp(c)), 2)} for f, c in active[:k]]


def train_and_evaluate(spec: ModelSpec, p: pd.DataFrame, districts: pd.DataFrame, as_of: pd.Timestamp, exclude_keys: set[str]) -> dict:
    cfg = get_settings().risk_model
    p = add_labels(p, as_of)
    ready = {"early_death": "early_label_ready", "unfavourable": "unfav_label_ready"}[spec.outcome]
    cohort = p[p[ready] & ~p.patient_key.isin(exclude_keys) & (p.status != "pre_treatment_loss")].copy()
    X = build_features(cohort, districts)
    y = cohort[spec.outcome].values
    tr, te = time_split(cohort, cfg.test_fraction)
    lr = _lr().fit(X.loc[tr, spec.features], y[cohort.index.get_indexer(tr)])
    gb = _gbm().fit(X.loc[tr, spec.gbm_features], y[cohort.index.get_indexer(tr)])
    yte = y[cohort.index.get_indexer(te)]
    p_lr = lr.predict_proba(X.loc[te, spec.features])[:, 1]
    p_gb = gb.predict_proba(X.loc[te, spec.gbm_features])[:, 1]
    m_lr, m_gb = metrics(yte, p_lr), metrics(yte, p_gb)
    choose_gbm = (m_gb["auc"] - m_lr["auc"]) >= cfg.gbm_material_auc_gain
    chosen = "gradient_boosting" if choose_gbm else "logistic_regression"
    pchosen = p_gb if choose_gbm else p_lr
    sub = subgroup_table(X.loc[te], cohort.loc[te], yte, pchosen, (m_gb if choose_gbm else m_lr)["auc"])
    coefs = pd.Series(lr.coef_[0], index=spec.features)
    return {
        "spec": spec, "cohort_n": len(cohort), "train_n": len(tr), "test_n": len(te),
        "train_window": [str(cohort.loc[tr, "treatment_start_date"].min().date()), str(cohort.loc[tr, "treatment_start_date"].max().date())],
        "test_window": [str(cohort.loc[te, "treatment_start_date"].min().date()), str(cohort.loc[te, "treatment_start_date"].max().date())],
        "baseline_metrics": m_lr, "challenger_metrics": m_gb, "chosen": chosen,
        "chosen_metrics": m_gb if choose_gbm else m_lr, "subgroups": sub,
        "odds_ratios": {f: float(np.exp(c)) for f, c in coefs.items()},
        "_cohort": cohort, "_X": X, "_y": y,
    }


def fit_final(spec: ModelSpec, ev: dict, p_all: pd.DataFrame, districts: pd.DataFrame, as_of: pd.Timestamp) -> dict:
    """Refit the chosen model on the whole labelled cohort and score currently active patients."""
    cfg = get_settings().risk_model
    X, y = ev["_X"], ev["_y"]
    lr = _lr().fit(X[spec.features], y)
    gb = _gbm().fit(X[spec.gbm_features], y) if ev["chosen"] == "gradient_boosting" else None
    coefs = pd.Series(lr.coef_[0], index=spec.features)
    pred = (gb.predict_proba(X[spec.gbm_features])[:, 1] if gb is not None else lr.predict_proba(X[spec.features])[:, 1])
    thr = {"high": float(np.quantile(pred, cfg.tier_quantiles["high"])), "medium": float(np.quantile(pred, cfg.tier_quantiles["medium"]))}

    live = add_labels(p_all, as_of)
    if spec.outcome == "early_death":
        live = live[(live.status == "on_treatment") & live.days_since_start.between(0, cfg.early_death_days - 1)]
    else:
        live = live[(live.status == "on_treatment") & live.days_since_start.between(30, 150)]
    Xl = build_features(live, districts)
    pl = (gb.predict_proba(Xl[spec.gbm_features])[:, 1] if gb is not None else lr.predict_proba(Xl[spec.features])[:, 1])
    tier = np.where(pl >= thr["high"], "high", np.where(pl >= thr["medium"], "medium", "standard"))
    scores = pd.DataFrame({
        "patient_key": live.patient_key.values, "list_type": spec.name, "risk": pl, "tier": tier,
        "facility_id": live.facility_id.values, "district": live.district.values,
        "days_since_start": live.days_since_start.values, "treatment_start_date": live.treatment_start_date.values,
    })
    # reasons come from the transparent model's odds ratios; for a challenger they are an approximation and labelled as such
    scores["reasons"] = [reasons_for(coefs, Xl.iloc[i]) for i in range(len(Xl))]
    scores["reasons_source"] = "logistic_odds_ratios"
    scores = cap_review_lists(scores, cfg.review_capacity_per_facility)
    cohort = ev["_cohort"]
    cohort_scores = pd.DataFrame({"patient_key": cohort.patient_key.values, "facility_id": cohort.facility_id.values,
                                  "district": cohort.district.values, "y": y, "risk": pred,
                                  "start": cohort.treatment_start_date.values})
    model = {"lr": lr, "gbm": gb, "spec": spec.name, "features": spec.features, "thresholds": thr, "chosen": ev["chosen"]}
    return {"scores": scores, "model": model, "thresholds": thr, "coefs": coefs, "cohort_scores": cohort_scores}


def cap_review_lists(scores: pd.DataFrame, cap: int) -> pd.DataFrame:
    """Review lists are capped per facility so a list stays actionable (limits alert fatigue)."""
    s = scores.copy()
    s["rank_in_facility"] = s.groupby(["facility_id", "list_type"]).risk.rank(ascending=False, method="first").astype(int)
    s["on_review_list"] = (s.tier != "standard") & (s.rank_in_facility <= cap)
    return s


def model_card(ev: dict, final: dict, version: str, as_of: pd.Timestamp) -> dict:
    spec: ModelSpec = ev["spec"]
    cm = ev["chosen_metrics"]
    return {
        "model": spec.name, "version": version, "trained_as_of": str(as_of.date()), "chosen_algorithm": ev["chosen"],
        "intended_use": "Decision support: prompts review by an authorised programme or clinical user. Not a diagnosis, and never an automatic trigger for treatment or programme decisions.",
        "outcome_definition": ("Death within %d days of treatment start" % get_settings().risk_model.early_death_days) if spec.outcome == "early_death"
        else "Death, loss to follow-up or treatment failure",
        "scoring_moment": "Treatment start (baseline data only)" if spec.outcome == "early_death" else "Day 30 (baseline plus first-month signals)",
        "training_cohort": {"n": ev["cohort_n"], "train_n": ev["train_n"], "test_n": ev["test_n"],
                            "train_window": ev["train_window"], "test_window": ev["test_window"], "split": "time-ordered hold-out"},
        "performance_holdout": {k: v for k, v in cm.items()},
        "baseline_vs_challenger": {"logistic_auc": ev["baseline_metrics"]["auc"], "gbm_auc": ev["challenger_metrics"]["auc"],
                                   "required_gain": get_settings().risk_model.gbm_material_auc_gain},
        "subgroup_performance": ev["subgroups"],
        "odds_ratios": ev["odds_ratios"],
        "tier_thresholds": final["thresholds"],
        "known_limitations": [
            "Trained on synthetic data in this repository. Performance figures describe the pipeline, not real patients.",
            "Associations are not causes. Reasons shown are factors the model links with higher risk.",
            "Missing HIV, BMI or diabetes data lowers accuracy; missing values are shown as their own reasons.",
            "Performance must be re-validated on the pilot districts' own retrospective data before live use.",
        ],
        "reasons_method": "Odds ratios of the transparent logistic model; top three risk-raising factors that apply to the patient.",
    }


def save(model: dict, name: str) -> Path:
    d = ROOT / "model_store"
    d.mkdir(exist_ok=True)
    path = d / f"{name}.joblib"
    joblib.dump(model, path)
    return path
