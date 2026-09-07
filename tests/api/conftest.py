from __future__ import annotations

import os
from collections.abc import AsyncIterator

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from api.core.db import Base, get_session, get_sessionmaker
from api.infrastructure.storage.memory import InMemoryFileStorage
from api.main import create_app
from api.presentation.deps import get_file_storage

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL", "sqlite+aiosqlite://")


def _uses_sqlite(url: str) -> bool:
    return url.startswith("sqlite")


def _enable_sqlite_fk_enforcement(dbapi_connection, connection_record) -> None:  # noqa: ANN001
    # SQLite ignores foreign keys unless a session turns them on explicitly;
    # without this, tests can insert/delete rows that would violate an FK on
    # Postgres and never notice.
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


@pytest_asyncio.fixture
async def session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    engine_kwargs: dict = {}
    if _uses_sqlite(TEST_DATABASE_URL):
        engine_kwargs = {
            "connect_args": {"check_same_thread": False},
            "poolclass": StaticPool,
        }
    engine = create_async_engine(TEST_DATABASE_URL, **engine_kwargs)
    if _uses_sqlite(TEST_DATABASE_URL):
        event.listen(engine.sync_engine, "connect", _enable_sqlite_fk_enforcement)
    # Every test gets a clean schema: `create_all` alone is a no-op against
    # an already-populated Postgres database (all tests there share the same
    # physical server via `TEST_DATABASE_URL`), which used to leak rows
    # across tests and made count/list assertions flaky depending on test
    # order. `drop_all` first guarantees a fresh, empty schema every time,
    # on both backends.
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


@pytest_asyncio.fixture
def file_storage() -> InMemoryFileStorage:
    return InMemoryFileStorage()


@pytest_asyncio.fixture
async def app(session_factory: async_sessionmaker[AsyncSession], file_storage: InMemoryFileStorage):
    application = create_app()

    async def override_get_session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    application.dependency_overrides[get_session] = override_get_session
    application.dependency_overrides[get_sessionmaker] = lambda: session_factory
    application.dependency_overrides[get_file_storage] = lambda: file_storage
    try:
        yield application
    finally:
        application.dependency_overrides.clear()


@pytest_asyncio.fixture
async def client(app) -> AsyncIterator[AsyncClient]:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        yield ac
