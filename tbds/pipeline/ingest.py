"""Ingestion: load a source (synthetic or de-identified extract), pseudonymise, split identity from analytics.

Design rules (see docs/GOVERNANCE.md):
* Analytic tables never contain direct identifiers. Patients are referred to by a pseudonymous key,
  HMAC-SHA256(salt, nikshay_id). The salt lives outside the analytics environment.
* Direct identifiers (name, guardian, phone, village) go to a separate `identities` table that only the
  record-linkage job and authorised data managers can read. Every read of it is audit-logged.
* The column contract below is what a real extract must provide. Missing optional columns are tolerated
  and reported by the data-quality step.
"""
from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass

import pandas as pd

from tbds.config import PUBLIC_DATA, get_settings

IDENTITY_COLS = ["first_name", "last_name", "guardian_name", "phone", "village"]

REQUIRED_COLS = [
    "nikshay_id", "sex", "age", "district", "facility_id", "diagnosis_date", "notified_date", "treatment_start_date",
    "status", "final_outcome", "death_date", "hiv_positive", "diabetes", "drug_resistant", "extrapulmonary",
    "bact_confirmed", "prior_tb", "bmi", "diag_to_start_days",
]
OPTIONAL_COLS = ["alcohol_use", "tobacco_use", "migrant", "tribal", "tea_garden", "private_sector",
                 "npy_enrolled_by_day15", "missed_doses_first30d", "last_adherence_date", "weight_kg"] + IDENTITY_COLS
DATE_COLS = ["diagnosis_date", "notified_date", "treatment_start_date", "death_date", "last_adherence_date"]


def pseudonymise(nikshay_ids: pd.Series, salt: str | None = None) -> pd.Series:
    salt = salt or get_settings().security.pseudonym_salt
    key = salt.encode()
    return nikshay_ids.astype(str).map(lambda v: hmac.new(key, v.encode(), hashlib.sha256).hexdigest()[:16])


@dataclass
class Dataset:
    districts: pd.DataFrame
    facilities: pd.DataFrame
    patients: pd.DataFrame        # analytic, pseudonymised
    identities: pd.DataFrame      # patient_key + direct identifiers
    lab_results: pd.DataFrame
    referrals: pd.DataFrame
    truth_duplicates: pd.DataFrame | None
    truth_facility_effect: pd.DataFrame | None
    as_of: pd.Timestamp
    source: str


def validate_columns(df: pd.DataFrame) -> None:
    missing = [c for c in REQUIRED_COLS if c not in df.columns]
    if missing:
        raise ValueError(f"extract is missing required columns: {missing}. See docs/DATA_ACCESS.md for the contract.")


def build_dataset(patients: pd.DataFrame, facilities: pd.DataFrame, lab: pd.DataFrame, referrals: pd.DataFrame,
                  districts: pd.DataFrame, truth_dup=None, truth_fac=None, source="synthetic") -> Dataset:
    cfg = get_settings()
    validate_columns(patients)
    patients = patients.copy()
    for c in OPTIONAL_COLS:
        if c not in patients.columns:
            patients[c] = pd.NA
    for c in DATE_COLS:
        patients[c] = pd.to_datetime(patients[c], errors="coerce")

    patients["patient_key"] = pseudonymise(patients["nikshay_id"])
    id_map = patients.set_index("nikshay_id")["patient_key"]
    identities = patients[["patient_key", "nikshay_id"] + IDENTITY_COLS + ["sex", "age", "district", "facility_id", "notified_date"]].copy()
    analytic = patients.drop(columns=IDENTITY_COLS + ["nikshay_id"])

    lab = lab.copy()
    lab["patient_key"] = lab["nikshay_id"].map(id_map)
    lab = lab.drop(columns=["nikshay_id"])
    lab["test_date"] = pd.to_datetime(lab["test_date"])
    referrals = referrals.copy()
    referrals["patient_key"] = referrals["nikshay_id"].map(id_map)
    referrals = referrals.drop(columns=["nikshay_id"])
    for c in ["referral_date", "closed_date"]:
        referrals[c] = pd.to_datetime(referrals[c])

    truth_d = None
    if truth_dup is not None:
        truth_d = pd.DataFrame({"duplicate_key": truth_dup.duplicate_id.map(id_map), "original_key": truth_dup.original_id.map(id_map)})
    return Dataset(districts=districts, facilities=facilities, patients=analytic, identities=identities, lab_results=lab,
                   referrals=referrals, truth_duplicates=truth_d, truth_facility_effect=truth_fac,
                   as_of=pd.Timestamp(cfg.data.as_of), source=source)


def load_dataset() -> Dataset:
    """Entry point used by the CLI: synthetic generator or a de-identified extract (CSV/parquet)."""
    cfg = get_settings()
    districts = pd.read_csv(PUBLIC_DATA / "assam_district_ntep_rop_2024_26.csv")
    if cfg.data.source == "synthetic":
        from tbds.synth.generate import generate
        s = generate()
        return build_dataset(s.patients, s.facilities, s.lab_results, s.referrals, s.districts,
                             s.truth_duplicates, s.truth_facility_effect, source="synthetic")
    path = cfg.data.extract_path
    if not path:
        raise ValueError("data.source=extract requires data.extract_path (directory with patients/facilities/lab_results/referrals files)")
    from pathlib import Path
    base = Path(path)
    read = lambda n: pd.read_parquet(base / f"{n}.parquet") if (base / f"{n}.parquet").exists() else pd.read_csv(base / f"{n}.csv")
    return build_dataset(read("patients"), read("facilities"), read("lab_results"), read("referrals"), districts, source="extract")
