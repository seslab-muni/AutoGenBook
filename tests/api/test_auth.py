"""Coverage for issue #96: email+password login issuing a 24h JWT in an
httpOnly cookie, guarding every `/api/v1` route except `POST /auth/login`
(and the health/ready probes), and recording who owns a project / started a
run.
"""

from __future__ import annotations

import re
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import jwt
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from api.application.runs import GenerationService
from api.core.settings import Settings, get_settings
from api.domain.models import OutputFormat, RunKind, RunStatus, TargetAudience, User
from api.infrastructure.db.file_repository import SqlAlchemyFileRepository
from api.infrastructure.db.models import ProjectRecord, RunRecord
from api.infrastructure.db.outline_repository import SqlAlchemyOutlineRepository
from api.infrastructure.db.repositories import SqlAlchemyProjectRepository
from api.infrastructure.db.run_artifact_repository import SqlAlchemyRunArtifactRepository
from api.infrastructure.db.run_repository import (
    SqlAlchemyRunEventRepository,
    SqlAlchemyRunRepository,
)
from api.infrastructure.db.source_repository import SqlAlchemySourceRepository
from api.infrastructure.db.user_repository import SqlAlchemyUserRepository
from api.infrastructure.queue.postgres import SqlAlchemyRunQueue
from api.infrastructure.storage.memory import InMemoryFileStorage

from conftest import TEST_USER_EMAIL, TEST_USER_NAME, TEST_USER_PASSWORD

REPO_ROOT = Path(__file__).resolve().parents[2]
FAKE_CLI = Path(__file__).resolve().with_name("fake_cli.py")

_GENERIC_LOGIN_ERROR = "Invalid email or password"


def _settings(tmp_path: Path, **overrides) -> Settings:
    defaults = dict(
        cli_python=sys.executable,
        cli_entrypoint=str(FAKE_CLI),
        repo_root=str(REPO_ROOT),
        runs_dir=str(tmp_path),
    )
    defaults.update(overrides)
    return Settings(**defaults)


async def _drive_generation(
    run_id: str, session_factory: async_sessionmaker[AsyncSession], storage, settings: Settings
):
    async with session_factory() as session:
        run = await SqlAlchemyRunQueue(session).claim("test-worker")
        assert run is not None and str(run.id) == run_id
        service = GenerationService(
            run_repository=SqlAlchemyRunRepository(session),
            run_event_repository=SqlAlchemyRunEventRepository(session),
            run_queue=SqlAlchemyRunQueue(session),
            project_repository=SqlAlchemyProjectRepository(session),
            outline_repository=SqlAlchemyOutlineRepository(session),
            source_repository=SqlAlchemySourceRepository(session),
            file_repository=SqlAlchemyFileRepository(session),
            file_storage=storage,
            run_artifact_repository=SqlAlchemyRunArtifactRepository(session),
            settings=settings,
            drain_poll_interval_s=0.05,
            worker_id="test-worker",
        )
        return await service.execute(run)


# ---------------------------------------------------------------------------
# Login / logout / me
# ---------------------------------------------------------------------------


