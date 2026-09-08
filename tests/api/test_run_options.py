"""Regression tests for issue #60:
- `RunOptions` deserialization tolerates stored `options` JSON that doesn't
  exactly match the current dataclass shape (missing new fields, extra/
  removed old ones) instead of raising `TypeError`.
- `RunOptionsIn` no longer lets a client set `resume`/`exportTexOnly`/
  `rebuildKb` on a fresh `full` run.
- `allowSubdivision`'s default is the same on both `RunOptionsIn` and the
  `RunOptions` domain dataclass it feeds.
"""

from __future__ import annotations

import dataclasses
import uuid
from datetime import datetime, timezone

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

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


async def _create_project(client: AsyncClient, **overrides) -> dict:
    payload = {**MINIMAL_PROJECT, **overrides}
    response = await client.post("/api/v1/projects", json=payload)
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
        last_run_id=None,
        created_at=now,
        updated_at=now,
    )
    defaults.update(overrides)
    return Project(**defaults)


async def _seed_run_with_raw_options(
    session_factory: async_sessionmaker[AsyncSession], options: dict
) -> uuid.UUID:
    """Insert a `runs` row whose `options` column is exactly the given raw
    dict, bypassing the `RunOptions` dataclass entirely - simulating a row
    written back when the dataclass had a different shape."""
    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_make_project())
        run_id = uuid.uuid4()
        now = datetime.now(timezone.utc)
        session.add(
            RunRecord(
                id=run_id,
                project_id=project.id,
                kind=RunKind.full,
                status=RunStatus.queued,
                options=options,
                work_dir=f"/app/runs/{run_id}",
                queued_at=now,
            )
        )
        await session.commit()
    return run_id


async def test_deserializing_options_missing_a_new_field_falls_back_to_dataclass_default(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    # Simulates a row written before `fail_fast_schema` existed on
    # `RunOptions` - the stored blob simply doesn't have the key.
    stored = dataclasses.asdict(RunOptions(outline="project"))
    del stored["fail_fast_schema"]

    run_id = await _seed_run_with_raw_options(session_factory, stored)

    async with session_factory() as session:
        run = await SqlAlchemyRunRepository(session).get(run_id)

    assert run is not None
    assert run.options.fail_fast_schema is RunOptions.fail_fast_schema  # dataclass default


async def test_deserializing_options_with_unknown_key_is_ignored(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    # Simulates a row written by an older `RunOptions` that had a field
    # since removed/renamed.
    stored = dataclasses.asdict(RunOptions(outline="project"))
    stored["some_removed_field"] = "whatever"

    run_id = await _seed_run_with_raw_options(session_factory, stored)

    async with session_factory() as session:
        run = await SqlAlchemyRunRepository(session).get(run_id)

    assert run is not None
    assert run.options.outline == "project"
    assert not hasattr(run.options, "some_removed_field")


async def test_create_run_rejects_internal_only_options(client: AsyncClient) -> None:
    project = await _create_project(client)

    response = await client.post(
        f"/api/v1/projects/{project['id']}/runs",
        json={"resume": True, "exportTexOnly": True, "rebuildKb": True},
    )

    # `RunOptionsIn` has `extra="forbid"` - these fields no longer exist on
    # the public schema at all, so a client that sends them gets a
    # validation error rather than having them silently stored.
    assert response.status_code == 422, response.text


async def test_create_run_default_allow_subdivision_matches_domain_default(
    client: AsyncClient,
) -> None:
    project = await _create_project(client)

    response = await client.post(f"/api/v1/projects/{project['id']}/runs", json={})
    assert response.status_code == 202, response.text

    body = response.json()
    assert body["options"]["allowSubdivision"] is RunOptions.allow_subdivision
