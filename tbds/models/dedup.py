"""Probabilistic record linkage (Fellegi-Sunter) for possible duplicate registrations.

Pipeline
  1. Standardise names (case, titles, common abbreviations such as Md/Mohd) and build phonetic keys (Metaphone).
  2. Block on several keys so that spelling variants still meet (surname sound + sex + district, first-name sound +
     sex + district, phone number, guardian-name sound + first-name sound).
  3. Compare each candidate pair field by field into agreement levels (exact / approximate / phonetic / initial /
     disagree / missing), using Jaro-Winkler similarity and edit distance.
  4. Weights: u estimated from the candidate pairs, m from documented domain knowledge and, as reviewers confirm or
     reject pairs, from those decisions (see `fit`). Additive log2 weights; missing fields contribute 0.
  5. Pairs with posterior match probability above `review_probability` go to a human review queue; above
     `very_likely_probability` they are flagged "very likely".
     NOTHING IS EVER MERGED AUTOMATICALLY. The analytic cohort drops only the later record of "very likely" pairs so
     the same person is not counted twice (or in both training and test sets) when fitting models.

When ground truth is available (synthetic data) `evaluate` reports blocking recall, precision and recall.
"""
from __future__ import annotations

import itertools
import re
from dataclasses import dataclass, field

import jellyfish
import numpy as np
import pandas as pd

from tbds.config import get_settings

FIELDS = ["first", "last", "guardian", "sex", "age", "phone", "village", "district", "dates"]
N_LEVELS = {"first": 4, "last": 4, "guardian": 3, "sex": 2, "age": 3, "phone": 4, "village": 3, "district": 2, "dates": 2}
_TITLES = re.compile(r"\b(mr|mrs|ms|smt|shri|sri|late|dr)\b\.?", re.I)
_ABBR = {"md": "mohammad", "mohd": "mohammad", "mo": "mohammad", "mohammed": "mohammad", "mohamed": "mohammad"}


def standardise(s: object) -> str:
    if s is None or (isinstance(s, float) and np.isnan(s)) or s is pd.NA:
        return ""
    t = _TITLES.sub("", str(s).lower())
    t = re.sub(r"[^a-z ]", "", t).strip()
    return " ".join(_ABBR.get(w, w) for w in t.split())


def _meta(s: str) -> str:
    return jellyfish.metaphone(s) if s else ""


def prepare(identities: pd.DataFrame) -> pd.DataFrame:
    d = identities.reset_index(drop=True).copy()
    d["f"] = d.first_name.map(standardise)
    d["l"] = d.last_name.map(standardise)
    d["g"] = d.guardian_name.map(standardise)
    d["vil"] = d.village.map(standardise)
    d["ph"] = d.phone.fillna("").astype(str).str.replace(r"\D", "", regex=True)
    d["fm"], d["lm"], d["gm"] = d.f.map(_meta), d.l.map(_meta), d.g.map(_meta)
    d["fi"], d["li"] = d.f.str[:1], d.l.str[:1]
    d["nd"] = (pd.to_datetime(d.notified_date) - pd.Timestamp("2000-01-01")).dt.days.astype(int)
    return d


def candidate_pairs(d: pd.DataFrame, max_block: int = 150) -> set[tuple[int, int]]:
    pairs: set[tuple[int, int]] = set()
    passes = [["lm", "sex", "district"], ["fm", "sex", "district"], ["ph"], ["gm", "fm", "district"], ["lm", "fi", "district"]]
    for keys in passes:
        sub = d[(d[keys] != "").all(axis=1)] if keys != ["ph"] else d[d.ph.str.len() >= 8]
        pos = sub.index.to_numpy()                         # .indices are positions within `sub`; map back to rows of d
        for _, idx in sub.groupby(keys).indices.items():
            if 1 < len(idx) <= max_block:
                rows = pos[idx].tolist()
                pairs.update((a, b) if a < b else (b, a) for a, b in itertools.combinations(rows, 2))
    return pairs


def _name_level(a: str, b: str) -> int:
    if not a or not b:
        return -1
    if a == b:
        return 3
    if (len(a) <= 2 and b.startswith(a[0])) or (len(b) <= 2 and a.startswith(b[0])):
        return 1
    jw = jellyfish.jaro_winkler_similarity(a, b)
    if jw >= 0.90 or _meta(a) == _meta(b):
        return 2
    return 1 if jw >= 0.80 else 0


