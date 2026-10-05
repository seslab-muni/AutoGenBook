"""Per-user LLM key: cipher, `PUT/DELETE /auth/me/llm-key`, admission under
`LLM_KEY_POLICY=required`, worker-side key injection, and the admin script."""

from __future__ import annotations

import dataclasses
import logging
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest
from cryptography.fernet import Fernet
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from api.application.runs import (
    LLM_KEY_REQUIRED_MESSAGE,
    LLM_KEY_UNDECRYPTABLE_MESSAGE,
    GenerationService,
    queue_admission_blocker,
)
from api.core.secrets import LlmKeyCipher, LlmKeyDecryptError
from api.core.settings import Settings, get_settings
from api.domain.models import (
    OutputFormat,
    Project,
    Run,
    RunKind,
    RunOptions,
    RunStatus,
    TargetAudience,
    User,
)
from api.infrastructure.cli import book_command
from api.infrastructure.db.file_repository import SqlAlchemyFileRepository
from api.infrastructure.db.outline_repository import SqlAlchemyOutlineRepository
from api.infrastructure.db.repositories import SqlAlchemyProjectRepository
from api.infrastructure.db.run_artifact_repository import SqlAlchemyRunArtifactRepository
from api.infrastructure.db.run_repository import SqlAlchemyRunEventRepository, SqlAlchemyRunRepository
from api.infrastructure.db.source_repository import SqlAlchemySourceRepository
from api.infrastructure.db.user_repository import SqlAlchemyUserRepository
from api.infrastructure.queue.postgres import SqlAlchemyRunQueue
from api.infrastructure.storage.memory import InMemoryFileStorage
from api.scripts import users as users_script

REPO_ROOT = Path(__file__).resolve().parents[2]
FAKE_CLI = Path(__file__).resolve().with_name("fake_cli.py")
SECRET = "sk-or-v1-supersecretvalue1234"
CSRF = {"X-Requested-With": "XMLHttpRequest"}

MINIMAL_PROJECT = {
    "title": "Intro to Widgets",
    "subtitle": "A Practical Guide",
    "authors": ["Ada Lovelace"],
    "topic": "widgets",
}


def _settings(**overrides) -> Settings:
    defaults = dict(
        cli_python=sys.executable,
        cli_entrypoint=str(FAKE_CLI),
        repo_root=str(REPO_ROOT),
        cli_cancel_grace_s=1.0,
        cli_run_timeout_s=30.0,
    )
    defaults.update(overrides)
    return Settings(**defaults)


def _enabled_settings(**overrides) -> Settings:
    return _settings(llm_key_encryption_key=Fernet.generate_key().decode(), **overrides)


# --- cipher -------------------------------------------------------------------


def test_cipher_round_trip_and_ciphertext_differs() -> None:
    cipher = LlmKeyCipher(Fernet.generate_key().decode())
    token = cipher.encrypt(SECRET)
    assert SECRET not in token
    assert cipher.decrypt(token) == SECRET


def test_cipher_decrypt_with_another_key_raises_dedicated_error() -> None:
    token = LlmKeyCipher(Fernet.generate_key().decode()).encrypt(SECRET)
    with pytest.raises(LlmKeyDecryptError) as excinfo:
        LlmKeyCipher(Fernet.generate_key().decode()).decrypt(token)
    assert SECRET not in str(excinfo.value)


def test_cipher_decrypt_garbage_raises() -> None:
    with pytest.raises(LlmKeyDecryptError):
        LlmKeyCipher(Fernet.generate_key().decode()).decrypt("not-a-token")


def test_cipher_from_settings_is_none_when_disabled() -> None:
    assert LlmKeyCipher.from_settings(_settings()) is None
    assert LlmKeyCipher.from_settings(_enabled_settings()) is not None


# --- routes -------------------------------------------------------------------


@pytest.fixture
def enabled_settings() -> Settings:
    return _enabled_settings()


