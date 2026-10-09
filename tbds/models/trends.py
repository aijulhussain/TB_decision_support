"""Demand trends for resource planning (descriptive plus a simple, transparent projection).

Monthly notifications per district over complete months, a linear trend on the last 9 months with an approximate 80%
interval, and the quarter-on-quarter change. This supports questions such as "which districts are growing fastest?" and
"where should diagnostics and drugs be pre-positioned?". It is deliberately not a black box.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from tbds.pipeline.ingest import Dataset


def monthly_counts(ds: Dataset, exclude: set[str]) -> pd.DataFrame:
    p = ds.patients[~ds.patients.patient_key.isin(exclude)]
    last_complete = (ds.as_of.to_period("M") - 1)
    p = p[p.notified_date.dt.to_period("M") <= last_complete]
    m = p.groupby([p.notified_date.dt.to_period("M").astype(str).rename("month"), "district"]).size().rename("notified").reset_index()
    return m


def projections(ds: Dataset, exclude: set[str]) -> tuple[pd.DataFrame, pd.DataFrame]:
    m = monthly_counts(ds, exclude)
    wide = m.pivot(index="month", columns="district", values="notified").fillna(0).sort_index()
    recent = wide.tail(9)
    x = np.arange(len(recent))
    rows = []
    for d in wide.columns:
        y = recent[d].values
        slope, intercept = np.polyfit(x, y, 1)
        resid = y - (slope * x + intercept)
        sd = resid.std(ddof=2) if len(y) > 3 else 0
        fut_x = np.arange(len(recent), len(recent) + 3)
        fut = np.maximum(slope * fut_x + intercept, 0)
        last_q, prev_q = wide[d].tail(3).sum(), wide[d].iloc[-6:-3].sum()
        rows.append({"district": d, "last_quarter": int(last_q), "previous_quarter": int(prev_q),
                     "qoq_change_pct": float((last_q - prev_q) / prev_q * 100) if prev_q else None,
                     "projected_next_quarter": float(fut.sum()), "projected_lo": float(max(fut.sum() - 1.28 * sd * np.sqrt(3), 0)),
                     "projected_hi": float(fut.sum() + 1.28 * sd * np.sqrt(3)),
                     "monthly_slope": float(slope)})
    proj = pd.DataFrame(rows)
    proj["demand_flag"] = np.where(proj.qoq_change_pct > 15, "rising", np.where(proj.qoq_change_pct < -15, "falling", "stable"))
    return wide.reset_index(), proj
