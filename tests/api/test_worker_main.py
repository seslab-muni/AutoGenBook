"""Unit tests for the worker loop (`api/worker/__main__.py`), which had zero
coverage (issue #71). These mock every repository/service the loop touches
(a fake run queue, a fake `GenerationService`) rather than exercising a real
database or CLI subprocess - `tests/api/test_generation_service.py` already
covers `GenerationService.execute` itself end to end against a fake CLI.
"""

from __future__ import annotations

import asyncio
import os
import signal
import uuid
from datetime import datetime, timezone

import pytest

import api.worker.__main__ as worker_main
from api.core.settings import Settings
from api.domain.models import Run, RunKind, RunOptions, RunStatus


def _settings(**overrides) -> Settings:
    defaults = dict(
        worker_concurrency=1,
        worker_poll_interval_s=0.01,
        worker_stale_s=300,
        runs_retention_days=30,
    )
    defaults.update(overrides)
    return Settings(**defaults)


def _make_run(**overrides) -> Run:
    now = datetime.now(timezone.utc)
    defaults = dict(
        id=uuid.uuid4(),
        project_id=uuid.uuid4(),
        kind=RunKind.full,
        status=RunStatus.running,
        options=RunOptions(outline="generate"),
        base_run_id=None,
        target_node_id=None,
        target_node_previous_status=None,
        work_dir="/tmp/run",
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
    )
    defaults.update(overrides)
    return Run(**defaults)


class _FakeDialect:
    def __init__(self, name: str) -> None:
        self.name = name


class _FakeBind:
    def __init__(self, dialect_name: str) -> None:
        self.dialect = _FakeDialect(dialect_name)


class _FakeSession:
    """Stands in for an `AsyncSession`: the repositories the worker
    constructs around it (`SqlAlchemyRunRepository(session)`, etc.) just
    store the reference without touching it, since `GenerationService`
    itself is monkeypatched out in every test below. `dialect_name`
    defaults to `sqlite` so `_run_housekeeping_sweeps`'s advisory-lock path
    (Postgres-only) is a no-op here, matching every other test's
    expectation that the sweeps just run unconditionally; tests of the
    lock itself pass `dialect_name="postgresql"` and stub `scalar`/
    `execute`/`commit` explicitly."""

    def __init__(self, dialect_name: str = "sqlite") -> None:
        self.bind = _FakeBind(dialect_name)

    async def __aenter__(self) -> "_FakeSession":
        return self

    async def __aexit__(self, *exc_info: object) -> bool:
        return False

    async def scalar(self, *args, **kwargs):  # pragma: no cover - overridden where needed
        raise AssertionError("scalar() should not be called for a non-postgres session")

    async def execute(self, *args, **kwargs):  # pragma: no cover - overridden where needed
        raise AssertionError("execute() should not be called for a non-postgres session")

    async def commit(self) -> None:  # pragma: no cover - overridden where needed
        pass


def _fake_session_factory() -> _FakeSession:
    return _FakeSession()


class _FakeRunQueue:
    def __init__(self, claim_return: Run | None = None, requeue_return: int = 0) -> None:
        self.claim_return = claim_return
        self.requeue_return = requeue_return
        self.requeue_exception: Exception | None = None
        self.claim_calls: list[str] = []
        self.requeue_calls: list[float] = []

    async def claim(self, worker_id: str) -> Run | None:
        self.claim_calls.append(worker_id)
        return self.claim_return

    async def requeue_stale(self, older_than_s: float) -> int:
        self.requeue_calls.append(older_than_s)
        if self.requeue_exception is not None:
            raise self.requeue_exception
        return self.requeue_return


class _FakeGenerationService:
    def __init__(
        self, execute_result: Run | None = None, execute_exception: Exception | None = None
    ) -> None:
        self.execute_result = execute_result
        self.execute_exception = execute_exception
        self.executed_runs: list[Run] = []
        self.shutdown_events: list = []

    async def execute(self, run: Run, *, shutdown_event=None) -> Run:
        self.executed_runs.append(run)
        self.shutdown_events.append(shutdown_event)
        if self.execute_exception is not None:
            raise self.execute_exception
        return self.execute_result if self.execute_result is not None else run


def _patch_queue(monkeypatch: pytest.MonkeyPatch, fake_queue: _FakeRunQueue) -> None:
    monkeypatch.setattr(worker_main, "SqlAlchemyRunQueue", lambda session: fake_queue)