@pytest.fixture
def enable_feature(app, enabled_settings: Settings) -> Settings:
    app.dependency_overrides[get_settings] = lambda: enabled_settings
    return enabled_settings


async def test_put_returns_409_when_feature_disabled(authed_client: AsyncClient) -> None:
    response = await authed_client.put("/api/v1/auth/me/llm-key", json={"apiKey": SECRET})
    assert response.status_code == 409
    assert response.json()["code"] == "llm_key_disabled"
    me = (await authed_client.get("/api/v1/auth/me")).json()
    assert me["llmKeyConfigurable"] is False
    assert me["llmKey"] is None


async def test_put_me_delete_round_trip(
    authed_client: AsyncClient,
    enable_feature: Settings,
    session_factory: async_sessionmaker[AsyncSession],
    seeded_user: User,
) -> None:
    response = await authed_client.put("/api/v1/auth/me/llm-key", json={"apiKey": f"  {SECRET}  "})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["llmKeyConfigurable"] is True
    assert body["llmKeyPolicy"] == "optional"
    assert body["llmKey"]["last4"] == SECRET[-4:]
    assert body["llmKey"]["updatedAt"]
    # Neither the key nor its ciphertext ever appears in a response.
    assert SECRET not in response.text

    me = await authed_client.get("/api/v1/auth/me")
    assert me.json()["llmKey"]["last4"] == SECRET[-4:]
    assert SECRET not in me.text

    # Stored encrypted, decryptable with the deployment's Fernet key.
    async with session_factory() as session:
        stored = await SqlAlchemyUserRepository(session).get_by_id(seeded_user.id)
    assert stored is not None
    assert stored.llm_api_key_encrypted and SECRET not in stored.llm_api_key_encrypted
    assert LlmKeyCipher.from_settings(enable_feature).decrypt(stored.llm_api_key_encrypted) == SECRET

    deleted = await authed_client.delete("/api/v1/auth/me/llm-key")
    assert deleted.status_code == 204
    me = (await authed_client.get("/api/v1/auth/me")).json()
    assert me["llmKey"] is None
    async with session_factory() as session:
        cleared = await SqlAlchemyUserRepository(session).get_by_id(seeded_user.id)
    assert cleared is not None
    assert cleared.llm_api_key_encrypted is None
    assert cleared.llm_api_key_last4 is None
    assert cleared.llm_api_key_updated_at is None


async def test_put_validation_never_echoes_the_key(
    authed_client: AsyncClient, enable_feature: Settings
) -> None:
    blank = await authed_client.put("/api/v1/auth/me/llm-key", json={"apiKey": "   "})
    assert blank.status_code == 422
    too_long = await authed_client.put("/api/v1/auth/me/llm-key", json={"apiKey": "k" * 513})
    assert too_long.status_code == 422
    assert "kkkk" not in too_long.text
    extra = await authed_client.put(
        "/api/v1/auth/me/llm-key", json={"apiKey": SECRET, "other": 1}
    )
    assert extra.status_code == 422


@pytest.mark.parametrize(
    "payload",
    [
        {"key": "sk-or-v1-SECRETVALUE"},
        {"apikey": "sk-or-v1-SECRETVALUE"},
        {"apiKey": "sk-or-v1-SECRETVALUE", "extra": "sk-or-v1-SECRETVALUE"},
        {"apiKey": 12345},
    ],
)
async def test_put_422_never_echoes_any_part_of_the_body(
    authed_client: AsyncClient, enable_feature: Settings, payload: dict
) -> None:
    # A wrong/extra field name makes pydantic report the whole secret as the offending `input`
    # (`extra_forbidden`/`missing`); this route's 422s must carry neither `input` nor `ctx`.
    response = await authed_client.put("/api/v1/auth/me/llm-key", json=payload)
    assert response.status_code == 422
    for fragment in ("SECRETVALUE", "sk-or", "12345"):
        assert fragment not in response.text
    assert all("input" not in e and "ctx" not in e for e in response.json()["detail"])


