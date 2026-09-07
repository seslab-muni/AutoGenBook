from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from api.domain.models import OutputFormat, Project, Run, RunKind, RunOptions, RunStatus, TargetAudience
from api.infrastructure.db.repositories import SqlAlchemyProjectRepository
from api.infrastructure.db.run_repository import SqlAlchemyRunRepository
from api.infrastructure.queue.postgres import SqlAlchemyRunQueue

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL", "sqlite+aiosqlite://")
requires_postgres = pytest.mark.skipif(
    not TEST_DATABASE_URL.startswith("postgresql"),
    reason="two-worker claim race safety only holds under Postgres FOR UPDATE SKIP LOCKED",
)


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


def _run(project_id: uuid.UUID, *, queued_at: datetime | None = None) -> Run:
    now = queued_at or datetime.now(timezone.utc)
    return Run(
        id=uuid.uuid4(),
        project_id=project_id,
        kind=RunKind.full,
        status=RunStatus.queued,
        options=RunOptions(outline="project"),
        base_run_id=None,
        target_node_id=None,
        work_dir=f"/app/runs/{uuid.uuid4()}",
        exit_code=None,
        error=None,
        cancel_requested=False,
        locked_by=None,
        heartbeat_at=None,
        queued_at=now,
        started_at=None,
        finished_at=None,
        total_tokens=None,
        total_cost_usd=None,
    )


async def _seed_project(session: AsyncSession) -> uuid.UUID:
    project = await SqlAlchemyProjectRepository(session).add(_make_project())
    return project.id


async def test_claim_returns_none_when_no_queued_runs(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        claimed = await SqlAlchemyRunQueue(session).claim("worker-1")
    assert claimed is None


async def test_claim_returns_oldest_queued_run_and_marks_running(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    # Two different projects: a project can only ever have one active
    # (queued/running) run at a time (`uq_runs_project_active`), so claim
    # ordering across queued runs can only be exercised across projects.
    async with session_factory() as session:
        older_project_id = await _seed_project(session)
        newer_project_id = await _seed_project(session)
        repo = SqlAlchemyRunRepository(session)
        older = await repo.add(
            _run(older_project_id, queued_at=datetime.now(timezone.utc) - timedelta(minutes=5))
        )
        await repo.add(_run(newer_project_id))

        claimed = await SqlAlchemyRunQueue(session).claim("worker-1")

    assert claimed is not None
    assert claimed.id == older.id
    assert claimed.status == RunStatus.running
    assert claimed.locked_by == "worker-1"
    assert claimed.started_at is not None
    assert claimed.heartbeat_at is not None


async def test_claim_does_not_reclaim_a_running_run(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        project_id = await _seed_project(session)
        await SqlAlchemyRunRepository(session).add(_run(project_id))
        queue = SqlAlchemyRunQueue(session)
        first = await queue.claim("worker-1")
        second = await queue.claim("worker-2")

    assert first is not None
    assert second is None


async def test_heartbeat_updates_heartbeat_at(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        project_id = await _seed_project(session)
        repo = SqlAlchemyRunRepository(session)
        run = await repo.add(_run(project_id))
        queue = SqlAlchemyRunQueue(session)
        claimed = await queue.claim("worker-1")
        assert claimed is not None
        first_heartbeat = claimed.heartbeat_at

        await asyncio.sleep(0.01)
        await queue.heartbeat(run.id)
        refreshed = await repo.get(run.id)

    assert refreshed is not None
    assert refreshed.heartbeat_at is not None
    assert refreshed.heartbeat_at >= first_heartbeat


async def test_release_requeues_a_running_run(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        project_id = await _seed_project(session)
        repo = SqlAlchemyRunRepository(session)
        run = await repo.add(_run(project_id))
        queue = SqlAlchemyRunQueue(session)
        await queue.claim("worker-1")

        await queue.release(run.id)
        refreshed = await repo.get(run.id)

    assert refreshed is not None
    assert refreshed.status == RunStatus.queued
    assert refreshed.locked_by is None
    assert refreshed.started_at is None


async def test_requeue_stale_only_touches_old_heartbeats(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    # Two different projects, for the same reason as the claim-ordering
    # test above: `uq_runs_project_active` allows only one queued/running
    # run per project.
    async with session_factory() as session:
        stale_project_id = await _seed_project(session)
        fresh_project_id = await _seed_project(session)
        repo = SqlAlchemyRunRepository(session)
        queue = SqlAlchemyRunQueue(session)

        stale = await repo.add(_run(stale_project_id))
        fresh = await repo.add(_run(fresh_project_id))
        stale_claimed = await queue.claim("worker-1")
        fresh_claimed = await queue.claim("worker-2")
        assert stale_claimed is not None and fresh_claimed is not None

        # Push the first run's heartbeat far into the past to simulate a
        # worker that died without ever calling `release`.
        stale_claimed.heartbeat_at = datetime.now(timezone.utc) - timedelta(seconds=600)
        await repo.update(stale_claimed)

        requeued_count = await queue.requeue_stale(older_than_s=300)

        stale_after = await repo.get(stale.id)
        fresh_after = await repo.get(fresh.id)

    assert requeued_count == 1
    assert stale_after is not None and stale_after.status == RunStatus.queued
    assert fresh_after is not None and fresh_after.status == RunStatus.running


@requires_postgres
async def test_two_concurrent_workers_never_claim_the_same_run(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        repo = SqlAlchemyRunRepository(session)
        for _ in range(10):
            await repo.add(_run(await _seed_project(session)))

    async def claim_all(worker_id: str) -> list[uuid.UUID]:
        claimed_ids: list[uuid.UUID] = []
        async with session_factory() as session:
            queue = SqlAlchemyRunQueue(session)
            while True:
                run = await queue.claim(worker_id)
                if run is None:
                    return claimed_ids
                claimed_ids.append(run.id)

    results = await asyncio.gather(claim_all("worker-a"), claim_all("worker-b"))
    all_claimed = results[0] + results[1]
    assert len(all_claimed) == 10
    assert len(set(all_claimed)) == 10