def _patch_service(monkeypatch: pytest.MonkeyPatch, fake_service: _FakeGenerationService) -> None:
    monkeypatch.setattr(worker_main, "GenerationService", lambda **kwargs: fake_service)


# --------------------------------------------------------------------------
# _claim_and_execute
# --------------------------------------------------------------------------


async def test_claim_and_execute_returns_false_when_queue_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_queue = _FakeRunQueue(claim_return=None)
    fake_service = _FakeGenerationService()
    _patch_queue(monkeypatch, fake_queue)
    _patch_service(monkeypatch, fake_service)

    claimed = await worker_main._claim_and_execute(
        _fake_session_factory, storage=None, settings=_settings(), worker_id="w:0"
    )

    assert claimed is False
    assert fake_queue.claim_calls == ["w:0"]
    assert fake_service.executed_runs == []


async def test_claim_and_execute_runs_service_and_returns_true(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run = _make_run()
    fake_queue = _FakeRunQueue(claim_return=run)
    fake_service = _FakeGenerationService(execute_result=_make_run(status=RunStatus.succeeded))
    _patch_queue(monkeypatch, fake_queue)
    _patch_service(monkeypatch, fake_service)

    claimed = await worker_main._claim_and_execute(
        _fake_session_factory, storage=None, settings=_settings(), worker_id="w:0"
    )

    assert claimed is True
    assert fake_service.executed_runs == [run]


async def test_claim_and_execute_passes_stop_event_through_as_shutdown_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression for issue #52: `execute` needs the slot's `stop_event` to
    tear an in-flight CLI subprocess down promptly on SIGTERM instead of
    blocking the whole slot until the run finishes on its own - which
    means `_claim_and_execute` must actually forward it."""
    run = _make_run()
    fake_queue = _FakeRunQueue(claim_return=run)
    fake_service = _FakeGenerationService(execute_result=_make_run(status=RunStatus.succeeded))
    _patch_queue(monkeypatch, fake_queue)
    _patch_service(monkeypatch, fake_service)

    stop_event = asyncio.Event()

    claimed = await worker_main._claim_and_execute(
        _fake_session_factory, storage=None, settings=_settings(), worker_id="w:0",
        stop_event=stop_event,
    )

    assert claimed is True
    assert fake_service.shutdown_events == [stop_event]


async def test_claim_and_execute_swallows_service_exception_but_still_returns_true(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run = _make_run()
    fake_queue = _FakeRunQueue(claim_return=run)
    fake_service = _FakeGenerationService(execute_exception=RuntimeError("boom"))
    _patch_queue(monkeypatch, fake_queue)
    _patch_service(monkeypatch, fake_service)

    # A run was claimed (and would otherwise be stuck locked-but-unattended)
    # even though `execute` blew up, so the slot must not raise - it keeps
    # polling for the next run instead of dying.
    claimed = await worker_main._claim_and_execute(
        _fake_session_factory, storage=None, settings=_settings(), worker_id="w:0"
    )

    assert claimed is True
    assert fake_service.executed_runs == [run]


# --------------------------------------------------------------------------
# _worker_slot
# --------------------------------------------------------------------------


async def test_worker_slot_stops_immediately_when_stop_event_already_set(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = []

    async def _fake_claim_and_execute(*args, **kwargs):
        calls.append(1)
        return False

    monkeypatch.setattr(worker_main, "_claim_and_execute", _fake_claim_and_execute)
    stop_event = asyncio.Event()
    stop_event.set()

    await worker_main._worker_slot(0, _fake_session_factory, None, _settings(), stop_event)

    assert calls == []


async def test_worker_slot_zero_sweeps_stale_runs_and_work_dirs_when_idle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_queue = _FakeRunQueue(claim_return=None, requeue_return=2)
    _patch_queue(monkeypatch, fake_queue)

    sweep_calls: list[float] = []

    async def _fake_sweep(run_repository, retention_days):
        sweep_calls.append(retention_days)
        return 1

    monkeypatch.setattr(worker_main, "sweep_stale_work_dirs", _fake_sweep)

    stop_event = asyncio.Event()

    async def _fake_claim_and_execute(*args, **kwargs):
        # Nothing queued this cycle, and stop right after so the slot's
        # `while` loop only runs once.
        stop_event.set()
        return False

    monkeypatch.setattr(worker_main, "_claim_and_execute", _fake_claim_and_execute)

    await worker_main._worker_slot(0, _fake_session_factory, None, _settings(), stop_event)

    assert fake_queue.requeue_calls == [300]
    assert sweep_calls == [30]


async def test_worker_slot_zero_sweeps_orphaned_work_dirs_when_idle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """issue #57: the orphan-work-dir sweep (finds directories under
    `RUNS_DIR` no `runs` row references at all, regardless of status) runs
    on the same idle cycle as `sweep_stale_work_dirs`, on slot 0 only."""
    fake_queue = _FakeRunQueue(claim_return=None)
    _patch_queue(monkeypatch, fake_queue)

    orphan_calls: list[str] = []

    async def _fake_orphan_sweep(run_repository, runs_dir):
        orphan_calls.append(runs_dir)
        return 1

    monkeypatch.setattr(worker_main, "sweep_orphaned_work_dirs", _fake_orphan_sweep)

    stop_event = asyncio.Event()

    async def _fake_claim_and_execute(*args, **kwargs):
        stop_event.set()
        return False

    monkeypatch.setattr(worker_main, "_claim_and_execute", _fake_claim_and_execute)

    await worker_main._worker_slot(
        0, _fake_session_factory, None, _settings(runs_dir="/app/runs"), stop_event
    )

    assert orphan_calls == ["/app/runs"]


async def test_worker_slot_nonzero_never_sweeps(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_queue = _FakeRunQueue(claim_return=None)
    _patch_queue(monkeypatch, fake_queue)

    async def _fail_if_called(*args, **kwargs):
        raise AssertionError("sweep_stale_work_dirs must only run on slot 0")

    monkeypatch.setattr(worker_main, "sweep_stale_work_dirs", _fail_if_called)

    async def _fail_if_orphan_sweep_called(*args, **kwargs):
        raise AssertionError("sweep_orphaned_work_dirs must only run on slot 0")

    monkeypatch.setattr(worker_main, "sweep_orphaned_work_dirs", _fail_if_orphan_sweep_called)

    stop_event = asyncio.Event()

    async def _fake_claim_and_execute(*args, **kwargs):
        stop_event.set()
        return False

    monkeypatch.setattr(worker_main, "_claim_and_execute", _fake_claim_and_execute)

    # Slot 1 (not the designated sweeper slot 0).
    await worker_main._worker_slot(1, _fake_session_factory, None, _settings(), stop_event)

    assert fake_queue.requeue_calls == []


class _FakePostgresSession(_FakeSession):
    """Like `_FakeSession`, but reports `dialect.name == "postgresql"` and
    records the advisory-lock `scalar`/`execute`/`commit` calls
    `_run_housekeeping_sweeps` makes around the sweep block, so tests can
    assert the lock was actually taken/released without a real Postgres."""

    def __init__(self, *, lock_acquired: bool) -> None:
        super().__init__(dialect_name="postgresql")
        self.lock_acquired = lock_acquired
        self.scalar_calls: list[str] = []
        self.execute_calls: list[str] = []
        self.commit_calls = 0

    async def scalar(self, stmt, params=None):
        self.scalar_calls.append(str(stmt))
        return self.lock_acquired

    async def execute(self, stmt, params=None):
        self.execute_calls.append(str(stmt))

    async def commit(self) -> None:
        self.commit_calls += 1


async def test_housekeeping_sweeps_skip_when_advisory_lock_not_acquired(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Issue #134 phase 3: another replica already holds the housekeeping
    lock this cycle - this replica must not touch the DB/filesystem at
    all, not even attempt the unlock (it never acquired anything to
    release)."""
    fake_queue = _FakeRunQueue(claim_return=None, requeue_return=5)
    _patch_queue(monkeypatch, fake_queue)

    async def _fail_if_called(*args, **kwargs):
        raise AssertionError("sweeps must not run when another replica holds the lock")

    monkeypatch.setattr(worker_main, "sweep_stale_work_dirs", _fail_if_called)
    monkeypatch.setattr(worker_main, "sweep_orphaned_work_dirs", _fail_if_called)

    pg_session = _FakePostgresSession(lock_acquired=False)

    await worker_main._run_housekeeping_sweeps(0, lambda: pg_session, _settings())

    assert fake_queue.requeue_calls == []
    assert pg_session.scalar_calls == ["SELECT pg_try_advisory_lock(:key)"]
    assert pg_session.execute_calls == []
    assert pg_session.commit_calls == 0