async def test_login_422_never_echoes_the_password(client: AsyncClient) -> None:
    response = await client.post(
        "/api/v1/auth/login",
        json={"email": "a@example.com", "pw": "secretvalue"},
        headers=CSRF,
    )
    assert response.status_code == 422
    assert "secretvalue" not in response.text


async def test_routes_require_a_session(client: AsyncClient) -> None:
    assert (await client.put("/api/v1/auth/me/llm-key", json={"apiKey": SECRET}, headers=CSRF)).status_code == 401
    assert (await client.delete("/api/v1/auth/me/llm-key", headers=CSRF)).status_code == 401


async def test_put_body_is_never_logged(
    authed_client: AsyncClient, enable_feature: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.DEBUG):
        await authed_client.put("/api/v1/auth/me/llm-key", json={"apiKey": SECRET})
        await authed_client.put("/api/v1/auth/me/llm-key", json={"apiKey": " "})
    assert SECRET not in caplog.text
    assert "PUT /api/v1/auth/me/llm-key" in caplog.text  # the request itself is still logged


async def test_clear_works_when_feature_disabled(
    authed_client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    seeded_user: User,
) -> None:
    async with session_factory() as session:
        await SqlAlchemyUserRepository(session).set_llm_api_key(seeded_user.id, "ciphertext", "1234")
    assert (await authed_client.delete("/api/v1/auth/me/llm-key")).status_code == 204


# --- admission under LLM_KEY_POLICY=required ------------------------------------


def test_admission_blocker_refuses_when_key_missing_regardless_of_lane() -> None:
    assert (
        queue_admission_blocker(
            blocked_by_full_run=False, lane_runs=[], cap=5, llm_key_missing=True
        )
        == LLM_KEY_REQUIRED_MESSAGE
    )
    assert queue_admission_blocker(blocked_by_full_run=False, lane_runs=[], cap=5) is None


async def test_create_run_refused_under_required_without_key(
    authed_client: AsyncClient, app, seeded_user: User, session_factory
) -> None:
    settings = _enabled_settings(llm_key_policy="required")
    app.dependency_overrides[get_settings] = lambda: settings
    project = (await authed_client.post("/api/v1/projects", json=MINIMAL_PROJECT)).json()

    refused = await authed_client.post(f"/api/v1/projects/{project['id']}/runs", json={})
    assert refused.status_code == 409
    assert refused.json()["code"] == "llm_key_required"
    assert "account settings" in refused.json()["detail"]

    me = (await authed_client.get("/api/v1/auth/me")).json()
    assert me["llmKeyPolicy"] == "required"

    assert (await authed_client.put("/api/v1/auth/me/llm-key", json={"apiKey": SECRET})).status_code == 200
    accepted = await authed_client.post(f"/api/v1/projects/{project['id']}/runs", json={})
    assert accepted.status_code == 202, accepted.text


async def test_create_run_allowed_under_optional_without_key(
    authed_client: AsyncClient, enable_feature: Settings
) -> None:
    project = (await authed_client.post("/api/v1/projects", json=MINIMAL_PROJECT)).json()
    response = await authed_client.post(f"/api/v1/projects/{project['id']}/runs", json={})
    assert response.status_code == 202, response.text


# --- worker-side injection -------------------------------------------------------


def _project() -> Project:
    now = datetime.now(timezone.utc)
    return Project(
        id=uuid.uuid4(),
        owner_id=None,
        title="AI in Teaching",
        subtitle="A practical guide",
        authors=["Ada Lovelace"],
        topic="using AI tools in university courses",
        target_audience=TargetAudience.GRADUATE,
        total_pages_budget=120,
        equation_frequency_level=2,
        do_consider_outline=True,
        do_consider_previous_sections=True,
        output_format=OutputFormat.MARKDOWN,
        max_outline_levels=3,
        additional_requirements=None,
        llm_model="openai/gpt-5-mini",
        last_run_id=None,
        created_at=now,
        updated_at=now,
    )


