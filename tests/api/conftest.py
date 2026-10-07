from __future__ import annotations

import os

# Must be set before `api.main`/`api.core.settings` is ever imported (by any
# fixture or test module below, or by pytest collection of another test file
# first) - `Settings.auth_jwt_secret` is a required field, so importing
# anything that constructs a `Settings()` without this would fail collection
# entirely. 40 bytes, comfortably over the 32-byte minimum.
os.environ.setdefault("AUTH_JWT_SECRET", "pytest-only-secret-do-not-use-in-prod-40b")
# Same reasoning: `Settings.database_url` is now a required field too. Tests
# never actually connect through it (they build their own engine from
# `TEST_DATABASE_URL` below) - this only needs to satisfy pydantic.
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite://")
# The ASGI test transport talks plain http://testserver, never https - a
# `Secure` cookie (the production default) would never be sent back by a
# real browser/httpx client over that scheme, so every request after login
# would silently look unauthenticated. This is exactly the "plain-http LAN
# dev" case `AUTH_COOKIE_SECURE=0` documents.
os.environ.setdefault("AUTH_COOKIE_SECURE", "0")

import sys
import uuid
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from contextlib import contextmanager
from datetime import datetime, timezone

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from api.application.auth import AuthService
from api.application.revisions import RevisionRunner
from api.core.settings import get_settings
from api.core.db import Base, get_session, get_sessionmaker
from api.domain.models import User
from api.infrastructure.db.user_repository import SqlAlchemyUserRepository
from api.infrastructure.storage.memory import InMemoryFileStorage
from api.main import create_app
from api.presentation.deps import get_file_storage, get_revision_runner

# The engine's in-process fake LLM (no network): `FakeLLM.transport()` is handed
# to the revision runner's client pool. `fake_llm.py` imports its `responders`
# module by bare name, hence the path entry.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine"))
from fake_llm import FakeLLM  # noqa: E402

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL", "sqlite+aiosqlite://")

TEST_USER_EMAIL = "test.user@example.com"
TEST_USER_PASSWORD = "correct horse battery staple"  # noqa: S105 - test fixture only
TEST_USER_NAME = "Test User"
# A second seeded account (issue #96 ownership tests: "duplicate assigns the
# copy to the user who duplicated it" needs two distinct users to prove the
# owner actually changes, not just stays the same by coincidence).
TEST_USER_2_EMAIL = "test.user.two@example.com"
TEST_USER_2_PASSWORD = "another correct horse battery staple"  # noqa: S105
TEST_USER_2_NAME = "Test User Two"


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
async def isolated_session_factory(tmp_path) -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    """Like `session_factory`, but on SQLite every session gets its own
    connection (a file database, WAL) instead of all sharing one in-memory
    connection. Needed by tests that run a background job (the revision
    runner) next to HTTP requests: on a shared connection one session's
    rollback silently undoes another session's uncommitted statements, which
    Postgres (the real thing) never does. Modules use it by overriding
    `session_factory` with a fixture that yields this."""
    if not _uses_sqlite(TEST_DATABASE_URL):
        async with _open_engine() as factory:
            yield factory
        return
    url = f"sqlite+aiosqlite:///{tmp_path / 'isolated.db'}"
    engine = create_async_engine(url, connect_args={"timeout": 30})
    event.listen(engine.sync_engine, "connect", _enable_sqlite_fk_enforcement)

    def _wal(dbapi_connection, connection_record) -> None:  # noqa: ANN001
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()

    event.listen(engine.sync_engine, "connect", _wal)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


class _open_engine:
    """Postgres variant of the fresh-schema engine used by `session_factory`."""

    async def __aenter__(self) -> async_sessionmaker[AsyncSession]:
        self.engine = create_async_engine(TEST_DATABASE_URL)
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        return async_sessionmaker(self.engine, expire_on_commit=False)

    async def __aexit__(self, *exc) -> None:
        await self.engine.dispose()


@pytest_asyncio.fixture
def file_storage() -> InMemoryFileStorage:
    return InMemoryFileStorage()


@pytest_asyncio.fixture
def fake_llm() -> FakeLLM:
    return FakeLLM()