def compare(d: pd.DataFrame, pairs: list[tuple[int, int]]) -> pd.DataFrame:
    a = np.fromiter((p[0] for p in pairs), int, len(pairs))
    b = np.fromiter((p[1] for p in pairs), int, len(pairs))
    f, l, g, vil, ph = (d[c].values for c in ["f", "l", "g", "vil", "ph"])
    sex, age, dist, nd = d.sex.values, d.age.values, d.district.values, d.nd.values
    out = {k: np.empty(len(pairs), dtype=np.int8) for k in FIELDS}
    for i in range(len(pairs)):
        x, y = a[i], b[i]
        out["first"][i] = _name_level(f[x], f[y])
        out["last"][i] = _name_level(l[x], l[y])
        if not g[x] or not g[y]:
            out["guardian"][i] = -1
        else:
            jw = jellyfish.jaro_winkler_similarity(g[x], g[y])
            out["guardian"][i] = 2 if (g[x] == g[y] or jw >= 0.90) else (1 if (_meta(g[x]) == _meta(g[y]) or jw >= 0.80) else 0)
        out["sex"][i] = int(sex[x] == sex[y])
        da = abs(int(age[x]) - int(age[y]))
        out["age"][i] = 2 if da <= 1 else (1 if da <= 3 else 0)
        if len(ph[x]) < 8 or len(ph[y]) < 8:
            out["phone"][i] = -1
        elif ph[x] == ph[y]:
            out["phone"][i] = 3
        else:
            out["phone"][i] = 2 if jellyfish.levenshtein_distance(ph[x], ph[y]) == 1 else 0
        if not vil[x] or not vil[y]:
            out["village"][i] = -1
        else:
            out["village"][i] = 2 if vil[x] == vil[y] else (1 if jellyfish.jaro_winkler_similarity(vil[x], vil[y]) >= 0.88 else 0)
        out["district"][i] = int(dist[x] == dist[y])
        out["dates"][i] = int(abs(int(nd[x]) - int(nd[y])) <= 120)
    res = pd.DataFrame(out)
    res.insert(0, "b", b)
    res.insert(0, "a", a)
    return res