def _run(project_id: uuid.UUID, work_dir: Path, started_by: uuid.UUID | None, **overrides) -> Run:
    now = datetime.now(timezone.utc)
    defaults = dict(
        id=uuid.uuid4(),
        project_id=project_id,
        kind=RunKind.full,
        status=RunStatus.running,
        options=RunOptions(outline="generate", output_format="markdown"),
        base_run_id=None,
        target_node_id=None,
        target_node_previous_status=None,
        work_dir=str(work_dir),
        exit_code=None,
        error=None,
        cancel_requested=False,
        locked_by="worker-1",
        heartbeat_at=now,
        queued_at=now,
        started_at=now,
        finished_at=None,
        total_tokens=None,
        total_cost_usd=None,
        started_by=started_by,
    )
    defaults.update(overrides)
    return Run(**defaults)


def _service(session: AsyncSession, settings: Settings) -> GenerationService:
    return GenerationService(
        run_repository=SqlAlchemyRunRepository(session),
        run_event_repository=SqlAlchemyRunEventRepository(session),
        run_queue=SqlAlchemyRunQueue(session),
        project_repository=SqlAlchemyProjectRepository(session),
        outline_repository=SqlAlchemyOutlineRepository(session),
        source_repository=SqlAlchemySourceRepository(session),
        file_repository=SqlAlchemyFileRepository(session),
        file_storage=InMemoryFileStorage(),
        run_artifact_repository=SqlAlchemyRunArtifactRepository(session),
        settings=settings,
        drain_poll_interval_s=0.05,
        user_repository=SqlAlchemyUserRepository(session),
    )


@pytest.fixture
def captured_build_calls(monkeypatch) -> list[tuple[dict, dict]]:
    calls: list[tuple[dict, dict]] = []
    real = book_command.build_command

    def spy(*args, **kwargs):
        argv, env, cwd = real(*args, **kwargs)
        calls.append((kwargs, dict(env)))
        return argv, env, cwd

    monkeypatch.setattr(book_command, "build_command", spy)
    return calls


async def _store_key(session_factory, user: User, settings: Settings, plain: str = SECRET) -> None:
    async with session_factory() as session:
        await SqlAlchemyUserRepository(session).set_llm_api_key(
            user.id, LlmKeyCipher.from_settings(settings).encrypt(plain), plain[-4:]
        )


async def test_worker_injects_users_key_and_concurrency(
    session_factory, tmp_path: Path, seeded_user: User, captured_build_calls, monkeypatch
) -> None:
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-shared")
    settings = _enabled_settings(llm_user_key_concurrency=3)
    await _store_key(session_factory, seeded_user, settings)
    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_project())
        run = await SqlAlchemyRunRepository(session).add(
            _run(project.id, tmp_path / "run", seeded_user.id)
        )
        finished = await _service(session, settings).execute(run)
        events, _ = await SqlAlchemyRunEventRepository(session).list(run.id, 0, 1000)

    assert finished.status == RunStatus.succeeded, finished.error
    (_kwargs, env), = captured_build_calls
    assert env["OPENROUTER_API_KEY"] == SECRET
    assert env["AUTOGENBOOK_LLM_API_KEY"] == SECRET
    assert env["AUTOGENBOOK_CONCURRENCY"] == "3"
    # The run records that a personal key was used - never the key itself.
    marker = [e for e in events if e.payload and e.payload.get("llmKeySource") == "user"]
    assert len(marker) == 1
    assert marker[0].payload["llmKeyLast4"] == SECRET[-4:]
    assert marker[0].payload["concurrency"] == 3
    assert "concurrency 3" in marker[0].message
    assert SECRET not in repr(events)
    assert SECRET not in (finished.error or "")


