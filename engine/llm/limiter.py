"""Adaptive concurrency limit for LLM requests.

A request holds a slot while it is in flight. A 429/503 halves the effective
limit (at most once per second, so one burst of rejections counts once) and
starts a cooldown; after the cooldown each run of `recover_after` successful
requests raises the limit by one until the configured maximum is back
(additive increase, multiplicative decrease). Workers therefore slow down
together instead of all sleeping and retrying at once.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from typing import AsyncIterator, Callable


class AdaptiveLimiter:
    def __init__(
        self,
        max_limit: int,
        *,
        cooldown_s: float = 30.0,
        recover_after: int = 5,
        clock: Callable[[], float] = time.monotonic,
        on_change: Callable[[int, int, str], None] | None = None,
    ) -> None:
        if max_limit < 1:
            raise ValueError("max_limit must be >= 1")
        self.max_limit = max_limit
        self.limit = max_limit
        self.in_flight = 0
        self.cooldown_s = cooldown_s
        self.recover_after = recover_after
        self._clock = clock
        self._cooldown_until = 0.0
        self._last_cut = -1e9
        self._successes = 0
        self._cond: asyncio.Condition | None = None
        self._on_change = on_change
        self.peak_in_flight = 0
        self.throttle_events = 0

    def _condition(self) -> asyncio.Condition:
        if self._cond is None:
            self._cond = asyncio.Condition()
        return self._cond

    async def acquire(self) -> None:
        cond = self._condition()
        async with cond:
            await cond.wait_for(lambda: self.in_flight < self.limit)
            self.in_flight += 1
            self.peak_in_flight = max(self.peak_in_flight, self.in_flight)

    async def release(self) -> None:
        cond = self._condition()
        async with cond:
            self.in_flight = max(0, self.in_flight - 1)
            cond.notify_all()

    @contextlib.asynccontextmanager
    async def slot(self) -> AsyncIterator[None]:
        await self.acquire()
        try:
            yield
        finally:
            await self.release()

    def on_throttle(self) -> None:
        now = self._clock()
        self.throttle_events += 1
        self._successes = 0
        self._cooldown_until = now + self.cooldown_s
        if now - self._last_cut < 1.0:
            return
        self._last_cut = now
        old = self.limit
        self.limit = max(1, self.limit // 2)
        if self._on_change and old != self.limit:
            self._on_change(old, self.limit, "throttled")

    def on_success(self) -> None:
        if self.limit >= self.max_limit or self._clock() < self._cooldown_until:
            return
        self._successes += 1
        if self._successes >= self.recover_after:
            self._successes = 0
            old = self.limit
            self.limit = min(self.max_limit, self.limit + 1)
            if self._on_change and old != self.limit:
                self._on_change(old, self.limit, "recovered")