@dataclass
class FSModel:
    m: dict[str, np.ndarray]
    u: dict[str, np.ndarray]
    prior: float
    weights: dict[str, np.ndarray] = field(default_factory=dict)

    def finalise(self) -> "FSModel":
        self.weights = {f: np.clip(np.log2(self.m[f] / self.u[f]), -8, 10) for f in FIELDS}
        return self

    def score(self, comp: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
        total = np.zeros(len(comp))
        for f in FIELDS:
            lev = comp[f].values.astype(int)
            w = np.where(lev >= 0, self.weights[f][np.clip(lev, 0, None)], 0.0)
            total += w
        prior_odds = np.log2(self.prior / (1 - self.prior))
        post_log_odds = total + prior_odds
        prob = 1 / (1 + 2.0 ** (-np.clip(post_log_odds, -40, 40)))
        return total, prob


def _init_m() -> dict[str, np.ndarray]:
    # heuristic starting point: matches mostly sit at the highest agreement level
    base = {"first": [0.04, 0.10, 0.26, 0.60], "last": [0.04, 0.10, 0.26, 0.60], "guardian": [0.10, 0.20, 0.70],
            "sex": [0.02, 0.98], "age": [0.08, 0.27, 0.65], "phone": [0.15, 0.10, 0.15, 0.60],
            "village": [0.15, 0.10, 0.75], "district": [0.10, 0.90], "dates": [0.05, 0.95]}
    return {k: np.array(v, float) for k, v in base.items()}


def _level_probs(comp: pd.DataFrame, weights: np.ndarray | None = None, prior: dict[str, np.ndarray] | None = None,
                 strength: float = 0.0) -> dict[str, np.ndarray]:
    """Level frequencies per field. With `prior`, a Dirichlet prior worth `strength` pseudo-pairs (MAP estimate)."""
    out = {}
    for f in FIELDS:
        lev = comp[f].values.astype(int)
        ok = lev >= 0
        w = np.ones(len(comp)) if weights is None else weights
        cnt = np.array([(w * ((lev == k) & ok)).sum() for k in range(N_LEVELS[f])]) + 0.5
        if prior is not None:
            cnt = cnt + strength * prior[f]
        out[f] = cnt / cnt.sum()
    return out


def fit(d: pd.DataFrame, comp: pd.DataFrame, labelled: pd.DataFrame | None = None, prior: float = 0.003,
        prior_strength: float = 200.0) -> FSModel:
    """Fellegi-Sunter parameters.

    u (how often fields agree for NON-matches) is estimated from the blocked candidate pairs themselves: true
    duplicates are well under 1% of candidates, so their level frequencies are an accurate estimate, and unlike
    random pairs they reflect that blocking makes non-matches look alike. District and sex are blocking keys, so
    their u comes from population marginals instead.

    m (how often fields agree for MATCHES) starts from documented domain knowledge (`_init_m`). Unsupervised EM was
    tried and rejected: with blocked candidates it is not identifiable (it latches onto look-alike non-matches).
    Instead the human review queue supplies labels. Pass `labelled` (rows with columns of `comp` plus `is_match`) and m
    becomes the level frequencies among confirmed matches, smoothed by a Dirichlet prior worth `prior_strength` pairs.
    """
    u = _level_probs(comp)
    for f, col in (("district", d.district), ("sex", d.sex)):
        p = col.value_counts(normalize=True).values
        u[f] = np.array([1 - (p ** 2).sum(), (p ** 2).sum()])
    m0 = _init_m()
    if labelled is not None and labelled.is_match.sum() >= 20:
        m = _level_probs(labelled[labelled.is_match.astype(bool)], prior=m0, strength=prior_strength)
    else:
        m = m0
    return FSModel(m=m, u=u, prior=prior).finalise()


def run(identities: pd.DataFrame) -> tuple[pd.DataFrame, FSModel, pd.DataFrame]:
    cfg = get_settings().dedup
    d = prepare(identities)
    pairs = sorted(candidate_pairs(d))
    comp = compare(d, pairs)
    model = fit(d, comp)
    weight, prob = model.score(comp)
    comp["weight"], comp["probability"] = weight, prob
    keep = comp[comp.probability >= cfg.review_probability].copy()
    keep["key_a"] = d.patient_key.values[keep.a]
    keep["key_b"] = d.patient_key.values[keep.b]
    # order so that "a" is the earlier notification (the record we would keep)
    swap = d.nd.values[keep.a] > d.nd.values[keep.b]
    keep.loc[swap, ["key_a", "key_b"]] = keep.loc[swap, ["key_b", "key_a"]].values
    keep["band"] = np.where(keep.probability >= cfg.very_likely_probability, "very_likely", "review")
    names = {1: "approx", 2: "phonetic/approx", 3: "exact"}
    keep["agreeing_fields"] = keep.apply(lambda r: ",".join(f for f in FIELDS if r[f] >= (2 if f in ("first", "last") else 1) and f not in ("sex",)), axis=1)
    keep["disagreeing_fields"] = keep.apply(lambda r: ",".join(f for f in FIELDS if r[f] == 0), axis=1)
    cols = ["key_a", "key_b", "weight", "probability", "band", "agreeing_fields", "disagreeing_fields"]
    return keep[cols].sort_values("weight", ascending=False).reset_index(drop=True), model, comp


def evaluate(queue: pd.DataFrame, comp: pd.DataFrame, d_keys: pd.Series, truth: pd.DataFrame) -> dict:
    """Needs ground truth (synthetic data only)."""
    truth_pairs = {frozenset((r.duplicate_key, r.original_key)) for r in truth.itertuples()}
    cand = {frozenset((d_keys.iloc[a], d_keys.iloc[b])) for a, b in zip(comp.a.values, comp.b.values)}
    out = {"true_duplicate_pairs": len(truth_pairs), "blocking_recall": round(len(truth_pairs & cand) / max(1, len(truth_pairs)), 4),
           "candidate_pairs_compared": int(len(comp))}
    for label in ["review", "very_likely"]:
        q = queue if label == "review" else queue[queue.band == "very_likely"]
        found = {frozenset((r.key_a, r.key_b)) for r in q.itertuples()}
        tp = len(found & truth_pairs)
        out[label] = {"pairs_flagged": len(found), "precision": round(tp / max(1, len(found)), 4), "recall": round(tp / max(1, len(truth_pairs)), 4)}
    return out


def suppress_keys(queue: pd.DataFrame) -> set[str]:
    """Later member of every 'very likely' pair: excluded from the analytic cohort only (never deleted or merged)."""
    return set(queue.loc[queue.band == "very_likely", "key_b"])