async def test_worker_uses_shared_key_when_user_has_none(
    session_factory, tmp_path: Path, seeded_user: User, captured_build_calls, monkeypatch
) -> None:
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-shared")
    monkeypatch.delenv("AUTOGENBOOK_CONCURRENCY", raising=False)
    settings = _enabled_settings()
    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_project())
        run = await SqlAlchemyRunRepository(session).add(
            _run(project.id, tmp_path / "run", seeded_user.id)
        )
        finished = await _service(session, settings).execute(run)

    assert finished.status == RunStatus.succeeded, finished.error
    (_kwargs, env), = captured_build_calls
    assert env["OPENROUTER_API_KEY"] == "sk-shared"
    assert "AUTOGENBOOK_CONCURRENCY" not in env


async def test_worker_never_looks_at_stored_keys_when_feature_disabled(
    session_factory, tmp_path: Path, seeded_user: User, captured_build_calls, monkeypatch
) -> None:
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-shared")
    async with session_factory() as session:
        await SqlAlchemyUserRepository(session).set_llm_api_key(seeded_user.id, "garbage", "1234")
        project = await SqlAlchemyProjectRepository(session).add(_project())
        run = await SqlAlchemyRunRepository(session).add(
            _run(project.id, tmp_path / "run", seeded_user.id)
        )
        finished = await _service(session, _settings()).execute(run)

    assert finished.status == RunStatus.succeeded, finished.error
    (_kwargs, env), = captured_build_calls
    assert env["OPENROUTER_API_KEY"] == "sk-shared"


async def test_worker_fails_run_when_stored_key_cannot_be_decrypted(
    session_factory, tmp_path: Path, seeded_user: User, captured_build_calls, monkeypatch
) -> None:
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-shared")
    old_settings = _enabled_settings()
    await _store_key(session_factory, seeded_user, old_settings)
    rotated = _enabled_settings()  # a different Fernet key
    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_project())
        run = await SqlAlchemyRunRepository(session).add(
            _run(project.id, tmp_path / "run", seeded_user.id)
        )
        finished = await _service(session, rotated).execute(run)

    assert finished.status == RunStatus.failed
    assert finished.error == LLM_KEY_UNDECRYPTABLE_MESSAGE
    assert captured_build_calls == []  # the CLI never started, no silent shared-key fallback


async def test_worker_guards_required_policy_after_queueing(
    session_factory, tmp_path: Path, seeded_user: User, captured_build_calls
) -> None:
    settings = _enabled_settings(llm_key_policy="required")
    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_project())
        run = await SqlAlchemyRunRepository(session).add(
            _run(project.id, tmp_path / "run", seeded_user.id)
        )
        finished = await _service(session, settings).execute(run)

    assert finished.status == RunStatus.failed
    assert finished.error == LLM_KEY_REQUIRED_MESSAGE
    assert captured_build_calls == []


# --- admin script --------------------------------------------------------------


@pytest.fixture
def script_env(session_factory, monkeypatch, enabled_settings: Settings):
    monkeypatch.setattr(users_script, "get_sessionmaker", lambda: session_factory)
    monkeypatch.setattr(users_script, "get_settings", lambda: enabled_settings)
    monkeypatch.setenv(users_script._LLM_KEY_ENV_VAR, SECRET)
    return enabled_settings


async def test_set_llm_key_script_stores_encrypted_key(
    script_env: Settings, session_factory, seeded_user: User, capsys
) -> None:
    await users_script._set_llm_key(seeded_user.email)
    out = capsys.readouterr().out
    assert SECRET not in out
    assert SECRET[-4:] in out
    async with session_factory() as session:
        stored = await SqlAlchemyUserRepository(session).get_by_id(seeded_user.id)
    assert stored.llm_api_key_last4 == SECRET[-4:]
    assert LlmKeyCipher.from_settings(script_env).decrypt(stored.llm_api_key_encrypted) == SECRET

    await users_script._list_users()
    listing = capsys.readouterr().out
    assert SECRET not in listing
    assert stored.llm_api_key_encrypted not in listing
    assert f"...{SECRET[-4:]}" in listing

    await users_script._clear_llm_key(seeded_user.email)
    async with session_factory() as session:
        cleared = await SqlAlchemyUserRepository(session).get_by_id(seeded_user.id)
    assert cleared.llm_api_key_encrypted is None


