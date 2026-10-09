import numpy as np
import pandas as pd

from tbds.models import dedup, facility_index as fi, referral_gaps


def test_standardise_and_phonetics():
    assert dedup.standardise("Md. Rahman") == "mohammad rahman"
    assert dedup.standardise("Smt. Rina") == "rina"
    assert dedup._name_level("gogoi", "gogai") >= 2 and dedup._name_level("gogoi", "borah") == 0 and dedup._name_level("", "x") == -1


def test_linkage_finds_most_duplicates_with_high_precision(small_ds):
    queue, model, comp = dedup.run(small_ds.identities)
    ev = dedup.evaluate(queue, comp, dedup.prepare(small_ds.identities).patient_key, small_ds.truth_duplicates)
    assert ev["blocking_recall"] > 0.85
    assert ev["very_likely"]["precision"] > 0.90 and ev["very_likely"]["recall"] > 0.75
    assert (queue.probability >= 0.3).all()


def test_nothing_is_merged_automatically(small_ds):
    queue, _, _ = dedup.run(small_ds.identities)
    n_before = len(small_ds.patients)
    sup = dedup.suppress_keys(queue)
    assert len(small_ds.patients) == n_before                    # no record deleted
    assert sup <= set(queue.key_b)                               # only the later member of a flagged pair is excluded from analytics


def test_review_labels_improve_precision(small_ds):
    d = dedup.prepare(small_ds.identities)
    comp = dedup.compare(d, sorted(dedup.candidate_pairs(d)))
    truth = {frozenset((r.duplicate_key, r.original_key)) for r in small_ds.truth_duplicates.itertuples()}
    keys = d.patient_key
    comp["is_match"] = [frozenset((keys.iloc[a], keys.iloc[b])) in truth for a, b in zip(comp.a, comp.b)]
    def prec(model):
        _, p = model.score(comp); sel = comp[p >= 0.3]
        return sel.is_match.mean()
    base = dedup.fit(d, comp)
    tuned = dedup.fit(d, comp, labelled=comp[comp.is_match | (np.random.default_rng(0).random(len(comp)) < 0.002)])
    assert prec(tuned) >= prec(base)


def test_shrinkage_pulls_small_facilities_towards_the_district():
    x = pd.Series([0, 9, 50, 5]); n = pd.Series([3, 30, 500, 100]); g = pd.Series(["a", "a", "a", "a"])
    s = fi.eb_shrink(x, n, g)
    assert s.shrunk.iloc[0] > s.raw.iloc[0]                      # 0/3 is pulled up
    assert abs(s.shrunk.iloc[2] - s.raw.iloc[2]) < abs(s.shrunk.iloc[0] - s.raw.iloc[0])   # large n barely moves
    assert (s.lo <= s.shrunk).all() and (s.shrunk <= s.hi).all()


def test_shrinkage_beats_naive_estimates_against_known_truth(small_ds):
    m = fi._facility_metrics(small_ds, set())
    v = fi.validate_early_death_estimates(m, small_ds.truth_facility_effect)
    assert v["mse_shrunk"] < v["mse_naive"]


def test_planning_strain_uses_real_rop_numbers():
    d = pd.read_csv("data/public/assam_district_ntep_rop_2024_26.csv")
    s = fi.planning_strain(d).set_index("district")
    assert s.loc["Tinsukia", "patients_per_tu"] == (3392 + 81) / 4
    assert s.planning_strain_score.between(0, 100).all()


def test_referral_gap_rules_on_a_handcrafted_case(small_ds):
    ds = small_ds
    gaps = referral_gaps.find_gaps(ds, set())
    assert set(gaps.gap_type) <= set(referral_gaps.GAP_LABELS)
    for t, thr in [("tested_not_notified", 3), ("notified_not_started", 7), ("referral_not_closed", 14), ("missed_follow_up", 14)]:
        g = gaps[gaps.gap_type == t]
        assert (g.days_open >= thr).all() and (g.days_open <= referral_gaps.LOOKBACK[t]).all()
    assert gaps.severity.isin(["moderate", "high", "severe"]).all()
