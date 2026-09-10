"""Tests for `Run.options.llmModel` resolution (issue #128): a run's own `llmModel` request
option wins over the project's, and a run row persisted before this field existed is backfilled
from the project's current model (or the deployment default) on read rather than reporting
`null` on the wire.
"""

from __future__ import annotations

import dataclasses
import uuid
from datetime import datetime, timezone

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from api.core.settings import default_llm_model, get_settings
from api.domain.models import OutputFormat, Project, RunKind, RunOptions, RunStatus, TargetAudience
from api.infrastructure.db.models import RunRecord
from api.infrastructure.db.repositories import SqlAlchemyProjectRepository
from api.infrastructure.db.run_repository import SqlAlchemyRunRepository

MINIMAL_PROJECT = {
    "title": "Intro to Widgets",
    "subtitle": "A Practical Guide",
    "authors": ["Ada Lovelace"],
    "topic": "widgets",
}


async def _create_project(authed_client: AsyncClient, **overrides) -> dict:
    payload = {**MINIMAL_PROJECT, **overrides}
    response = await authed_client.post("/api/v1/projects", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def _make_project(**overrides) -> Project:
    now = datetime.now(timezone.utc)
    defaults = dict(
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
    defaults.update(overrides)
    return Project(**defaults)


async def test_create_run_without_llm_model_uses_the_projects_own_model(
    authed_client: AsyncClient,
) -> None:
    project = await _create_project(authed_client, llmModel="anthropic/claude-3.5-sonnet")

    response = await authed_client.post(f"/api/v1/projects/{project['id']}/runs", json={})

    assert response.status_code == 202, response.text
    assert response.json()["options"]["llmModel"] == "anthropic/claude-3.5-sonnet"


async def test_create_run_with_llm_model_overrides_the_projects_own_model(
    authed_client: AsyncClient,
) -> None:
    project = await _create_project(authed_client, llmModel="anthropic/claude-3.5-sonnet")

    response = await authed_client.post(
        f"/api/v1/projects/{project['id']}/runs", json={"llmModel": "openai/gpt-4o"}
    )

    assert response.status_code == 202, response.text
    body = response.json()
    assert body["options"]["llmModel"] == "openai/gpt-4o"

    # The override is the *run's* choice, not a change to the project - refetching the project
    # shows its own model untouched.
    project_after = await authed_client.get(f"/api/v1/projects/{project['id']}")
    assert project_after.json()["llmModel"] == "anthropic/claude-3.5-sonnet"


async def _seed_run_with_raw_options(
    session_factory: async_sessionmaker[AsyncSession], options: dict, *, project: Project
) -> tuple[uuid.UUID, uuid.UUID]:
    """Inserts a `runs` row whose `options` column is exactly the given raw dict - simulating a
    row written before `RunOptions.llm_model` existed."""
    async with session_factory() as session:
        added_project = await SqlAlchemyProjectRepository(session).add(project)
        run_id = uuid.uuid4()
        now = datetime.now(timezone.utc)
        session.add(
            RunRecord(
                id=run_id,
                project_id=added_project.id,
                kind=RunKind.full,
                status=RunStatus.succeeded,
                options=options,
                work_dir=f"/app/runs/{run_id}",
                queued_at=now,
            )
        )
        await session.commit()
    return run_id, added_project.id


async def test_legacy_run_without_llm_model_is_backfilled_from_its_project(
    session_factory: async_sessionmaker[AsyncSession], authed_client: AsyncClient
) -> None:
    stored = dataclasses.asdict(RunOptions(outline="project"))
    del stored["llm_model"]
    project = _make_project(llm_model="mistral/mistral-large")

    run_id, project_id = await _seed_run_with_raw_options(session_factory, stored, project=project)

    response = await authed_client.get(f"/api/v1/runs/{run_id}")
    assert response.status_code == 200, response.text
    assert response.json()["options"]["llmModel"] == "mistral/mistral-large"

    listed = await authed_client.get(f"/api/v1/projects/{project_id}/runs")
    assert listed.status_code == 200, listed.text
    assert listed.json()["items"][0]["options"]["llmModel"] == "mistral/mistral-large"


async def test_legacy_run_falls_back_to_deployment_default_if_its_project_is_gone(
    session_factory: async_sessionmaker[AsyncSession], authed_client: AsyncClient
) -> None:
    stored = dataclasses.asdict(RunOptions(outline="project"))
    del stored["llm_model"]
    project = _make_project(llm_model="mistral/mistral-large")

    run_id, project_id = await _seed_run_with_raw_options(session_factory, stored, project=project)

    # Soft-deleted (never a hard `DELETE` - `ProjectService.delete`/issue #57): the row still
    # physically exists (satisfying the run's FK), but `ProjectRepository.get` now reports it
    # gone, same as a project a client can no longer reach through the API.
    async with session_factory() as session:
        await SqlAlchemyProjectRepository(session).delete(project_id)

    response = await authed_client.get(f"/api/v1/runs/{run_id}")
    assert response.status_code == 200, response.text
    assert response.json()["options"]["llmModel"] == default_llm_model(get_settings())
