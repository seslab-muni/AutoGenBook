from __future__ import annotations

import asyncio
import dataclasses
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
        llm_model="openai/gpt-5-mini",
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
        target_node_previous_status=None,
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


async def test_claim_returns_none_if_the_claimed_row_vanishes_before_reread(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression for issue #62: the re-fetch right after a successful
    claiming `UPDATE` used to `assert record is not None`. That row
    disappearing there should be unreachable (the `UPDATE` just wrote it in
    this same transaction), but `claim` runs in the worker loop, not behind
    an HTTP router with an exception handler to turn an `AssertionError`
    into a clean response - it must fall back to the same `None` "nothing
    claimed" sentinel the caller already handles for every other failed
    claim, not crash the whole worker slot."""
    async with session_factory() as session:
        project_id = await _seed_project(session)
        await SqlAlchemyRunRepository(session).add(_run(project_id))
        queue = SqlAlchemyRunQueue(session)

        async def _vanished(*args, **kwargs):
            return None

        monkeypatch.setattr(session, "get", _vanished)

        claimed = await queue.claim("worker-1")

    assert claimed is None


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
        ok = await queue.heartbeat(run.id, "worker-1")
        refreshed = await repo.get(run.id)

    assert ok is True
    assert refreshed is not None
    assert refreshed.heartbeat_at is not None
    assert refreshed.heartbeat_at >= first_heartbeat


async def test_heartbeat_without_worker_id_is_unconditional_while_running(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Backward-compatible fallback for callers that don't track a lease at
    all (`GenerationService` driven directly against an unclaimed run, as
    most of `tests/api/test_generation_service.py` does)."""
    async with session_factory() as session:
        project_id = await _seed_project(session)
        repo = SqlAlchemyRunRepository(session)
        run = await repo.add(_run(project_id))
        queue = SqlAlchemyRunQueue(session)
        await queue.claim("worker-1")

        ok = await queue.heartbeat(run.id)

    assert ok is True


async def test_heartbeat_rejects_a_worker_that_lost_its_lease(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Regression for issue #52: once `requeue_stale` reassigns a run to a
    second worker, the first worker's heartbeat must be rejected (compare-
    and-set on `locked_by`), not silently accepted - accepting it is
    exactly what let the first worker keep "renewing" a lease it no longer
    held while two CLI subprocesses ran against the same work directory."""
    async with session_factory() as session:
        project_id = await _seed_project(session)
        repo = SqlAlchemyRunRepository(session)
        run = await repo.add(_run(project_id))
        queue = SqlAlchemyRunQueue(session)
        await queue.claim("worker-1")

        stale = await repo.get(run.id)
        assert stale is not None
        stale.heartbeat_at = datetime.now(timezone.utc) - timedelta(seconds=600)
        await repo.update(stale)
        requeued = await queue.requeue_stale(older_than_s=300)
        assert requeued == 1
        second_claim = await queue.claim("worker-2")
        assert second_claim is not None

        # worker-1 (the original owner) tries to renew a lease that no
        # longer belongs to it.
        ok = await queue.heartbeat(run.id, "worker-1")
        refreshed = await repo.get(run.id)

    assert ok is False
    assert refreshed is not None
    assert refreshed.locked_by == "worker-2"


async def test_release_requeues_a_running_run(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        project_id = await _seed_project(session)
        repo = SqlAlchemyRunRepository(session)
        run = await repo.add(_run(project_id))
        queue = SqlAlchemyRunQueue(session)
        await queue.claim("worker-1")

        released = await queue.release(run.id, "worker-1")
        refreshed = await repo.get(run.id)

    assert released is True
    assert refreshed is not None
    assert refreshed.status == RunStatus.queued
    assert refreshed.locked_by is None
    assert refreshed.started_at is None


async def test_release_is_a_noop_for_the_wrong_worker(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Regression for issue #52: `release` (like `heartbeat`) must be a
    compare-and-set on `locked_by`, not an unconditional write - a worker
    that already lost its lease (e.g. `requeue_stale` reassigned the run to
    someone else while it was still finishing up) must not be able to hand
    a *different* worker's now-in-progress run back to `queued` out from
    under it."""
    async with session_factory() as session:
        project_id = await _seed_project(session)
        repo = SqlAlchemyRunRepository(session)
        run = await repo.add(_run(project_id))
        queue = SqlAlchemyRunQueue(session)
        await queue.claim("worker-1")

        released = await queue.release(run.id, "some-other-worker")
        refreshed = await repo.get(run.id)

    assert released is False
    assert refreshed is not None
    assert refreshed.status == RunStatus.running
    assert refreshed.locked_by == "worker-1"


async def test_release_options_flips_resume_for_a_reclaimed_full_run(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        project_id = await _seed_project(session)
        repo = SqlAlchemyRunRepository(session)
        run = await repo.add(_run(project_id))
        queue = SqlAlchemyRunQueue(session)
        await queue.claim("worker-1")

        resumed_options = dataclasses.asdict(dataclasses.replace(run.options, resume=True))
        await queue.release(run.id, "worker-1", options=resumed_options)
        refreshed = await repo.get(run.id)

    assert refreshed is not None
    assert refreshed.options.resume is True


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


async def test_requeue_stale_flips_resume_for_a_full_run_with_a_structure_graph(
    session_factory: async_sessionmaker[AsyncSession], tmp_path
) -> None:
    """Regression for issue #52: a `full` run stale-requeued after the CLI
    already got far enough to write `out/structure_graph.json` should
    resume from it on retry, not regenerate (and pay for) every section
    from scratch."""
    work_dir = tmp_path / "run"
    out_dir = work_dir / "out"
    out_dir.mkdir(parents=True)
    (out_dir / "structure_graph.json").write_text("{}", encoding="utf-8")

    async with session_factory() as session:
        project_id = await _seed_project(session)
        repo = SqlAlchemyRunRepository(session)
        queue = SqlAlchemyRunQueue(session)
        run = await repo.add(
            _run(project_id, queued_at=datetime.now(timezone.utc) - timedelta(minutes=5))
        )
        run = await repo.update(dataclasses.replace(run, work_dir=str(work_dir)))
        await queue.claim("worker-1")

        claimed = await repo.get(run.id)
        assert claimed is not None
        claimed.heartbeat_at = datetime.now(timezone.utc) - timedelta(seconds=600)
        await repo.update(claimed)

        requeued = await queue.requeue_stale(older_than_s=300)
        refreshed = await repo.get(run.id)

    assert requeued == 1
    assert refreshed is not None
    assert refreshed.status == RunStatus.queued
    assert refreshed.options.resume is True


async def test_requeue_stale_does_not_flip_resume_without_a_structure_graph(
    session_factory: async_sessionmaker[AsyncSession], tmp_path
) -> None:
    work_dir = tmp_path / "run-without-graph"

    async with session_factory() as session:
        project_id = await _seed_project(session)
        repo = SqlAlchemyRunRepository(session)
        queue = SqlAlchemyRunQueue(session)
        run = await repo.add(
            _run(project_id, queued_at=datetime.now(timezone.utc) - timedelta(minutes=5))
        )
        run = await repo.update(dataclasses.replace(run, work_dir=str(work_dir)))
        await queue.claim("worker-1")

        claimed = await repo.get(run.id)
        assert claimed is not None
        claimed.heartbeat_at = datetime.now(timezone.utc) - timedelta(seconds=600)
        await repo.update(claimed)

        await queue.requeue_stale(older_than_s=300)
        refreshed = await repo.get(run.id)

    assert refreshed is not None
    assert refreshed.options.resume is False


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