async def test_set_llm_key_script_exits_when_disabled_or_user_unknown(
    session_factory, monkeypatch, seeded_user: User, script_env: Settings
) -> None:
    with pytest.raises(SystemExit):
        await users_script._set_llm_key("nobody@example.com")
    monkeypatch.setattr(users_script, "get_settings", lambda: _settings())
    with pytest.raises(SystemExit):
        await users_script._set_llm_key(seeded_user.email)
    with pytest.raises(SystemExit):
        await users_script._clear_llm_key("nobody@example.com")


def test_script_parser_has_llm_key_subcommands() -> None:
    parser = users_script._build_parser()
    assert parser.parse_args(["set-llm-key", "--email", "a@b.c"]).command == "set-llm-key"
    assert parser.parse_args(["clear-llm-key", "--email", "a@b.c"]).command == "clear-llm-key"


# --- review round 1 -------------------------------------------------------------------


async def _second_project(session) -> Project:
    return await SqlAlchemyProjectRepository(session).add(_project())


async def test_concurrency_budget_is_split_across_the_users_running_runs(
    session_factory, tmp_path: Path, seeded_user: User, captured_build_calls
) -> None:
    settings = _enabled_settings(llm_user_key_concurrency=4)
    await _store_key(session_factory, seeded_user, settings)
    async with session_factory() as session:
        # One run already `running` in another project (`uq_runs_project_running` allows one per
        # project), started by the same user -> the new run gets 4 // 2 = 2.
        other = await _second_project(session)
        await SqlAlchemyRunRepository(session).add(
            _run(other.id, tmp_path / "other", seeded_user.id)
        )
        project = await _second_project(session)
        run = await SqlAlchemyRunRepository(session).add(
            _run(project.id, tmp_path / "run", seeded_user.id)
        )
        finished = await _service(session, settings).execute(run)

    assert finished.status == RunStatus.succeeded, finished.error
    (_kwargs, env), = captured_build_calls
    assert env["AUTOGENBOOK_CONCURRENCY"] == "2"


async def test_concurrency_budget_never_drops_below_one(
    session_factory, tmp_path: Path, seeded_user: User, captured_build_calls
) -> None:
    settings = _enabled_settings(llm_user_key_concurrency=2)
    await _store_key(session_factory, seeded_user, settings)
    async with session_factory() as session:
        for index in range(3):
            other = await _second_project(session)
            await SqlAlchemyRunRepository(session).add(
                _run(other.id, tmp_path / f"other{index}", seeded_user.id)
            )
        project = await _second_project(session)
        run = await SqlAlchemyRunRepository(session).add(
            _run(project.id, tmp_path / "run", seeded_user.id)
        )
        await _service(session, settings).execute(run)

    (_kwargs, env), = captured_build_calls
    assert env["AUTOGENBOOK_CONCURRENCY"] == "1"


async def test_other_users_running_runs_do_not_shrink_the_budget(
    session_factory, tmp_path: Path, seeded_user: User, seeded_user_2: User, captured_build_calls
) -> None:
    settings = _enabled_settings(llm_user_key_concurrency=4)
    await _store_key(session_factory, seeded_user, settings)
    async with session_factory() as session:
        other = await _second_project(session)
        await SqlAlchemyRunRepository(session).add(
            _run(other.id, tmp_path / "other", seeded_user_2.id)
        )
        project = await _second_project(session)
        run = await SqlAlchemyRunRepository(session).add(
            _run(project.id, tmp_path / "run", seeded_user.id)
        )
        await _service(session, settings).execute(run)

    (_kwargs, env), = captured_build_calls
    assert env["AUTOGENBOOK_CONCURRENCY"] == "4"


