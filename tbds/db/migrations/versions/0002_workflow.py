"""Workflow: gap actions, death-audit reviews, revoked tokens

Revision ID: 0002_workflow
Revises: 0001_baseline
Create Date: 2026-10-09T16:51:06
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = '0002_workflow'
down_revision = '0001_baseline'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table('death_reviews',
    sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
    sa.Column('ts', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
    sa.Column('username', sa.String(length=60), nullable=True),
    sa.Column('patient_key', sa.String(length=16), nullable=False),
    sa.Column('facility_id', sa.String(length=20), nullable=True),
    sa.Column('district', sa.String(length=60), nullable=True),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('avoidable', sa.String(length=10), nullable=True),
    sa.Column('contributing', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('summary', sa.Text(), nullable=True),
    sa.Column('actions_agreed', sa.Text(), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_death_reviews_district'), 'death_reviews', ['district'], unique=False)
    op.create_index(op.f('ix_death_reviews_patient_key'), 'death_reviews', ['patient_key'], unique=False)
    op.create_table('gap_actions',
    sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
    sa.Column('ts', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
    sa.Column('username', sa.String(length=60), nullable=True),
    sa.Column('gap_type', sa.String(length=30), nullable=False),
    sa.Column('record_id', sa.String(length=30), nullable=False),
    sa.Column('patient_key', sa.String(length=16), nullable=True),
    sa.Column('facility_id', sa.String(length=20), nullable=True),
    sa.Column('district', sa.String(length=60), nullable=True),
    sa.Column('action', sa.String(length=20), nullable=False),
    sa.Column('assignee', sa.String(length=60), nullable=True),
    sa.Column('note', sa.Text(), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_gap_actions_assignee'), 'gap_actions', ['assignee'], unique=False)
    op.create_index(op.f('ix_gap_actions_district'), 'gap_actions', ['district'], unique=False)
    op.create_index(op.f('ix_gap_actions_facility_id'), 'gap_actions', ['facility_id'], unique=False)
    op.create_index('ix_gap_actions_gap', 'gap_actions', ['gap_type', 'record_id'], unique=False)
    op.create_index(op.f('ix_gap_actions_ts'), 'gap_actions', ['ts'], unique=False)
    op.create_table('revoked_tokens',
    sa.Column('jti', sa.String(length=40), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('jti')
    )
    op.create_index(op.f('ix_revoked_tokens_expires_at'), 'revoked_tokens', ['expires_at'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_revoked_tokens_expires_at'), table_name='revoked_tokens')
    op.drop_table('revoked_tokens')
    op.drop_index(op.f('ix_gap_actions_ts'), table_name='gap_actions')
    op.drop_index('ix_gap_actions_gap', table_name='gap_actions')
    op.drop_index(op.f('ix_gap_actions_facility_id'), table_name='gap_actions')
    op.drop_index(op.f('ix_gap_actions_district'), table_name='gap_actions')
    op.drop_index(op.f('ix_gap_actions_assignee'), table_name='gap_actions')
    op.drop_table('gap_actions')
    op.drop_index(op.f('ix_death_reviews_patient_key'), table_name='death_reviews')
    op.drop_index(op.f('ix_death_reviews_district'), table_name='death_reviews')
    op.drop_table('death_reviews')