async def test_login_success_returns_user_and_sets_cookie(
    client: AsyncClient, seeded_user: User
) -> None:
    response = await client.post(
        "/api/v1/auth/login",
        json={"email": seeded_user.email, "password": TEST_USER_PASSWORD},
        headers={"X-Requested-With": "XMLHttpRequest"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body == {
        "id": str(seeded_user.id),
        "email": TEST_USER_EMAIL,
        "displayName": TEST_USER_NAME,
    }

    set_cookie = response.headers.get("set-cookie", "")
    assert "autogenbook_session=" in set_cookie
    assert "HttpOnly" in set_cookie
    assert "samesite=lax" in set_cookie.lower()
    assert "Path=/api" in set_cookie
    # `AUTH_COOKIE_SECURE=0` in this test env only (see conftest.py) so the
    # plain-http ASGI test transport can round-trip the cookie at all - the
    # `Secure` attribute itself is driven straight off `settings.
    # auth_cookie_secure` (`api/presentation/routers/auth.py`), not
    # hardcoded, so this isn't exercising the production default.
    assert "Secure" not in set_cookie


def test_set_session_cookie_respects_auth_cookie_secure_setting() -> None:
    from starlette.responses import Response

    from api.presentation.routers.auth import _set_session_cookie

    secure_settings = Settings(auth_jwt_secret="x" * 40, auth_cookie_secure=True)
    secure_response = Response()
    _set_session_cookie(secure_response, "token-value", secure_settings)
    assert "Secure" in secure_response.headers["set-cookie"]

    insecure_settings = Settings(auth_jwt_secret="x" * 40, auth_cookie_secure=False)
    insecure_response = Response()
    _set_session_cookie(insecure_response, "token-value", insecure_settings)
    assert "Secure" not in insecure_response.headers["set-cookie"]


async def test_login_wrong_password_returns_generic_401(
    client: AsyncClient, seeded_user: User
) -> None:
    response = await client.post(
        "/api/v1/auth/login",
        json={"email": seeded_user.email, "password": "not the password"},
        headers={"X-Requested-With": "XMLHttpRequest"},
    )
    assert response.status_code == 401
    assert response.headers["content-type"] == "application/problem+json"
    assert response.json()["detail"] == _GENERIC_LOGIN_ERROR


async def test_login_without_csrf_header_is_rejected(
    client: AsyncClient, seeded_user: User
) -> None:
    # The CSRF rule (issue #96) applies to every non-GET/HEAD/OPTIONS
    # `/api/v1` request unconditionally, including `POST /auth/login`
    # itself, even though login has no ambient cookie for a forged
    # cross-site POST to ride on - `public_router` in `api/main.py` still
    # carries `require_csrf_header` alongside `auth.public_router`.
    response = await client.post(
        "/api/v1/auth/login",
        json={"email": seeded_user.email, "password": TEST_USER_PASSWORD},
    )
    assert response.status_code == 403


async def test_login_unknown_email_returns_same_generic_401(client: AsyncClient) -> None:
    response = await client.post(
        "/api/v1/auth/login",
        json={"email": "nobody@example.com", "password": "whatever"},
        headers={"X-Requested-With": "XMLHttpRequest"},
    )
    assert response.status_code == 401
    assert response.json()["detail"] == _GENERIC_LOGIN_ERROR


async def test_login_inactive_user_returns_401(
    client: AsyncClient, seeded_user: User, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    async with session_factory() as session:
        await SqlAlchemyUserRepository(session).set_active(seeded_user.id, False)

    response = await client.post(
        "/api/v1/auth/login",
        json={"email": seeded_user.email, "password": TEST_USER_PASSWORD},
        headers={"X-Requested-With": "XMLHttpRequest"},
    )
    assert response.status_code == 401
    assert response.json()["detail"] == _GENERIC_LOGIN_ERROR


async def test_me_returns_current_user(authed_client: AsyncClient, seeded_user: User) -> None:
    response = await authed_client.get("/api/v1/auth/me")
    assert response.status_code == 200
    assert response.json() == {
        "id": str(seeded_user.id),
        "email": TEST_USER_EMAIL,
        "displayName": TEST_USER_NAME,
    }


async def test_me_without_cookie_returns_401(client: AsyncClient) -> None:
    response = await client.get("/api/v1/auth/me")
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Cookie"


async def test_logout_clears_cookie_and_ends_session(authed_client: AsyncClient) -> None:
    logout_response = await authed_client.post("/api/v1/auth/logout")
    assert logout_response.status_code == 204
    set_cookie = logout_response.headers.get("set-cookie", "")
    assert "autogenbook_session=" in set_cookie
    assert re.search(r'Max-Age=0|expires=Thu, 01[- ]Jan[- ]1970', set_cookie, re.IGNORECASE)

    me_response = await authed_client.get("/api/v1/auth/me")
    assert me_response.status_code == 401


# ---------------------------------------------------------------------------
# Token validity / revocation
# ---------------------------------------------------------------------------


async def test_expired_token_returns_401(client: AsyncClient, seeded_user: User) -> None:
    settings = get_settings()
    now = datetime.now(timezone.utc)
    expired_token = jwt.encode(
        {
            "sub": str(seeded_user.id),
            "email": seeded_user.email,
            "name": seeded_user.display_name,
            "iat": now - timedelta(hours=2),
            "exp": now - timedelta(hours=1),
            "pca": int(seeded_user.password_changed_at.timestamp()),
        },
        settings.auth_jwt_secret,
        algorithm="HS256",
    )
    client.cookies.set(settings.auth_cookie_name, expired_token)

    response = await client.get("/api/v1/auth/me")
    assert response.status_code == 401


async def test_token_issued_before_password_change_is_rejected(
    authed_client: AsyncClient,
    seeded_user: User,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    # Sanity check: the freshly-issued token still works.
    assert (await authed_client.get("/api/v1/auth/me")).status_code == 200

    async with session_factory() as session:
        await SqlAlchemyUserRepository(session).update_password(
            seeded_user.id, "irrelevant-new-hash"
        )

    response = await authed_client.get("/api/v1/auth/me")
    assert response.status_code == 401


# ---------------------------------------------------------------------------
# CSRF header
# ---------------------------------------------------------------------------


async def test_post_without_csrf_header_is_rejected(authed_client: AsyncClient) -> None:
    authed_client.headers.pop("X-Requested-With", None)
    response = await authed_client.post(
        "/api/v1/projects",
        json={"title": "t", "subtitle": "s", "authors": ["A"], "topic": "widgets"},
    )
    assert response.status_code == 403


async def test_post_with_csrf_header_is_accepted(authed_client: AsyncClient) -> None:
    response = await authed_client.post(
        "/api/v1/projects",
        json={"title": "t", "subtitle": "s", "authors": ["A"], "topic": "widgets"},
    )
    assert response.status_code == 201, response.text


async def test_get_without_csrf_header_still_works(authed_client: AsyncClient) -> None:
    authed_client.headers.pop("X-Requested-With", None)
    response = await authed_client.get("/api/v1/projects")
    assert response.status_code == 200


# ---------------------------------------------------------------------------
# Ownership / run-starter attribution
# ---------------------------------------------------------------------------

_MINIMAL_PROJECT = {
    "title": "Intro to Widgets",
    "subtitle": "A Practical Guide",
    "authors": ["Ada Lovelace"],
    "topic": "widgets",
}


async def test_project_create_sets_owner_from_current_user(
    authed_client: AsyncClient, seeded_user: User
) -> None:
    response = await authed_client.post("/api/v1/projects", json=_MINIMAL_PROJECT)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["ownerId"] == str(seeded_user.id)
    assert body["ownerName"] == seeded_user.display_name

    list_response = await authed_client.get("/api/v1/projects")
    summary = next(p for p in list_response.json()["items"] if p["id"] == body["id"])
    assert summary["ownerId"] == str(seeded_user.id)
    assert summary["ownerName"] == seeded_user.display_name


async def test_duplicate_assigns_the_duplicating_user_as_owner(
    authed_client: AsyncClient,
    authed_client_2: AsyncClient,
    seeded_user: User,
    seeded_user_2: User,
) -> None:
    created = await authed_client.post("/api/v1/projects", json=_MINIMAL_PROJECT)
    project_id = created.json()["id"]

    duplicated = await authed_client_2.post(f"/api/v1/projects/{project_id}/duplicate")
    assert duplicated.status_code == 201, duplicated.text
    body = duplicated.json()
    assert body["ownerId"] == str(seeded_user_2.id)
    assert body["ownerName"] == seeded_user_2.display_name
    assert body["ownerId"] != str(seeded_user.id)


async def test_legacy_project_without_owner_renders_null_owner_name(
    authed_client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    async with session_factory() as session:
        record = ProjectRecord(
            id=uuid.uuid4(),
            owner_id=None,
            title="Legacy Project",
            subtitle="",
            authors=["Nobody"],
            topic="legacy",
            target_audience=TargetAudience.GRADUATE,
            total_pages_budget=100,
            equation_frequency_level=1,
            do_consider_outline=True,
            do_consider_previous_sections=True,
            output_format=OutputFormat.MARKDOWN,
            max_outline_levels=3,
            additional_requirements=None,
        )
        session.add(record)
        await session.commit()
        project_id = record.id

    get_response = await authed_client.get(f"/api/v1/projects/{project_id}")
    assert get_response.status_code == 200
    assert get_response.json()["ownerId"] is None
    assert get_response.json()["ownerName"] is None

    list_response = await authed_client.get("/api/v1/projects")
    summary = next(p for p in list_response.json()["items"] if p["id"] == str(project_id))
    assert summary["ownerName"] is None


async def test_run_create_records_started_by(
    authed_client: AsyncClient, seeded_user: User
) -> None:
    project = (await authed_client.post("/api/v1/projects", json=_MINIMAL_PROJECT)).json()
    response = await authed_client.post(
        f"/api/v1/projects/{project['id']}/runs", json={"outline": "project"}
    )
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["startedById"] == str(seeded_user.id)
    assert body["startedByName"] == seeded_user.display_name


async def test_regenerate_and_export_record_started_by(
    app,
    authed_client: AsyncClient,
    seeded_user: User,
    session_factory: async_sessionmaker[AsyncSession],
    file_storage: InMemoryFileStorage,
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    app.dependency_overrides[get_settings] = lambda: settings

    project = (await authed_client.post("/api/v1/projects", json=_MINIMAL_PROJECT)).json()
    project_id = project["id"]
    node = (
        await authed_client.post(
            f"/api/v1/projects/{project_id}/outline",
            json={"title": "Chapter A", "targetPages": 2},
        )
    ).json()

    full_run = (
        await authed_client.post(
            f"/api/v1/projects/{project_id}/runs", json={"outline": "project"}
        )
    ).json()
    finished = await _drive_generation(full_run["id"], session_factory, file_storage, settings)
    assert finished.status.value == "succeeded", finished.error

    regen_response = await authed_client.post(
        f"/api/v1/projects/{project_id}/outline/{node['id']}/regenerate", json={}
    )
    assert regen_response.status_code == 202, regen_response.text
    assert regen_response.json()["startedById"] == str(seeded_user.id)
    assert regen_response.json()["startedByName"] == seeded_user.display_name

    # The regenerate run above is still `queued` - export would otherwise
    # 409 on "project already has an active run", the same guard that keeps
    # two real runs from racing each other.
    regen_finished = await _drive_generation(
        regen_response.json()["id"], session_factory, file_storage, settings
    )
    assert regen_finished.status.value == "succeeded", regen_finished.error

    export_response = await authed_client.post(
        f"/api/v1/runs/{full_run['id']}/exports", json={"format": "latex"}
    )
    assert export_response.status_code == 202, export_response.text
    assert export_response.json()["startedById"] == str(seeded_user.id)
    assert export_response.json()["startedByName"] == seeded_user.display_name


async def test_legacy_run_without_started_by_renders_null(
    authed_client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    project = (await authed_client.post("/api/v1/projects", json=_MINIMAL_PROJECT)).json()
    async with session_factory() as session:
        record = RunRecord(
            id=uuid.uuid4(),
            project_id=uuid.UUID(project["id"]),
            kind=RunKind.full,
            status=RunStatus.succeeded,
            options={"outline": "project"},
            work_dir="/tmp/does-not-matter",
            started_by=None,
        )
        session.add(record)
        await session.commit()
        run_id = record.id

    response = await authed_client.get(f"/api/v1/runs/{run_id}")
    assert response.status_code == 200
    assert response.json()["startedById"] is None
    assert response.json()["startedByName"] is None


# ---------------------------------------------------------------------------
# Route walk: every /api/v1 route is guarded by default
# ---------------------------------------------------------------------------

_PUBLIC_ROUTES = {
    ("POST", "/api/v1/auth/login"),
    ("GET", "/api/v1/health"),
    ("GET", "/api/v1/ready"),
}
_PLACEHOLDER_RE = re.compile(r"\{[^}]+\}")


def _concrete_path(path_template: str) -> str:
    return _PLACEHOLDER_RE.sub(lambda _match: str(uuid.uuid4()), path_template)


_HTTP_METHODS = {"get", "post", "put", "patch", "delete"}


async def test_every_api_v1_route_requires_auth_by_default(app, client: AsyncClient) -> None:
    """Issue #96's core acceptance criterion, enforced structurally rather
    than by hand-maintaining a list of guarded paths: walk every operation
    FastAPI's own generated OpenAPI schema documents under `/api/v1` and
    assert it 401s with no cookie unless it's in the explicit public set
    above - so a new route added to any router is guarded by default, not
    accidentally public by omission. Reading `app.openapi()["paths"]` (the
    schema `docs/openapi.yaml` is regenerated from) is the stable, public
    way to enumerate operations - `app.routes` is an internal representation
    FastAPI is free to restructure between versions. Reuses the `app`/
    `client` fixtures (already wired to the test database) rather than a
    bare `create_app()`, so this never touches the real `DATABASE_URL` even
    though every guarded route short-circuits on the missing cookie before
    any query would run."""
    schema = app.openapi()
    checked = 0
    for path, path_item in schema["paths"].items():
        if not path.startswith("/api/v1"):
            continue
        for method_lower in path_item:
            if method_lower not in _HTTP_METHODS:
                continue  # e.g. a shared "parameters" key, not an operation
            method = method_lower.upper()
            if (method, path) in _PUBLIC_ROUTES:
                continue
            concrete_path = _concrete_path(path)
            response = await client.request(method, concrete_path)
            assert response.status_code == 401, (
                f"{method} {path} was not guarded by default (got "
                f"{response.status_code}: {response.text})"
            )
            checked += 1
    # A canary against the walk silently checking nothing (e.g. every route
    # accidentally matching `_PUBLIC_ROUTES` or the prefix filter being
    # wrong) - there are far more than 10 guarded operations today.
    assert checked > 10
