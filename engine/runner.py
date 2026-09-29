"""`engine.run(config, sink) -> RunResult`: the typed entry point.

Dispatches to the document type's pipeline, turns every failure into a clean
exit code plus `run_meta.json:error` (the API shows that text; LLM client
errors keep the SDK's "Error code: NNN - ..." wording its error mapper
recognises), and always writes `run_meta.json` with the usage totals.
"""

from __future__ import annotations

import asyncio
import traceback
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx
import openai

from engine import __version__
from engine.config import RunConfig
from engine.errors import EXIT_CANCELLED, EXIT_FAILURE, EngineError, InputError
from engine.events import EventSink
from engine.llm.usage import UsageLedger
from engine.pipeline.context import RunContext
from engine.util.fs import atomic_write_json


@dataclass
class PipelineOutcome:
    exit_code: int = 0
    error: str | None = None
    outputs: list[Path] = field(default_factory=list)
    run_kind: str = "full"
    stats: dict[str, Any] = field(default_factory=dict)


@dataclass
class RunResult:
    exit_code: int
    status: str
    error: str | None
    outputs: list[Path]
    run_kind: str
    stats: dict[str, Any]
    usage: dict[str, Any]
    run_meta_path: Path


Pipeline = Callable[[RunContext], Awaitable[PipelineOutcome]]


def _pipeline_for(mode: str) -> Pipeline:
    if mode == "book":
        from engine.pipeline.book import run_book

        return run_book
    if mode == "paper":
        from engine.pipeline.paper import run_paper

        return run_paper
    if mode == "presentation":
        from engine.pipeline.presentation import run_presentation

        return run_presentation
    raise EngineError(f"unknown mode {mode!r}")


async def run(
    config: RunConfig,
    sink: EventSink,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> RunResult:
    """Run one document generation. `transport`, when given, carries every
    outbound HTTP request of the run (tests inject the fake LLM here)."""
    started = datetime.now(timezone.utc)
    config.out_dir.mkdir(parents=True, exist_ok=True)
    ledger = UsageLedger(config.out_dir / "llm_usage.jsonl")
    ctx = RunContext(config, sink, ledger=ledger, transport=transport)
    outcome = PipelineOutcome()
    status = "ok"
    try:
        if not config.input_path.is_file():
            raise InputError(f"input file not found: {config.input_path}")
        outcome = await _pipeline_for(config.mode)(ctx)
        if outcome.exit_code != 0:
            status = "error"
    except asyncio.CancelledError:
        status = "cancelled"
        outcome.exit_code = EXIT_CANCELLED
        outcome.error = "Run cancelled (SIGTERM)"
        sink.emit("log", "ERROR: run cancelled", level="error")
    except EngineError as exc:
        status = "error"
        outcome.exit_code = exc.exit_code
        outcome.error = str(exc)
        sink.emit("log", f"ERROR: {exc}", level="error")
    except openai.OpenAIError as exc:
        status = "error"
        outcome.exit_code = EXIT_FAILURE
        outcome.error = str(exc)
        sink.emit("log", f"ERROR: LLM request failed: {exc}", level="error")
    except Exception as exc:  # noqa: BLE001 - reported, then the run fails cleanly
        status = "error"
        outcome.exit_code = EXIT_FAILURE
        outcome.error = f"{type(exc).__name__}: {exc}"
        for line in traceback.format_exc().rstrip().splitlines():
            sink.emit("log", line, level="error")
    finally:
        finished = datetime.now(timezone.utc)
        totals = ledger.totals()
        meta = {
            "run_id": started.strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8],
            "engine": "engine",
            "engine_version": __version__,
            "mode": config.mode,
            "run_kind": outcome.run_kind,
            "out_dir": str(config.out_dir),
            "started_at": started.isoformat(),
            "finished_at": finished.isoformat(),
            "duration_sec": round((finished - started).total_seconds(), 3),
            "status": status,
            "error": outcome.error,
            "args": dict(config.args),
            "config": config.describe(),
            "models": {
                "main": config.llm.resolve("main"),
                "mini": config.llm.resolve("mini"),
                "embed": config.retrieval.embed_model,
                "rerank": config.retrieval.rerank_model,
            },
            "token_totals": totals["token_totals"],
            "cost_totals_usd": totals["cost_totals_usd"],
            "usage": {k: v for k, v in totals.items() if k not in {"token_totals", "cost_totals_usd"}},
            "stats": outcome.stats,
            "outputs": [str(p) for p in outcome.outputs],
        }
        try:
            atomic_write_json(config.out_dir / "run_meta.json", meta)
        except OSError as exc:  # pragma: no cover - disk full etc.
            sink.emit("log", f"could not write run_meta.json: {exc}", level="warning")
        sink.emit(
            "tokens",
            f"Total tokens: {totals['total_tokens']} (prompt {totals['prompt_tokens']}, completion "
            f"{totals['completion_tokens']}) in {totals['requests']} requests",
        )
        cost = totals["total_cost_usd"]
        sink.emit("cost", f"Total cost: ${cost:.6f}" if cost is not None else "Total cost: unknown (not reported by the provider)")
        try:
            await asyncio.shield(ctx.aclose())
        except BaseException:  # noqa: BLE001 - closing must never mask the result
            pass
    return RunResult(
        exit_code=outcome.exit_code,
        status=status,
        error=outcome.error,
        outputs=outcome.outputs,
        run_kind=outcome.run_kind,
        stats=outcome.stats,
        usage=totals,
        run_meta_path=config.out_dir / "run_meta.json",
    )
