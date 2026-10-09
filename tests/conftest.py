import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture(scope="session")
def small_data():
    from tbds.synth.generate import generate
    return generate(n_patients=6000, seed=42)


@pytest.fixture(scope="session")
def small_ds(small_data):
    from tbds.pipeline.ingest import build_dataset
    s = small_data
    return build_dataset(s.patients, s.facilities, s.lab_results, s.referrals, s.districts, s.truth_duplicates, s.truth_facility_effect)


@pytest.fixture(scope="session")
def mid_ds():
    """Larger synthetic cohort: enough events (about 500) for a stable hold-out AUC."""
    from tbds.pipeline.ingest import build_dataset
    from tbds.synth.generate import generate
    s = generate(n_patients=20000, seed=7)
    return build_dataset(s.patients, s.facilities, s.lab_results, s.referrals, s.districts, s.truth_duplicates, s.truth_facility_effect)