@pytest_asyncio.fixture
async def revision_runner(
    session_factory: async_sessionmaker[AsyncSession], fake_llm: FakeLLM
) -> AsyncIterator[RevisionRunner]:
    """A per-test revision runner whose LLM is the engine's fake (endpoint
    `http://fake.local/v1`, a deployment key, no pricing lookups)."""
    runner = RevisionRunner(
        session_factory,
        get_settings(),
        transport=fake_llm.transport(),
        env={
            "AUTOGENBOOK_LLM_BASE_URL": "http://fake.local/v1",
            "OPENROUTER_API_KEY": "sk-deployment-test-key",
            "OPENROUTER_PRICING_DISABLE": "1",
            "OPENROUTER_MAX_RETRIES": "0",
        },
        hostname="testhost",
        poll_interval_s=0.05,
    )
    try:
        yield runner
    finally:
        await runner.aclose()


@pytest_asyncio.fixture
async def app(
    session_factory: async_sessionmaker[AsyncSession],
    file_storage: InMemoryFileStorage,
    revision_runner: RevisionRunner,
):
    application = create_app()

    async def override_get_session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    application.dependency_overrides[get_session] = override_get_session
    application.dependency_overrides[get_sessionmaker] = lambda: session_factory
    application.dependency_overrides[get_file_storage] = lambda: file_storage
    application.dependency_overrides[get_revision_runner] = lambda: revision_runner
    try:
        yield application
    finally:
        application.dependency_overrides.clear()


@pytest_asyncio.fixture
async def client(app) -> AsyncIterator[AsyncClient]:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        yield ac


async def _seed_user(
    session_factory: async_sessionmaker[AsyncSession], *, email: str, name: str, password: str
) -> User:
    async with session_factory() as session:
        now = datetime.now(timezone.utc)
        user = User(
            id=uuid.uuid4(),
            email=email,
            display_name=name,
            password_hash=AuthService.hash_password(password),
            is_active=True,
            password_changed_at=now,
            created_at=now,
            updated_at=now,
        )
        return await SqlAlchemyUserRepository(session).add(user)


@pytest_asyncio.fixture
async def seeded_user(session_factory: async_sessionmaker[AsyncSession]) -> User:
    return await _seed_user(
        session_factory, email=TEST_USER_EMAIL, name=TEST_USER_NAME, password=TEST_USER_PASSWORD
    )


@pytest_asyncio.fixture
async def seeded_user_2(session_factory: async_sessionmaker[AsyncSession]) -> User:
    return await _seed_user(
        session_factory,
        email=TEST_USER_2_EMAIL,
        name=TEST_USER_2_NAME,
        password=TEST_USER_2_PASSWORD,
    )


async def _log_in(client: AsyncClient, *, email: str, password: str) -> AsyncClient:
    response = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": password},
        headers={"X-Requested-With": "XMLHttpRequest"},
    )
    assert response.status_code == 200, response.text
    # Every mutating request through this client needs the same CSRF header
    # (issue #96) - set it once as a client default instead of on every call
    # site, mirroring how the real frontend's `getAuthHeaders()` is applied
    # once in `client.ts`/`upload.ts` rather than per request.
    client.headers["X-Requested-With"] = "XMLHttpRequest"
    return client


@pytest_asyncio.fixture
async def authed_client(client: AsyncClient, seeded_user: User) -> AsyncClient:
    return await _log_in(client, email=seeded_user.email, password=TEST_USER_PASSWORD)


@pytest_asyncio.fixture
async def authed_client_2(app, seeded_user_2: User) -> AsyncIterator[AsyncClient]:
    """A second, independently-cookied client (issue #96's two-user
    ownership tests) - can't reuse `client`/`authed_client`'s single cookie
    jar, since logging in as a second user on the same `AsyncClient` would
    just overwrite the first user's session cookie."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        yield await _log_in(ac, email=seeded_user_2.email, password=TEST_USER_2_PASSWORD)


@pytest_asyncio.fixture
def count_statements(session_factory: async_sessionmaker[AsyncSession]):
    """Returns a context manager that counts every SQL statement actually
    sent to the database while it's open, by hooking `before_cursor_execute`
    on the engine `session_factory` is bound to - used by N+1 regression
    tests (issue #51) to assert a query count stays flat as the number of
    rows involved grows, rather than only asserting the *result* is
    correct."""
    engine = session_factory.kw["bind"].sync_engine

    @contextmanager
    def _count_statements() -> Iterator[list[str]]:
        statements: list[str] = []

        def _before_cursor_execute(conn, cursor, statement, parameters, context, executemany):  # noqa: ANN001
            statements.append(statement)

        event.listen(engine, "before_cursor_execute", _before_cursor_execute)
        try:
            yield statements
        finally:
            event.remove(engine, "before_cursor_execute", _before_cursor_execute)

    return _count_statements