async def test_housekeeping_sweeps_run_and_unlock_when_lock_acquired(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_queue = _FakeRunQueue(claim_return=None, requeue_return=3)
    _patch_queue(monkeypatch, fake_queue)

    stale_calls: list[float] = []
    orphan_calls: list[str] = []

    async def _fake_stale_sweep(run_repository, retention_days):
        stale_calls.append(retention_days)
        return 0

    async def _fake_orphan_sweep(run_repository, runs_dir):
        orphan_calls.append(runs_dir)
        return 0

    monkeypatch.setattr(worker_main, "sweep_stale_work_dirs", _fake_stale_sweep)
    monkeypatch.setattr(worker_main, "sweep_orphaned_work_dirs", _fake_orphan_sweep)

    pg_session = _FakePostgresSession(lock_acquired=True)

    await worker_main._run_housekeeping_sweeps(0, lambda: pg_session, _settings())

    assert fake_queue.requeue_calls == [300]
    assert stale_calls == [30]
    assert orphan_calls == ["/app/runs"]
    assert pg_session.execute_calls == ["SELECT pg_advisory_unlock(:key)"]
    assert pg_session.commit_calls == 1


async def test_worker_slot_survives_requeue_stale_exception(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_queue = _FakeRunQueue(claim_return=None)
    fake_queue.requeue_exception = RuntimeError("db hiccup")
    _patch_queue(monkeypatch, fake_queue)

    sweep_calls: list[int] = []

    async def _fake_sweep(run_repository, retention_days):
        sweep_calls.append(1)
        return 0

    monkeypatch.setattr(worker_main, "sweep_stale_work_dirs", _fake_sweep)

    stop_event = asyncio.Event()

    async def _fake_claim_and_execute(*args, **kwargs):
        stop_event.set()
        return False

    monkeypatch.setattr(worker_main, "_claim_and_execute", _fake_claim_and_execute)

    # Must not raise even though `requeue_stale` blew up - and the work-dir
    # sweep (a separate try/except in `_worker_slot`) still runs afterward.
    await worker_main._worker_slot(0, _fake_session_factory, None, _settings(), stop_event)

    assert sweep_calls == [1]


async def test_worker_slot_claims_repeatedly_until_stop_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_queue = _FakeRunQueue(claim_return=None)
    _patch_queue(monkeypatch, fake_queue)

    async def _fail_if_called(*args, **kwargs):
        raise AssertionError("sweep_stale_work_dirs should never run: claimed=True every cycle")

    monkeypatch.setattr(worker_main, "sweep_stale_work_dirs", _fail_if_called)

    stop_event = asyncio.Event()
    call_count = 0

    async def _fake_claim_and_execute(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count >= 3:
            stop_event.set()
        return True  # claimed a run each time -> no stale sweep in between

    monkeypatch.setattr(worker_main, "_claim_and_execute", _fake_claim_and_execute)

    await worker_main._worker_slot(0, _fake_session_factory, None, _settings(), stop_event)

    assert call_count == 3
    # `claimed=True` every cycle, so the slot-0 sweep never had a reason to run.
    assert fake_queue.requeue_calls == []


# --------------------------------------------------------------------------
# signal handling (`main()`)
# --------------------------------------------------------------------------


@pytest.mark.skipif(os.name != "posix", reason="signal handlers are POSIX-only here")
async def test_main_stops_gracefully_on_sigterm(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_queue = _FakeRunQueue(claim_return=None)
    _patch_queue(monkeypatch, fake_queue)

    async def _fake_sweep(*args, **kwargs):
        return 0

    monkeypatch.setattr(worker_main, "sweep_stale_work_dirs", _fake_sweep)
    monkeypatch.setattr(worker_main, "get_settings", lambda: _settings(worker_concurrency=2))
    monkeypatch.setattr(worker_main, "get_sessionmaker", lambda: _fake_session_factory)
    monkeypatch.setattr(worker_main, "S3FileStorage", lambda settings: None)

    main_task = asyncio.create_task(worker_main.main())
    await asyncio.sleep(0.05)  # let both slots register their signal handlers and start polling
    os.kill(os.getpid(), signal.SIGTERM)

    # `main()` should return on its own once every slot notices `stop_event`
    # is set - a hang here means the signal handler (or the slot loop) is
    # broken.
    await asyncio.wait_for(main_task, timeout=5.0)
