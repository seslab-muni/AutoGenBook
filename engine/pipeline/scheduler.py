"""Asyncio executor for the task DAG.

- At most `workers` tasks run at once (LLM requests are additionally bounded
  by the client's adaptive limiter). Among ready tasks the highest `priority`
  runs first, then document order, so a leaf's review/revise/length chain
  finishes before new drafts start and sections complete progressively.
- A failed task marks its dependents skipped; the others keep running
  (failures are collected). A `critical` task failure, or any failure when
  `fail_fast` is set, cancels everything still running.
- Tasks can add tasks while the run is going (`add`), which is how the
  generation plan is attached once subdivision has fixed the leaves.
- Cancellation (SIGTERM) cancels the running tasks and propagates.
"""

from __future__ import annotations

import asyncio
import heapq
import itertools
from dataclasses import dataclass, field
from typing import Awaitable, Callable


@dataclass
class Task:
    id: str
    kind: str
    run: Callable[[], Awaitable[None]]
    deps: set[str] = field(default_factory=set)
    node_key: str | None = None
    priority: int = 0
    order: int = 0
    critical: bool = False


@dataclass
class SchedulerResult:
    done: list[str] = field(default_factory=list)
    failed: dict[str, BaseException] = field(default_factory=dict)
    skipped: list[str] = field(default_factory=list)
    aborted: bool = False

    @property
    def ok(self) -> bool:
        return not self.failed and not self.aborted


class Scheduler:
    def __init__(
        self,
        *,
        workers: int,
        fail_fast: Callable[[BaseException], bool] = lambda _exc: False,
        on_failure: Callable[[Task, BaseException], None] | None = None,
    ) -> None:
        self.workers = max(1, workers)
        self.tasks: dict[str, Task] = {}
        self.state: dict[str, str] = {}  # pending | running | done | failed | skipped
        self.result = SchedulerResult()
        self._fail_fast = fail_fast
        self._on_failure = on_failure
        self._ready: list[tuple[int, int, int, str]] = []
        self._counter = itertools.count()
        self._wakeup: asyncio.Event | None = None
        self._abort = False

    # --------------------------------------------------------------- building
    def add(self, task: Task) -> None:
        if task.id in self.tasks:
            raise ValueError(f"duplicate task id {task.id}")
        self.tasks[task.id] = task
        self.state[task.id] = "pending"
        self._consider(task.id)
        if self._wakeup is not None:
            self._wakeup.set()

    def add_all(self, tasks: list[Task]) -> None:
        for task in tasks:
            self.add(task)

    def _dep_state(self, task: Task) -> str:
        """ready | blocked | doomed"""
        for dep in task.deps:
            state = self.state.get(dep)
            if state in {"failed", "skipped"}:
                return "doomed"
            if state == "done":
                continue
            return "blocked"  # pending, running, or not added yet (added later)
        return "ready"

    def _consider(self, task_id: str) -> None:
        if self.state.get(task_id) != "pending":
            return
        task = self.tasks[task_id]
        status = self._dep_state(task)
        if status == "ready":
            self.state[task_id] = "queued"
            heapq.heappush(self._ready, (-task.priority, task.order, next(self._counter), task_id))
        elif status == "doomed":
            self._skip(task_id)

    def _skip(self, task_id: str) -> None:
        self.state[task_id] = "skipped"
        self.result.skipped.append(task_id)
        self._dependents_changed(task_id)

    def _dependents_changed(self, task_id: str) -> None:
        for other_id, other in self.tasks.items():
            if task_id in other.deps and self.state.get(other_id) == "pending":
                self._consider(other_id)

    # ---------------------------------------------------------------- running
    async def run(self) -> SchedulerResult:
        self._wakeup = asyncio.Event()
        running: dict[asyncio.Task[None], str] = {}
        try:
            while True:
                while self._ready and len(running) < self.workers and not self._abort:
                    _p, _o, _c, task_id = heapq.heappop(self._ready)
                    self.state[task_id] = "running"
                    running[asyncio.ensure_future(self.tasks[task_id].run())] = task_id
                if not running:
                    if self._abort or not self._ready:
                        break
                    continue
                self._wakeup.clear()
                waiter = asyncio.ensure_future(self._wakeup.wait())
                done, _pending = await asyncio.wait(set(running) | {waiter}, return_when=asyncio.FIRST_COMPLETED)
                if waiter not in done:
                    waiter.cancel()
                for future in done:
                    if future is waiter:
                        continue
                    task_id = running.pop(future)
                    task = self.tasks[task_id]
                    exc = future.exception() if not future.cancelled() else asyncio.CancelledError()
                    if exc is None:
                        self.state[task_id] = "done"
                        self.result.done.append(task_id)
                    else:
                        self.state[task_id] = "failed"
                        self.result.failed[task_id] = exc
                        if self._on_failure is not None:
                            self._on_failure(task, exc)
                        if task.critical or self._fail_fast(exc):
                            self._abort = True
                            self.result.aborted = True
                    self._dependents_changed(task_id)
                if self._abort and running:
                    for future in running:
                        future.cancel()
                    await asyncio.gather(*running, return_exceptions=True)
                    for task_id in running.values():
                        self.state[task_id] = "failed"
                        self.result.failed.setdefault(task_id, asyncio.CancelledError())
                    running.clear()
        except asyncio.CancelledError:
            for future in running:
                future.cancel()
            await asyncio.gather(*running, return_exceptions=True)
            raise
        for task_id, state in self.state.items():
            if state in {"pending", "queued"}:
                self.state[task_id] = "skipped"
                self.result.skipped.append(task_id)
        return self.result
