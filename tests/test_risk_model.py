import numpy as np
import pandas as pd

from tbds.models import risk


def test_early_death_features_exclude_anything_known_only_later():
    forbidden = set(risk.DAY30_FEATURES) | {"missed_doses"}
    assert not forbidden & set(risk.M1.features)
    assert not forbidden & set(risk.M1.gbm_features)


def test_features_do_not_depend_on_outcome_columns(small_ds):
    p = small_ds.patients.copy()
    X1 = risk.build_features(p, small_ds.districts)[risk.M1.gbm_features]
    p2 = p.copy()
    p2["final_outcome"] = "died"
    p2["death_date"] = pd.Timestamp("2026-01-01")
    p2["missed_doses_first30d"] = 30
    p2["npy_enrolled_by_day15"] = 0
    X2 = risk.build_features(p2, small_ds.districts)[risk.M1.gbm_features]
    pd.testing.assert_frame_equal(X1, X2)   # M1 features are blind to outcomes and to day-30 signals


def test_labels_only_for_matured_patients(small_ds):
    lab = risk.add_labels(small_ds.patients, small_ds.as_of)
    ready = lab[lab.early_label_ready]
    assert (ready.days_since_start >= 60).all()
    young = lab[(lab.days_since_start < 60) & (lab.days_since_start >= 0)]
    assert not young.early_label_ready.any()


def test_model_recovers_known_risk_factors_and_is_calibrated(mid_ds):
    ev = risk.train_and_evaluate(risk.M1, mid_ds.patients, mid_ds.districts, mid_ds.as_of, set())
    assert ev["chosen_metrics"]["auc"] > 0.62
    assert 0.8 < ev["chosen_metrics"]["calibration_slope"] < 1.25
    orr = ev["odds_ratios"]
    assert orr["hiv_pos"] > 1.8 and orr["bmi_lt16"] > 1.8 and orr["age_75p"] > 1.8      # built into the generator
    assert ev["test_n"] > 0 and ev["train_window"][1] <= ev["test_window"][0]            # time-ordered split


def test_review_lists_are_capped_per_facility(small_ds):
    ev = risk.train_and_evaluate(risk.M1, small_ds.patients, small_ds.districts, small_ds.as_of, set())
    fin = risk.fit_final(risk.M1, ev, small_ds.patients, small_ds.districts, small_ds.as_of)
    s = fin["scores"]
    cap = 8
    assert (s[s.on_review_list].groupby("facility_id").size() <= cap).all()
    assert s[s.on_review_list].tier.isin(["high", "medium"]).all()
    assert s[s.on_review_list].reasons.map(len).between(0, 3).all()
