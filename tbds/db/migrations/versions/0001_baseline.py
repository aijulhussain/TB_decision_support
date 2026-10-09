"""Baseline: the schema before migrations were introduced

Revision ID: 0001_baseline
Revises: None
Create Date: 2026-10-09T16:51:06
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = '0001_baseline'
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table('artifacts',
    sa.Column('name', sa.String(length=60), nullable=False),
    sa.Column('data', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
    sa.PrimaryKeyConstraint('name')
    )
    op.create_table('audit_log',
    sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
    sa.Column('ts', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
    sa.Column('username', sa.String(length=60), nullable=True),
    sa.Column('role', sa.String(length=20), nullable=True),
    sa.Column('action', sa.String(length=40), nullable=True),
    sa.Column('resource', sa.String(length=120), nullable=True),
    sa.Column('detail', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_audit_log_action'), 'audit_log', ['action'], unique=False)
    op.create_index(op.f('ix_audit_log_ts'), 'audit_log', ['ts'], unique=False)
    op.create_index(op.f('ix_audit_log_username'), 'audit_log', ['username'], unique=False)
    op.create_table('district_scores',
    sa.Column('district', sa.String(length=60), nullable=False),
    sa.Column('data', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.PrimaryKeyConstraint('district')
    )
    op.create_table('districts',
    sa.Column('district', sa.String(length=60), nullable=False),
    sa.Column('data', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.PrimaryKeyConstraint('district')
    )
    op.create_table('duplicate_candidates',
    sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
    sa.Column('key_a', sa.String(length=16), nullable=True),
    sa.Column('key_b', sa.String(length=16), nullable=True),
    sa.Column('weight', sa.Float(), nullable=True),
    sa.Column('probability', sa.Float(), nullable=True),
    sa.Column('band', sa.String(length=12), nullable=True),
    sa.Column('agreeing_fields', sa.Text(), nullable=True),
    sa.Column('disagreeing_fields', sa.Text(), nullable=True),
    sa.Column('district', sa.String(length=60), nullable=True),
    sa.Column('status', sa.String(length=12), nullable=True),
    sa.Column('reviewed_by', sa.String(length=60), nullable=True),
    sa.Column('reviewed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('review_note', sa.Text(), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_duplicate_candidates_district'), 'duplicate_candidates', ['district'], unique=False)
    op.create_index(op.f('ix_duplicate_candidates_status'), 'duplicate_candidates', ['status'], unique=False)
    op.create_table('facilities',
    sa.Column('facility_id', sa.String(length=20), nullable=False),
    sa.Column('district', sa.String(length=60), nullable=True),
    sa.Column('name', sa.String(length=80), nullable=True),
    sa.Column('data', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.PrimaryKeyConstraint('facility_id')
    )
    op.create_index(op.f('ix_facilities_district'), 'facilities', ['district'], unique=False)
    op.create_table('facility_scores',
    sa.Column('facility_id', sa.String(length=20), nullable=False),
    sa.Column('district', sa.String(length=60), nullable=True),
    sa.Column('index_score', sa.Float(), nullable=True),
    sa.Column('priority', sa.String(length=20), nullable=True),
    sa.Column('data', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.PrimaryKeyConstraint('facility_id')
    )
    op.create_index(op.f('ix_facility_scores_district'), 'facility_scores', ['district'], unique=False)
    op.create_table('identities',
    sa.Column('patient_key', sa.String(length=16), nullable=False),
    sa.Column('first_name', sa.String(length=80), nullable=True),
    sa.Column('last_name', sa.String(length=80), nullable=True),
    sa.Column('guardian_name', sa.String(length=80), nullable=True),
    sa.Column('phone', sa.String(length=20), nullable=True),
    sa.Column('village', sa.String(length=80), nullable=True),
    sa.Column('district', sa.String(length=60), nullable=True),
    sa.Column('facility_id', sa.String(length=20), nullable=True),
    sa.PrimaryKeyConstraint('patient_key')
    )
    op.create_index(op.f('ix_identities_district'), 'identities', ['district'], unique=False)
    op.create_index(op.f('ix_identities_facility_id'), 'identities', ['facility_id'], unique=False)
    op.create_table('patient_scores',
    sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
    sa.Column('patient_key', sa.String(length=16), nullable=True),
    sa.Column('list_type', sa.String(length=30), nullable=True),
    sa.Column('risk', sa.Float(), nullable=True),
    sa.Column('tier', sa.String(length=10), nullable=True),
    sa.Column('facility_id', sa.String(length=20), nullable=True),
    sa.Column('district', sa.String(length=60), nullable=True),
    sa.Column('days_since_start', sa.Integer(), nullable=True),
    sa.Column('treatment_start_date', sa.Date(), nullable=True),
    sa.Column('reasons', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('rank_in_facility', sa.Integer(), nullable=True),
    sa.Column('on_review_list', sa.Boolean(), nullable=True),
    sa.Column('model_version', sa.String(length=40), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_patient_scores_district'), 'patient_scores', ['district'], unique=False)
    op.create_index(op.f('ix_patient_scores_facility_id'), 'patient_scores', ['facility_id'], unique=False)
    op.create_index(op.f('ix_patient_scores_patient_key'), 'patient_scores', ['patient_key'], unique=False)
    op.create_index('ix_scores_list', 'patient_scores', ['list_type', 'on_review_list'], unique=False)
    op.create_table('patients',
    sa.Column('patient_key', sa.String(length=16), nullable=False),
    sa.Column('district', sa.String(length=60), nullable=True),
    sa.Column('facility_id', sa.String(length=20), nullable=True),
    sa.Column('sex', sa.String(length=1), nullable=True),
    sa.Column('age', sa.Integer(), nullable=True),
    sa.Column('status', sa.String(length=24), nullable=True),
    sa.Column('notified_date', sa.Date(), nullable=True),
    sa.Column('treatment_start_date', sa.Date(), nullable=True),
    sa.Column('final_outcome', sa.String(length=24), nullable=True),
    sa.Column('death_date', sa.Date(), nullable=True),
    sa.Column('last_adherence_date', sa.Date(), nullable=True),
    sa.Column('drug_resistant', sa.Integer(), nullable=True),
    sa.Column('hiv_positive', sa.Float(), nullable=True),
    sa.PrimaryKeyConstraint('patient_key')
    )
    op.create_index(op.f('ix_patients_district'), 'patients', ['district'], unique=False)
    op.create_index(op.f('ix_patients_facility_id'), 'patients', ['facility_id'], unique=False)
    op.create_table('referral_gaps',
    sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
    sa.Column('gap_type', sa.String(length=30), nullable=True),
    sa.Column('patient_key', sa.String(length=16), nullable=True),
    sa.Column('facility_id', sa.String(length=20), nullable=True),
    sa.Column('district', sa.String(length=60), nullable=True),
    sa.Column('reference_date', sa.Date(), nullable=True),
    sa.Column('days_open', sa.Integer(), nullable=True),
    sa.Column('over_by_days', sa.Integer(), nullable=True),
    sa.Column('severity', sa.String(length=10), nullable=True),
    sa.Column('record_id', sa.String(length=30), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_referral_gaps_district'), 'referral_gaps', ['district'], unique=False)
    op.create_index(op.f('ix_referral_gaps_facility_id'), 'referral_gaps', ['facility_id'], unique=False)
    op.create_index(op.f('ix_referral_gaps_gap_type'), 'referral_gaps', ['gap_type'], unique=False)
    op.create_table('review_actions',
    sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
    sa.Column('ts', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
    sa.Column('username', sa.String(length=60), nullable=True),
    sa.Column('patient_key', sa.String(length=16), nullable=True),
    sa.Column('list_type', sa.String(length=30), nullable=True),
    sa.Column('action', sa.String(length=20), nullable=True),
    sa.Column('note', sa.Text(), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_review_actions_patient_key'), 'review_actions', ['patient_key'], unique=False)
    op.create_table('users',
    sa.Column('username', sa.String(length=60), nullable=False),
    sa.Column('password_hash', sa.String(length=100), nullable=False),
    sa.Column('role', sa.String(length=20), nullable=False),
    sa.Column('district', sa.String(length=60), nullable=True),
    sa.Column('facility_id', sa.String(length=20), nullable=True),
    sa.Column('display_name', sa.String(length=80), nullable=True),
    sa.Column('active', sa.Boolean(), nullable=True),
    sa.PrimaryKeyConstraint('username')
    )


def downgrade() -> None:
    op.drop_table('users')
    op.drop_index(op.f('ix_review_actions_patient_key'), table_name='review_actions')
    op.drop_table('review_actions')
    op.drop_index(op.f('ix_referral_gaps_gap_type'), table_name='referral_gaps')
    op.drop_index(op.f('ix_referral_gaps_facility_id'), table_name='referral_gaps')
    op.drop_index(op.f('ix_referral_gaps_district'), table_name='referral_gaps')
    op.drop_table('referral_gaps')
    op.drop_index(op.f('ix_patients_facility_id'), table_name='patients')
    op.drop_index(op.f('ix_patients_district'), table_name='patients')
    op.drop_table('patients')
    op.drop_index('ix_scores_list', table_name='patient_scores')
    op.drop_index(op.f('ix_patient_scores_patient_key'), table_name='patient_scores')
    op.drop_index(op.f('ix_patient_scores_facility_id'), table_name='patient_scores')
    op.drop_index(op.f('ix_patient_scores_district'), table_name='patient_scores')
    op.drop_table('patient_scores')
    op.drop_index(op.f('ix_identities_facility_id'), table_name='identities')
    op.drop_index(op.f('ix_identities_district'), table_name='identities')
    op.drop_table('identities')
    op.drop_index(op.f('ix_facility_scores_district'), table_name='facility_scores')
    op.drop_table('facility_scores')
    op.drop_index(op.f('ix_facilities_district'), table_name='facilities')
    op.drop_table('facilities')
    op.drop_index(op.f('ix_duplicate_candidates_status'), table_name='duplicate_candidates')
    op.drop_index(op.f('ix_duplicate_candidates_district'), table_name='duplicate_candidates')
    op.drop_table('duplicate_candidates')
    op.drop_table('districts')
    op.drop_table('district_scores')
    op.drop_index(op.f('ix_audit_log_username'), table_name='audit_log')
    op.drop_index(op.f('ix_audit_log_ts'), table_name='audit_log')
    op.drop_index(op.f('ix_audit_log_action'), table_name='audit_log')
    op.drop_table('audit_log')
    op.drop_table('artifacts')
