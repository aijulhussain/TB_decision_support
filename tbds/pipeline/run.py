"""Orchestration: ingest -> quality -> dedup -> models -> indices -> gaps -> trends -> audit -> persist."""
from __future__ import annotations

import json
import time
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from tbds import __version__
from tbds.config import PUBLIC_DATA, get_settings
from tbds.models import death_audit, dedup, facility_index, referral_gaps, risk, trends
from tbds.pipeline.ingest import Dataset, load_dataset
from tbds.pipeline.quality import quality_report


def run_all(verbose: bool = True) -> dict:
    log = (lambda *a: print(*a, flush=True)) if verbose else (lambda *a: None)
    t0 = time.time()
    ds = load_dataset()
    log(f"[1/8] loaded {len(ds.patients):,} records ({ds.source}) as of {ds.as_of.date()}")
    quality = quality_report(ds)

    queue, fs_model, comp = dedup.run(ds.identities)
    d_prep = dedup.prepare(ds.identities)
    dedup_eval = dedup.evaluate(queue, comp, d_prep.patient_key, ds.truth_duplicates) if ds.truth_duplicates is not None else None
    suppress = dedup.suppress_keys(queue)
    log(f"[2/8] linkage: {len(comp):,} candidate pairs, {len(queue):,} flagged, {len(suppress):,} later duplicates excluded from the analytic cohort")

    version = f"{__version__}-{ds.as_of.date()}"
    models, cards, scores = {}, {}, []
    final = {}
    for spec in (risk.M1, risk.M2):
        ev = risk.train_and_evaluate(spec, ds.patients, ds.districts, ds.as_of, suppress)
        f = risk.fit_final(spec, ev, ds.patients, ds.districts, ds.as_of)
        f["scores"]["model_version"] = f"{spec.name}-{version}"
        scores.append(f["scores"])
        cards[spec.name] = risk.model_card(ev, f, f"{spec.name}-{version}", ds.as_of)
        models[spec.name] = f["model"]
        final[spec.name] = f
        risk.save(f["model"], spec.name)
        m = ev["chosen_metrics"]
        log(f"[3/8] {spec.name}: AUC {m['auc']:.3f} (95% CI {m['auc_ci95'][0]:.3f}-{m['auc_ci95'][1]:.3f}), calibration slope {m['calibration_slope']:.2f}, top-10% captures {m['capture_top_10pct']:.0%} of events")
    scores = pd.concat(scores, ignore_index=True)

    fac, fac_validation = facility_index.facility_index(ds, suppress)
    dist_out = facility_index.district_outcomes(ds, suppress)
    strain = facility_index.planning_strain(ds.districts)
    log(f"[4/8] facility index for {len(fac)} TUs ({(fac.priority == 'supervise_first').sum()} 'supervise first'), district planning strain from RoP data")

    gaps = referral_gaps.find_gaps(ds, suppress)
    gap_summary = referral_gaps.summarise(gaps, ds)
    wide, proj = trends.projections(ds, suppress)
    log(f"[5/8] {len(gaps):,} current gaps; demand projections for {len(proj)} districts")

    audit = death_audit.analyse(ds, suppress, final["early_death"]["cohort_scores"])
    log(f"[6/8] death audit: {audit['timing']['deaths']:,} deaths, {int(audit['facility_oe'].flag.sum())} facilities with excess early deaths vs expected")

    state = pd.read_csv(PUBLIC_DATA / "assam_state_series_2016_2023.csv")
    return {"ds": ds, "quality": quality, "queue": queue, "dedup_eval": dedup_eval, "fs_model": fs_model, "suppress": suppress,
            "scores": scores, "cards": cards, "facilities": fac, "fac_validation": fac_validation, "district_outcomes": dist_out,
            "strain": strain, "gaps": gaps, "gap_summary": gap_summary, "trends_wide": wide, "trends_proj": proj, "audit": audit,
            "state_series": state, "version": version, "elapsed": time.time() - t0}


def _clean(o):
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple, set)):
        return [_clean(v) for v in o]
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating, float)):
        return None if (o is None or np.isnan(o) or np.isinf(o)) else float(o)
    if isinstance(o, (np.bool_,)):
        return bool(o)
    if isinstance(o, (pd.Timestamp, datetime)):
        return o.isoformat()
    if o is pd.NaT or o is pd.NA:
        return None
    return o


def df_records(df: pd.DataFrame) -> list[dict]:
    return _clean(json.loads(df.to_json(orient="records", date_format="iso")))


def clean(o):
    return _clean(o)
