"""Synthetic TB programme data for Assam.

EVERYTHING produced here is synthetic. The district skeleton (33 districts, TU and TDC counts, expected patient
load) comes from the real NHM Assam NTEP District RoP 2024-26 (data/public). Patient-level records, facility
performance, referrals and duplicates are generated with plausible structure so the pipeline and models can be built
and tested end to end. No result computed on this data is a finding about real patients or facilities.

The generator embeds known relationships (e.g. low BMI and HIV raise early-death risk) so that model validation is
meaningful: a model that cannot recover them is wrong. Latent facility effects let the facility index be checked
against a known ground truth.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass

import numpy as np
import pandas as pd

from tbds.config import PUBLIC_DATA, get_settings
from tbds.synth.names import COMMUNITIES, SURNAMES, VILLAGE_STEMS, first_name, variant_of

TEA_DISTRICTS = {"Dibrugarh", "Tinsukia", "Sivasagar", "Charaideo", "Jorhat", "Golaghat", "Udalguri", "Sonitpur"}
BENGALI_DISTRICTS = {"Cachar", "Karimganj", "Hailakandi"}
MUSLIM_DISTRICTS = {"Dhubri", "South Salmara", "Goalpara", "Barpeta", "Bongaigaon", "Morigaon"}
BODO_DISTRICTS = {"Baksa", "Chirang", "Kokrajhar", "Udalguri"}
HILL_TRIBE_DISTRICTS = {"Karbi Anglong", "West Karbi Anglong", "Dima Hasao"}


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


_CODE_OVERRIDES = {"Kamrup Metro": "KMM", "Kamrup Rural": "KMR", "Karbi Anglong": "KBA", "Karimganj": "KMG",
                   "West Karbi Anglong": "WKA", "South Salmara": "SSM", "Dima Hasao": "DHS", "Dhemaji": "DMJ"}


def _code(name: str) -> str:
    return _CODE_OVERRIDES.get(name) or "".join(c for c in name.upper() if c.isalpha())[:3]


def district_mix(name: str) -> np.ndarray:
    """Community weights in the order of COMMUNITIES."""
    w = {c: 0.0 for c in COMMUNITIES}
    w.update({"assamese": 0.35, "bengali": 0.12, "muslim": 0.18, "tea_tribe": 0.08, "bodo": 0.07,
              "karbi_dimasa": 0.05, "nepali": 0.07, "other": 0.08})
    if name in BODO_DISTRICTS:
        w["bodo"] = 0.5
    if name in HILL_TRIBE_DISTRICTS:
        w["karbi_dimasa"] = 0.55
    if name in BENGALI_DISTRICTS:
        w["bengali"] = 0.5
    if name in MUSLIM_DISTRICTS:
        w["muslim"] = 0.5
    if name in TEA_DISTRICTS:
        w["tea_tribe"] = 0.25
    arr = np.array([w[c] for c in COMMUNITIES], dtype=float)
    return arr / arr.sum()


@dataclass
class SyntheticData:
    districts: pd.DataFrame
    facilities: pd.DataFrame
    patients: pd.DataFrame
    lab_results: pd.DataFrame
    referrals: pd.DataFrame
    truth_duplicates: pd.DataFrame
    truth_facility_effect: pd.DataFrame


def load_public_districts() -> pd.DataFrame:
    d = pd.read_csv(PUBLIC_DATA / "assam_district_ntep_rop_2024_26.csv")
    d["district_code"] = d["district"].map(_code)
    d["is_tea_district"] = d["district"].isin(TEA_DISTRICTS).astype(int)
    return d


def make_facilities(districts: pd.DataFrame, rng: np.random.Generator, as_of: pd.Timestamp) -> pd.DataFrame:
    rows = []
    for _, d in districts.iterrows():
        hard = int(d.hill_district or d.tribal_action_plan)
        for i in range(1, int(d.tu_count) + 1):
            last_sup_days = int(rng.integers(5, 240) + (60 if hard and rng.random() < 0.5 else 0))
            rows.append({
                "facility_id": f"AS-{d.district_code}-TU{i:02d}",
                "facility_name": f"{d.district} TU {i}",
                "district": d.district,
                "tdc_in_catchment": max(1, int(round(d.tdc_count / d.tu_count))),
                "has_naat": int(rng.random() < (0.72 if hard else 0.88)),
                "last_supervision_date": (as_of - pd.Timedelta(days=last_sup_days)).date().isoformat(),
                "supervision_visits_90d": int(rng.poisson(1.2 if hard else 1.7)),
            })
    return pd.DataFrame(rows)


def _names(rng, n, sex, community) -> tuple[list[str], list[str], list[str]]:
    first, last, parent = [], [], []
    for i in range(n):
        c = community[i]
        first.append(first_name(rng, c, sex[i]))
        last.append(SURNAMES[c][rng.integers(len(SURNAMES[c]))])
        parent.append(first_name(rng, c, "M"))
    return first, last, parent


def generate(n_patients: int | None = None, seed: int | None = None) -> SyntheticData:
    cfg = get_settings()
    n_patients = n_patients or cfg.data.synthetic_patients
    seed = cfg.data.seed if seed is None else seed
    rng = np.random.default_rng(seed)
    as_of = pd.Timestamp(cfg.data.as_of)
    start = pd.Timestamp(cfg.data.synthetic_start)

    districts = load_public_districts()
    facilities = make_facilities(districts, rng, as_of)

    # --- latent effects (ground truth for validating the facility index) ---
    dist_effect = dict(zip(districts.district, rng.normal(0, 0.18, len(districts))))
    facilities["q_tu"] = rng.normal(0, 0.42, len(facilities))
    facilities["district_effect"] = facilities.district.map(dist_effect)

    # --- allocate patients to districts by expected load, then to TUs ---
    load = districts.set_index("district").npy_ds_target + districts.set_index("district").npy_dr_target
    p_dist = (load / load.sum()).reindex(districts.district).values
    dist_idx = rng.choice(len(districts), size=n_patients, p=p_dist)
    dist_name = districts.district.values[dist_idx]

    fac_by_dist = {d: facilities[facilities.district == d].reset_index(drop=True) for d in districts.district}
    fac_weights = {d: rng.dirichlet(np.full(len(f), 1.6)) for d, f in fac_by_dist.items()}
    facility_id = np.empty(n_patients, dtype=object)
    for d, f in fac_by_dist.items():
        idx = np.where(dist_name == d)[0]
        if len(idx):
            facility_id[idx] = f.facility_id.values[rng.choice(len(f), size=len(idx), p=fac_weights[d])]

    fac = facilities.set_index("facility_id")
    q_tu = fac.loc[facility_id, "q_tu"].values
    d_eff = fac.loc[facility_id, "district_effect"].values
    drow = districts.set_index("district")
    hill = drow.loc[dist_name, "hill_district"].values
    tribal_plan = drow.loc[dist_name, "tribal_action_plan"].values
    tea_district = drow.loc[dist_name, "is_tea_district"].values
    hard = ((hill == 1) | (tribal_plan == 1)).astype(int)
    p_private = np.clip(drow.loc[dist_name, "ppsa_notification_target"].values / (drow.loc[dist_name, "npy_ds_target"].values + 1), 0, 0.5)

    # --- demographics and clinical baseline ---
    sex = np.where(rng.random(n_patients) < 0.62, "M", "F")
    child = rng.random(n_patients) < 0.06
    age = np.where(child, rng.integers(1, 15, n_patients), np.clip(rng.normal(44, 16, n_patients), 15, 90)).round().astype(int)
    bmi = np.where(child, rng.normal(15.2, 2.0, n_patients), np.clip(rng.normal(18.7, 3.0, n_patients), 11, 36))
    height = np.where(sex == "M", rng.normal(163, 7, n_patients), rng.normal(152, 6.5, n_patients))
    weight = np.where(child, np.clip(age * 2.6 + 8, 8, 45), bmi * (height / 100) ** 2)
    adult = age >= 15
    hiv = (rng.random(n_patients) < np.where(adult, 0.03, 0.01)).astype(int)
    diabetes = (rng.random(n_patients) < np.clip(0.04 + 0.12 * (age > 45) * adult, 0, 0.2)).astype(int)
    drug_resistant = (rng.random(n_patients) < (0.03 + 0.012 * hard)).astype(int)
    extrapulmonary = (rng.random(n_patients) < 0.17).astype(int)
    bact_conf = (rng.random(n_patients) < np.where(extrapulmonary == 1, 0.10, 0.60 - 0.06 * hard)).astype(int)
    prior_tb = (rng.random(n_patients) < 0.12).astype(int)
    alcohol = (rng.random(n_patients) < np.where((sex == "M") & adult, 0.22, 0.03)).astype(int)
    tobacco = (rng.random(n_patients) < np.where((sex == "M") & adult, 0.38, 0.06)).astype(int)
    migrant = (rng.random(n_patients) < 0.07).astype(int)

    mix = {d: district_mix(d) for d in districts.district}
    community = np.empty(n_patients, dtype=object)
    for d in districts.district:
        idx = np.where(dist_name == d)[0]
        if len(idx):
            community[idx] = np.array(COMMUNITIES, dtype=object)[rng.choice(len(COMMUNITIES), size=len(idx), p=mix[d])]
    tea_garden = ((community == "tea_tribe") & (rng.random(n_patients) < 0.8)).astype(int)
    tribal = np.isin(community, ["bodo", "karbi_dimasa", "tea_tribe"]).astype(int)
    private_sector = (rng.random(n_patients) < p_private).astype(int)

    # --- dates and care-pathway timings ---
    span_days = int((as_of - start).days - 3)
    notified = start + pd.to_timedelta(rng.integers(0, span_days, n_patients), unit="D")
    notif_lag = np.where(private_sector == 1, rng.integers(0, 6, n_patients), rng.integers(0, 3, n_patients))
    diagnosis = notified - pd.to_timedelta(notif_lag, unit="D")
    delay_notif_to_start = np.clip(np.exp(rng.normal(1.15 + 0.55 * q_tu + 0.25 * hard + 0.1 * private_sector, 0.85)), 0, 70).round().astype(int)
    diag_to_start = delay_notif_to_start + notif_lag

    pre_tx_loss_p = _sigmoid(-3.5 + 0.9 * q_tu + 0.3 * hard + 0.012 * delay_notif_to_start)
    pre_tx_loss = rng.random(n_patients) < pre_tx_loss_p
    treatment_start = notified + pd.to_timedelta(delay_notif_to_start, unit="D")

    npy_by_day15 = (rng.random(n_patients) < _sigmoid(1.1 - 0.7 * q_tu - 0.25 * private_sector)).astype(int)

    # --- outcome 1: early death (within N days of starting treatment) ---
    z_death = (
        -4.75
        + 0.85 * (age >= 60) + 0.35 * (age >= 75) - 0.35 * child
        + 0.25 * (sex == "M")
        + 1.25 * ((bmi < 16) & adult) + 0.55 * ((bmi >= 16) & (bmi < 18.5) & adult)
        + 1.30 * hiv + 0.50 * diabetes + 0.80 * drug_resistant
        + 0.30 * extrapulmonary + 0.35 * (1 - bact_conf) + 0.30 * prior_tb
        + 0.45 * (diag_to_start > 14) + 0.55 * (diag_to_start > 30)
        + 0.30 * alcohol + 0.30 * (1 - npy_by_day15)
        + 0.60 * q_tu + d_eff + 0.20 * hard
    )
    p_death = _sigmoid(z_death)
    early_death = (rng.random(n_patients) < p_death) & ~pre_tx_loss

    # --- adherence signal in first 30 days (available at day 30) ---
    lam = np.exp(-0.55 + 0.55 * alcohol + 0.40 * migrant + 0.30 * tea_garden + 0.45 * q_tu + 0.30 * (1 - npy_by_day15) + 0.2 * private_sector)
    lam = lam * rng.gamma(2.0, 0.5, n_patients)
    missed30 = np.clip(rng.poisson(lam), 0, 30)

    # --- outcome 2: unfavourable final outcome ---
    z_unfav = (
        -2.85 + 0.9 * (z_death + 4.75) * 0.6
        + 0.085 * missed30 + 0.35 * migrant + 0.25 * tea_garden + 0.30 * ((sex == "M") & (age < 45) & adult)
        + 0.5 * q_tu + d_eff * 0.7 - 0.30 * npy_by_day15
    )
    unfav = (rng.random(n_patients) < _sigmoid(z_unfav)) | early_death
    unfav &= ~pre_tx_loss
    duration = np.where(drug_resistant == 1, 365, 180)
    end_date = treatment_start + pd.to_timedelta(duration, unit="D")

    outcome = np.full(n_patients, "cured_or_completed", dtype=object)
    cat = rng.random(n_patients)
    late_death = unfav & ~early_death & (cat < 0.30)
    lfu = unfav & ~early_death & (cat >= 0.30) & (cat < 0.85)
    failed = unfav & ~early_death & (cat >= 0.85)
    outcome[late_death] = "died"
    outcome[lfu] = "lost_to_follow_up"
    outcome[failed] = "treatment_failed"
    outcome[early_death] = "died"
    outcome[pre_tx_loss] = "pre_treatment_loss"

    death_offset = np.where(
        early_death, np.clip(rng.gamma(1.6, 14, n_patients), 2, 59).round(),
        np.where(late_death, rng.integers(61, np.maximum(duration, 62)), 0),
    ).astype(int)
    death_date = treatment_start + pd.to_timedelta(death_offset, unit="D")
    died_flag = early_death | late_death

    # an outcome is only "known" once its event date has passed as_of; later events are censored
    event_date = pd.to_datetime(np.where(died_flag, death_date, end_date))
    known = (event_date <= as_of) & ~pre_tx_loss
    status = np.where(pre_tx_loss, "pre_treatment_loss", np.where(known, "outcome_recorded", "on_treatment")).astype(object)
    final_outcome = np.where(pre_tx_loss, "pre_treatment_loss", np.where(known, outcome, None)).astype(object)
    died_known = died_flag & known

    lapse = (status == "on_treatment") & (rng.random(n_patients) < (0.05 + 0.012 * np.minimum(missed30, 10) + 0.06 * np.clip(q_tu, 0, 1)))
    last_adherence = np.where(
        lapse, (as_of - pd.to_timedelta(rng.integers(15, 45, n_patients), unit="D")),
        (as_of - pd.to_timedelta(rng.poisson(1.6, n_patients), unit="D")),
    )
    last_adherence = pd.to_datetime(last_adherence)
    last_adherence = pd.Series(np.where(last_adherence < treatment_start, treatment_start, last_adherence)).values

    first, last, parent = _names(rng, n_patients, sex, community)
    villages = [f"{VILLAGE_STEMS[rng.integers(len(VILLAGE_STEMS))]} {rng.integers(1, 9)}" for _ in range(n_patients)]
    phone = np.array([f"9{rng.integers(100000000, 999999999)}" for _ in range(n_patients)], dtype=object)
    phone[rng.random(n_patients) < 0.12] = ""

    patients = pd.DataFrame({
        "nikshay_id": [f"AS{20240000000 + i}" for i in range(n_patients)],
        "first_name": first, "last_name": last, "guardian_name": parent,
        "sex": sex, "age": age, "phone": phone, "village": villages,
        "district": dist_name, "facility_id": facility_id,
        "weight_kg": weight.round(1), "bmi": bmi.round(1),
        "hiv_positive": hiv, "diabetes": diabetes, "drug_resistant": drug_resistant,
        "extrapulmonary": extrapulmonary, "bact_confirmed": bact_conf, "prior_tb": prior_tb,
        "alcohol_use": alcohol, "tobacco_use": tobacco, "migrant": migrant,
        "tribal": tribal, "tea_garden": tea_garden, "private_sector": private_sector,
        "diagnosis_date": pd.to_datetime(diagnosis).normalize(),
        "notified_date": pd.to_datetime(notified).normalize(),
        "treatment_start_date": pd.to_datetime(treatment_start).normalize(),
        "diag_to_start_days": diag_to_start,
        "npy_enrolled_by_day15": npy_by_day15,
        "missed_doses_first30d": missed30,
        "last_adherence_date": pd.to_datetime(last_adherence).normalize(),
        "status": status,
        "final_outcome": final_outcome,
        "death_date": pd.to_datetime(np.where(died_known, death_date, pd.NaT)),
    })
    # --- realistic data-quality problems (more frequent at weaker, harder-to-reach facilities) ---
    miss_p = np.clip(0.04 + 0.07 * np.clip(q_tu, 0, 1.5) + 0.03 * hard, 0, 0.4)
    for col, base in [("bmi", 0.0), ("hiv_positive", 0.07), ("diabetes", 0.05), ("bact_confirmed", -0.02)]:
        patients[col] = patients[col].astype(float)
        patients.loc[rng.random(len(patients)) < np.clip(miss_p + base, 0, 0.5), col] = np.nan
    bad = rng.random(len(patients)) < 0.0004
    patients.loc[bad, "bmi"] = rng.choice([1.8, 61.0, 0.0], bad.sum())          # keying errors
    patients["weight_kg"] = patients["weight_kg"].where(patients["bmi"].notna())

    patients.loc[patients.status == "pre_treatment_loss", ["treatment_start_date", "npy_enrolled_by_day15",
                                                           "missed_doses_first30d", "last_adherence_date"]] = [pd.NaT, 0, 0, pd.NaT]
    patients["diag_to_start_days"] = patients["diag_to_start_days"].where(patients.status != "pre_treatment_loss")
    patients["is_synthetic"] = True

    patients, truth = _inject_duplicates(patients, rng, as_of)
    patients = patients.sort_values("notified_date").reset_index(drop=True)

    lab, referrals = _events(patients, facilities, rng, as_of)

    truth_fac = facilities[["facility_id", "district", "q_tu", "district_effect"]].copy()
    truth_fac["true_early_death_prob"] = truth_fac.facility_id.map(pd.Series(p_death).groupby(facility_id).mean())
    facilities = facilities.drop(columns=["q_tu", "district_effect"])
    return SyntheticData(districts, facilities, patients, lab, referrals, truth, truth_fac)


def _inject_duplicates(patients: pd.DataFrame, rng: np.random.Generator, as_of: pd.Timestamp):
    """Re-registrations of the same person: spelling variants, a changed phone digit, another facility."""
    n = len(patients)
    k = int(0.032 * n)
    src_idx = rng.choice(n, size=k, replace=False)
    src = patients.iloc[src_idx].copy()
    ids = [f"AS{20249000000 + i}" for i in range(k)]
    dup = src.copy()
    dup["nikshay_id"] = ids
    dup["first_name"] = [variant_of(x, rng) for x in dup.first_name]
    dup["last_name"] = [variant_of(x, rng, surname=True) for x in dup.last_name]
    drop_guardian = rng.random(k) < 0.25
    dup.loc[drop_guardian, "guardian_name"] = ""
    dup["age"] = np.clip(dup.age + rng.choice([-2, -1, 0, 0, 0, 1, 2, 3], k), 0, 95)
    ph = dup.phone.astype(str).values.copy()
    for i in range(k):
        if ph[i] and rng.random() < 0.25:
            p = list(ph[i]); j = rng.integers(2, len(p)); p[j] = str((int(p[j]) + 1) % 10); ph[i] = "".join(p)
        elif ph[i] and rng.random() < 0.15:
            ph[i] = ""
    dup["phone"] = ph
    dup["village"] = [v if rng.random() < 0.6 else variant_of(v, rng) for v in dup.village]
    shift = pd.to_timedelta(rng.integers(0, 80, k), unit="D")
    for col in ["diagnosis_date", "notified_date", "treatment_start_date", "last_adherence_date", "death_date"]:
        dup[col] = dup[col] + shift
    moved = rng.random(k) < 0.30
    dup.loc[moved, "district"] = dup.loc[moved, "district"]   # same district, different TU
    dup["is_synthetic"] = True
    keep = dup.notified_date <= as_of - pd.Timedelta(days=3)
    dup, src_idx_kept = dup[keep], np.asarray(src_idx)[keep.values]
    truth = pd.DataFrame({"duplicate_id": dup.nikshay_id.values, "original_id": patients.iloc[src_idx_kept].nikshay_id.values})
    out = pd.concat([patients, dup], ignore_index=True)
    return out, truth


def _events(patients: pd.DataFrame, facilities: pd.DataFrame, rng: np.random.Generator, as_of: pd.Timestamp):
    q = facilities.set_index("facility_id").q_tu if "q_tu" in facilities else None
    fac_q = pd.Series(0.0, index=facilities.facility_id) if q is None else q
    pq = patients.facility_id.map(fac_q).fillna(0).values
    n = len(patients)

    lab = pd.DataFrame({
        "lab_result_id": [f"LR{i:07d}" for i in range(n)],
        "nikshay_id": patients.nikshay_id.values,
        "facility_id": patients.facility_id.values,
        "test_date": patients.diagnosis_date.values,
        "result": "positive",
        "notified": 1,
    })
    # positives never notified (tested-not-notified): recent, more frequent at weaker facilities
    recent = patients[patients.notified_date >= as_of - pd.Timedelta(days=75)]
    m = int(0.045 * len(recent))
    fids = facilities.facility_id.values
    w = np.exp(0.8 * fac_q.reindex(fids).fillna(0).values)
    w = w / w.sum()
    extra = pd.DataFrame({
        "lab_result_id": [f"LX{i:06d}" for i in range(m)],
        "nikshay_id": "",
        "facility_id": rng.choice(fids, size=m, p=w),
        "test_date": as_of - pd.to_timedelta(np.clip(rng.gamma(1.5, 9, m), 1, 70).round(), unit="D"),
        "result": "positive",
        "notified": 0,
    })
    lab = pd.concat([lab, extra], ignore_index=True)

    ref_mask = rng.random(n) < 0.18
    ref = patients[ref_mask][["nikshay_id", "facility_id", "diagnosis_date", "drug_resistant"]].copy()
    ref["referral_id"] = [f"RF{i:07d}" for i in range(len(ref))]
    ref["referral_date"] = ref.diagnosis_date
    ref["referred_to"] = ref.facility_id.map(lambda f: f)
    pqr = patients[ref_mask].facility_id.map(fac_q).fillna(0).values
    open_p = np.clip(0.05 + 0.10 * np.clip(pqr, 0, 1.5), 0.01, 0.35)
    is_open = rng.random(len(ref)) < open_p
    close_offset = np.clip(rng.gamma(1.8, 3.0, len(ref)), 0, 30).round().astype(int)
    ref["closed_date"] = pd.NaT
    ref.loc[~is_open, "closed_date"] = ref.loc[~is_open, "referral_date"] + pd.to_timedelta(close_offset[~is_open], unit="D")
    ref["referral_type"] = np.where(ref.drug_resistant == 1, "to_DRTB_centre", "TDC_to_TU")
    ref = ref[["referral_id", "nikshay_id", "facility_id", "referral_type", "referral_date", "closed_date"]]
    return lab, ref
