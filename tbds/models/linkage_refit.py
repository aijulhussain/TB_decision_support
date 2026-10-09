"""Refit duplicate-matching weights from the review queue.

Reviewers confirm or reject candidate pairs in the API. This job turns those decisions into labels and refits the
Fellegi-Sunter match distribution (see dedup.fit), then reports how the queue would change. It is the mechanism by which
the review work itself improves the linkage over time. Needs at least 20 confirmed pairs.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sqlalchemy import text

from tbds.db import schema as S
from tbds.models import dedup
from tbds.pipeline.ingest import load_dataset


def refit_from_reviews() -> dict:
    eng = S.get_engine()
    with eng.connect() as c:
        dec = pd.read_sql(text("SELECT key_a, key_b, status FROM duplicate_candidates WHERE status IN ('confirmed','rejected')"), c)
    if (dec.status == "confirmed").sum() < 20:
        return {"refit": False, "reason": "fewer than 20 confirmed pairs so far", "decisions": int(len(dec))}
    ds = load_dataset()
    d = dedup.prepare(ds.identities)
    pairs = sorted(dedup.candidate_pairs(d))
    comp = dedup.compare(d, pairs)
    keys = d.patient_key.values
    comp["key_a"], comp["key_b"] = keys[comp.a.values], keys[comp.b.values]
    lab = {frozenset((r.key_a, r.key_b)): r.status == "confirmed" for r in dec.itertuples()}
    comp["pair"] = [frozenset((a, b)) for a, b in zip(comp.key_a, comp.key_b)]
    labelled = comp[comp.pair.isin(lab)].copy()
    labelled["is_match"] = labelled.pair.map(lab)
    before = dedup.fit(d, comp)
    after = dedup.fit(d, comp, labelled=labelled)
    _, p0 = before.score(comp); _, p1 = after.score(comp)
    return {"refit": True, "labelled_pairs": int(len(labelled)), "confirmed": int(labelled.is_match.sum()),
            "pairs_flagged_before": int((p0 >= 0.3).sum()), "pairs_flagged_after": int((p1 >= 0.3).sum())}
