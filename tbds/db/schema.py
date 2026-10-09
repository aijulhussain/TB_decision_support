"""PostgreSQL schema. Analytic tables hold pseudonymous keys only; direct identifiers live in `identities`,
which only authorised roles can read through the API (every read is audit-logged)."""
from __future__ import annotations

from sqlalchemy import (BigInteger, Boolean, Column, Date, DateTime, Float, Index, Integer, MetaData, String, Table, Text,
                        create_engine, func)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine import Engine

from tbds.config import get_settings

metadata = MetaData()

districts = Table("districts", metadata, Column("district", String(60), primary_key=True), Column("data", JSONB, nullable=False))
facilities = Table("facilities", metadata, Column("facility_id", String(20), primary_key=True), Column("district", String(60), index=True),
                   Column("name", String(80)), Column("data", JSONB, nullable=False))
patients = Table(
    "patients", metadata, Column("patient_key", String(16), primary_key=True), Column("district", String(60), index=True),
    Column("facility_id", String(20), index=True), Column("sex", String(1)), Column("age", Integer), Column("status", String(24)),
    Column("notified_date", Date), Column("treatment_start_date", Date), Column("final_outcome", String(24)),
    Column("death_date", Date), Column("last_adherence_date", Date), Column("drug_resistant", Integer), Column("hiv_positive", Float),
)
identities = Table(
    "identities", metadata, Column("patient_key", String(16), primary_key=True), Column("first_name", String(80)),
    Column("last_name", String(80)), Column("guardian_name", String(80)), Column("phone", String(20)), Column("village", String(80)),
    Column("district", String(60), index=True), Column("facility_id", String(20), index=True),
)
patient_scores = Table(
    "patient_scores", metadata, Column("id", BigInteger, primary_key=True, autoincrement=True), Column("patient_key", String(16), index=True),
    Column("list_type", String(30)), Column("risk", Float), Column("tier", String(10)), Column("facility_id", String(20), index=True),
    Column("district", String(60), index=True), Column("days_since_start", Integer), Column("treatment_start_date", Date),
    Column("reasons", JSONB), Column("rank_in_facility", Integer), Column("on_review_list", Boolean), Column("model_version", String(40)),
    Index("ix_scores_list", "list_type", "on_review_list"),
)
facility_scores = Table("facility_scores", metadata, Column("facility_id", String(20), primary_key=True), Column("district", String(60), index=True),
                        Column("index_score", Float), Column("priority", String(20)), Column("data", JSONB, nullable=False))
district_scores = Table("district_scores", metadata, Column("district", String(60), primary_key=True), Column("data", JSONB, nullable=False))
referral_gaps = Table(
    "referral_gaps", metadata, Column("id", BigInteger, primary_key=True, autoincrement=True), Column("gap_type", String(30), index=True),
    Column("patient_key", String(16)), Column("facility_id", String(20), index=True), Column("district", String(60), index=True),
    Column("reference_date", Date), Column("days_open", Integer), Column("over_by_days", Integer), Column("severity", String(10)),
    Column("record_id", String(30)),
)
duplicate_candidates = Table(
    "duplicate_candidates", metadata, Column("id", BigInteger, primary_key=True, autoincrement=True), Column("key_a", String(16)),
    Column("key_b", String(16)), Column("weight", Float), Column("probability", Float), Column("band", String(12)),
    Column("agreeing_fields", Text), Column("disagreeing_fields", Text), Column("district", String(60), index=True),
    Column("status", String(12), default="pending", index=True), Column("reviewed_by", String(60)), Column("reviewed_at", DateTime(timezone=True)),
    Column("review_note", Text),
)
artifacts = Table("artifacts", metadata, Column("name", String(60), primary_key=True), Column("data", JSONB, nullable=False),
                  Column("updated_at", DateTime(timezone=True), server_default=func.now()))
users = Table(
    "users", metadata, Column("username", String(60), primary_key=True), Column("password_hash", String(100), nullable=False),
    Column("role", String(20), nullable=False), Column("district", String(60)), Column("facility_id", String(20)),
    Column("display_name", String(80)), Column("active", Boolean, default=True),
)
audit_log = Table(
    "audit_log", metadata, Column("id", BigInteger, primary_key=True, autoincrement=True),
    Column("ts", DateTime(timezone=True), server_default=func.now(), index=True), Column("username", String(60), index=True),
    Column("role", String(20)), Column("action", String(40), index=True), Column("resource", String(120)), Column("detail", JSONB),
)
review_actions = Table(
    "review_actions", metadata, Column("id", BigInteger, primary_key=True, autoincrement=True),
    Column("ts", DateTime(timezone=True), server_default=func.now()), Column("username", String(60)), Column("patient_key", String(16), index=True),
    Column("list_type", String(30)), Column("action", String(20)), Column("note", Text),
)


def get_engine(url: str | None = None) -> Engine:
    return create_engine(url or get_settings().database.url, pool_pre_ping=True, future=True)


def create_all(engine: Engine, drop: bool = False) -> None:
    if drop:
        metadata.drop_all(engine)
    metadata.create_all(engine)