@pytest.mark.parametrize("kind", [RunKind.export, RunKind.regenerate_section])
async def test_worker_resolves_the_key_of_started_by_for_every_run_kind(
    session_factory, tmp_path: Path, seeded_user: User, seeded_user_2: User, captured_build_calls,
    kind: RunKind,
) -> None:
    # `started_by` (user 2) differs from anyone who owns the project: their key is the one used.
    settings = _enabled_settings(llm_key_policy="required")
    await _store_key(session_factory, seeded_user_2, settings, "sk-user-two-9999")
    work_dir = tmp_path / "run"
    (work_dir / "out").mkdir(parents=True)
    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_project())
        run = await SqlAlchemyRunRepository(session).add(
            _run(project.id, work_dir, seeded_user_2.id, kind=kind)
        )
        service = _service(session, settings)
        resolved = await service._resolve_user_llm_key(run)

    assert resolved is not None
    assert resolved[0] == "sk-user-two-9999"
    assert resolved[1] == "9999"


@pytest.mark.parametrize("kind", [RunKind.export, RunKind.regenerate_section, RunKind.full])
async def test_worker_fails_every_run_kind_without_a_key_under_required(
    session_factory, tmp_path: Path, seeded_user: User, captured_build_calls, kind: RunKind
) -> None:
    settings = _enabled_settings(llm_key_policy="required")
    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_project())
        run = await SqlAlchemyRunRepository(session).add(
            _run(project.id, tmp_path / "run", seeded_user.id, kind=kind)
        )
        finished = await _service(session, settings).execute(run)

    assert finished.status == RunStatus.failed
    assert finished.error == LLM_KEY_REQUIRED_MESSAGE
    assert captured_build_calls == []


async def test_worker_marks_run_failed_when_key_lookup_raises(
    session_factory, tmp_path: Path, seeded_user: User, captured_build_calls, monkeypatch
) -> None:
    settings = _enabled_settings()
    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_project())
        run = await SqlAlchemyRunRepository(session).add(
            _run(project.id, tmp_path / "run", seeded_user.id)
        )

        async def boom(self, user_id):
            raise RuntimeError("db went away")

        monkeypatch.setattr(SqlAlchemyUserRepository, "get_by_id", boom)
        finished = await _service(session, settings).execute(run)

    assert finished.status == RunStatus.failed
    assert finished.error == "db went away"


@pytest.mark.parametrize("policy", ["optional", "required"])
async def test_deactivated_user_counts_as_having_no_key(
    session_factory, tmp_path: Path, seeded_user: User, captured_build_calls, monkeypatch, policy: str
) -> None:
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-shared")
    settings = _enabled_settings(llm_key_policy=policy)
    await _store_key(session_factory, seeded_user, settings)
    async with session_factory() as session:
        await SqlAlchemyUserRepository(session).set_active(seeded_user.id, False)
        project = await SqlAlchemyProjectRepository(session).add(_project())
        run = await SqlAlchemyRunRepository(session).add(
            _run(project.id, tmp_path / "run", seeded_user.id)
        )
        finished = await _service(session, settings).execute(run)

    if policy == "required":
        assert finished.status == RunStatus.failed
        assert finished.error == LLM_KEY_REQUIRED_MESSAGE
    else:
        assert finished.status == RunStatus.succeeded, finished.error
        (_kwargs, env), = captured_build_calls
        assert env["OPENROUTER_API_KEY"] == "sk-shared"
        assert SECRET not in repr(env)


