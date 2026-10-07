"""AutoGenBook generation engine (epic #158).

The primary interface is typed and async::

    from engine import RunConfig, run
    result = await run(config, sink)          # -> RunResult

A single section can be revised in-process, without a run directory::

    from engine import ReviseRequest, revise
    result = await revise(ReviseRequest(body_markdown=..., instruction=...), sink)   # -> ReviseResult

`engine/cli.py` (and the repo-root shim `run_engine.py`) is a thin adapter
that turns the frozen argv contract of docs/ENGINE_REWRITE.md section 3 into a
`RunConfig` and prints the contract stdout protocol through an `EventSink`.
"""

from __future__ import annotations

from typing import Any

__all__ = ["EventSink", "ReviseParams", "ReviseRequest", "ReviseResult", "RunConfig", "RunResult", "SectionBrief", "revise", "run"]
__version__ = "0.1.0"


def __getattr__(name: str) -> Any:  # lazy, so `import engine.spec` stays light
    if name == "RunConfig":
        from engine.config import RunConfig

        return RunConfig
    if name == "EventSink":
        from engine.events import EventSink

        return EventSink
    if name in {"run", "RunResult"}:
        from engine import runner

        return getattr(runner, name)
    if name in {"revise", "ReviseRequest", "ReviseParams", "ReviseResult", "ReviseRetrieval", "SectionBrief"}:
        from engine import revision

        return getattr(revision, name)
    raise AttributeError(name)
