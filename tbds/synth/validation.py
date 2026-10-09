"""Multi-seed validation of the facility shrinkage on synthetic data (reproduces the figures in docs/VALIDATION.md)."""
from __future__ import annotations

import numpy as np
import pandas as pd

from tbds.models import facility_index as fi
from tbds.pipeline.ingest import build_dataset
from tbds.synth.generate import generate


def shrinkage_multiseed(seeds=range(1, 13)) -> dict:
    rows = []
    for seed in seeds:
        s = generate(seed=seed)
        ds = build_dataset(s.patients, s.facilities, s.lab_results, s.referrals, s.districts, s.truth_duplicates, s.truth_facility_effect)
        rows.append(fi.validate_early_death_estimates(fi._facility_metrics(ds, set()), s.truth_facility_effect))
    r = pd.DataFrame(rows)
    mean = r.drop(columns=["note"]).mean(numeric_only=True)
    return {
        "seeds": len(r),
        "mean_mse_reduction_all": float(1 - mean.mse_shrunk / mean.mse_naive),
        "mean_mse_reduction_small_facilities": float(1 - mean.mse_shrunk_small_facilities / mean.mse_naive_small_facilities),
        "mean_spearman_naive": float(mean.spearman_naive), "mean_spearman_shrunk": float(mean.spearman_shrunk),
        "mean_top20_recall_naive": float(mean.top20_recall_naive), "mean_top20_recall_shrunk": float(mean.top20_recall_shrunk),
    }