async def test_admission_refuses_a_deactivated_user_with_a_stored_key(
    session_factory, seeded_user: User
) -> None:
    from api.application.runs import RunService

    settings = _enabled_settings(llm_key_policy="required")
    await _store_key(session_factory, seeded_user, settings)
    async with session_factory() as session:
        service = RunService(
            run_repository=SqlAlchemyRunRepository(session),
            run_event_repository=SqlAlchemyRunEventRepository(session),
            project_repository=SqlAlchemyProjectRepository(session),
            run_artifact_repository=SqlAlchemyRunArtifactRepository(session),
            file_repository=SqlAlchemyFileRepository(session),
            outline_repository=SqlAlchemyOutlineRepository(session),
            settings=settings,
            user_repository=SqlAlchemyUserRepository(session),
        )
        assert await service._llm_key_missing(seeded_user.id) is False
        await SqlAlchemyUserRepository(session).set_active(seeded_user.id, False)
        assert await service._llm_key_missing(seeded_user.id) is True


async def test_every_queuing_endpoint_refuses_under_required_without_a_key(
    app, authed_client: AsyncClient, session_factory, file_storage, tmp_path: Path, seeded_user: User
) -> None:
    """create, regenerate, export and retry share `queue_admission_blocker`'s key rule."""
    base_settings = _settings(runs_dir=str(tmp_path))
    app.dependency_overrides[get_settings] = lambda: base_settings
    project = (await authed_client.post("/api/v1/projects", json=MINIMAL_PROJECT)).json()
    node = (
        await authed_client.post(
            f"/api/v1/projects/{project['id']}/outline", json={"title": "Chapter A", "targetPages": 2}
        )
    ).json()
    run = (
        await authed_client.post(f"/api/v1/projects/{project['id']}/runs", json={"outline": "project"})
    ).json()
    async with session_factory() as session:
        claimed = await SqlAlchemyRunQueue(session).claim("test-worker")
        assert claimed is not None
        service = _service(session, base_settings)
        finished = await service.execute(claimed)
    assert finished.status == RunStatus.succeeded, finished.error

    required = _enabled_settings(llm_key_policy="required", runs_dir=str(tmp_path))
    app.dependency_overrides[get_settings] = lambda: required

    def assert_refused(response) -> None:
        assert response.status_code == 409, response.text
        assert response.json()["code"] == "llm_key_required"

    assert_refused(
        await authed_client.post(f"/api/v1/projects/{project['id']}/runs", json={"outline": "project"})
    )
    assert_refused(
        await authed_client.post(
            f"/api/v1/projects/{project['id']}/outline/{node['id']}/regenerate", json={}
        )
    )
    assert_refused(await authed_client.post(f"/api/v1/runs/{run['id']}/exports", json={"format": "latex"}))

    # retry needs a failed/cancelled base run
    async with session_factory() as session:
        repo = SqlAlchemyRunRepository(session)
        stored = await repo.get(uuid.UUID(run["id"]))
        await repo.update(dataclasses.replace(stored, status=RunStatus.failed, error="killed"))
    assert_refused(await authed_client.post(f"/api/v1/runs/{run['id']}/retry"))

    # ...and with a stored key the same retry is admitted.
    assert (await authed_client.put("/api/v1/auth/me/llm-key", json={"apiKey": SECRET})).status_code == 200
    accepted = await authed_client.post(f"/api/v1/runs/{run['id']}/retry")
    assert accepted.status_code == 202, accepted.text


async def test_export_run_failing_at_key_resolution_uploads_no_artifacts(
    session_factory, tmp_path: Path, seeded_user: User
) -> None:
    # An export run shares its base run's work_dir; failing before the CLI starts must not
    # attach the base run's `out/` as this run's artifacts.
    settings = _enabled_settings(llm_key_policy="required")
    work_dir = tmp_path / "base"
    (work_dir / "out").mkdir(parents=True)
    (work_dir / "out" / "book.md").write_text("# base run output")
    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_project())
        run = await SqlAlchemyRunRepository(session).add(
            _run(project.id, work_dir, seeded_user.id, kind=RunKind.export)
        )
        finished = await _service(session, settings).execute(run)
        rows, total = await SqlAlchemyRunArtifactRepository(session).list(run.id, limit=100, offset=0)

    assert finished.status == RunStatus.failed
    assert finished.error == LLM_KEY_REQUIRED_MESSAGE
    assert total == 0 and rows == []
