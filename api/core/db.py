from __future__ import annotations

from collections.abc import AsyncIterator
from functools import lru_cache

from sqlalchemy import MetaData
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from api.core.settings import get_settings

# Standard SQLAlchemy naming convention so every constraint Alembic
# autogenerate/`create_all` produces gets a deterministic name, instead of
# Postgres auto-naming FKs/uniques (`runs_project_id_fkey`,
# `files_storage_key_key`, ...) in a way `op.drop_constraint` could never
# reproduce on SQLite. Existing constraints created before this was added
# keep their auto-generated names (renaming them is a separate migration).
_NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=_NAMING_CONVENTION)


def to_async_url(url: str) -> str:
    """Normalize a plain postgresql:// URL to the async psycopg (v3) driver."""
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+psycopg://", 1)
    return url


@lru_cache
def get_engine() -> AsyncEngine:
    return create_async_engine(to_async_url(get_settings().database_url), pool_pre_ping=True)


@lru_cache
def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(get_engine(), expire_on_commit=False)


async def get_session() -> AsyncIterator[AsyncSession]:
    session_factory = get_sessionmaker()
    async with session_factory() as session:
        yield session
