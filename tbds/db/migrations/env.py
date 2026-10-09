"""Alembic environment. The database URL comes from the project settings (config/default.yaml or TBDS__DATABASE__URL),
unless the caller sets `sqlalchemy.url` on the Alembic config."""
from __future__ import annotations

from alembic import context
from sqlalchemy import engine_from_config, pool

from tbds.db.schema import database_url, metadata

config = context.config
url = config.get_main_option("sqlalchemy.url") or database_url()
target_metadata = metadata


def run_offline() -> None:
    context.configure(url=url, target_metadata=target_metadata, literal_binds=True, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


def run_online() -> None:
    connectable = config.attributes.get("connection")
    if connectable is not None:
        context.configure(connection=connectable, target_metadata=target_metadata, compare_type=True)
        with context.begin_transaction():
            context.run_migrations()
        return
    engine = engine_from_config({"sqlalchemy.url": url}, prefix="sqlalchemy.", poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_offline()
else:
    run_online()
