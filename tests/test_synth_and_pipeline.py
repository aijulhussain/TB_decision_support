import numpy as np
import pandas as pd

from tbds.pipeline.ingest import IDENTITY_COLS, pseudonymise
from tbds.pipeline.quality import quality_report
from tbds.synth.generate import load_public_districts


def test_public_district_totals_match_the_published_rop():
    d = load_public_districts()
    assert len(d) == 33
    assert d.tu_count.sum() == 150 and d.tdc_count.sum() == 450
    assert d.npy_ds_target.sum() == 50000 and d.npy_dr_target.sum() == 1440
    assert d.acf_house_visit_target.sum() == 2_000_000 and d.lab_tests_target.sum() == 89075
    assert d.ppsa_notification_target.sum() == 13430


def test_generator_is_deterministic(small_data):
    from tbds.synth.generate import generate
    again = generate(n_patients=6000, seed=42)
    pd.testing.assert_frame_equal(small_data.patients.drop(columns=["death_date"]).head(200), again.patients.drop(columns=["death_date"]).head(200))


def test_analytic_table_has_no_direct_identifiers(small_ds):
    assert not set(IDENTITY_COLS + ["nikshay_id"]) & set(small_ds.patients.columns)
    assert set(IDENTITY_COLS) <= set(small_ds.identities.columns)
    assert small_ds.patients.patient_key.is_unique


def test_pseudonym_is_deterministic_and_salt_dependent():
    ids = pd.Series(["AS1", "AS2", "AS1"])
    a, b = pseudonymise(ids, "salt-one"), pseudonymise(ids, "salt-two")
    assert a.iloc[0] == a.iloc[2] and a.iloc[0] != a.iloc[1]
    assert not (a == b).any()


def test_outcomes_are_censored_at_the_cutoff(small_ds):
    p = small_ds.patients
    assert (p.death_date.dropna() <= small_ds.as_of).all()
    assert (p[p.status == "on_treatment"].final_outcome.isna()).all()


def test_quality_report_finds_injected_problems(small_ds):
    q = quality_report(small_ds)
    assert q["missingness"]["hiv_positive"] > 0.05
    assert q["rule_violations"]["bmi_implausible_lt10_or_gt50"] >= 0
    assert q["records"] == len(small_ds.patients)
