"""Per-run context handed to pipelines, stages and agents (no globals)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import httpx

from engine.config import RunConfig
from engine.events import EventSink
from engine.llm.client import LLMClient
from engine.llm.usage import UsageLedger


@dataclass(frozen=True)
class Paths:
    out_dir: Path

    @property
    def sections(self) -> Path:
        return self.out_dir / "sections"

    @property
    def reviews(self) -> Path:
        return self.out_dir / "section_reviews"

    @property
    def graph(self) -> Path:
        return self.out_dir / "structure_graph.json"

    @property
    def kb_sources(self) -> Path:
        return self.out_dir / "kb_sources.json"

    @property
    def kb_cache(self) -> Path:
        return self.out_dir / ".kb_cache"

    @property
    def work(self) -> Path:
        """Engine-private intermediate state (resumable task outputs)."""
        return self.out_dir / ".engine"

    @property
    def logs(self) -> Path:
        return self.out_dir / "logs"

    @property
    def agent_logs(self) -> Path:
        return self.out_dir / "agent_logs"

    @property
    def glossary(self) -> Path:
        return self.out_dir / "glossary.json"

    @property
    def usage(self) -> Path:
        return self.out_dir / "llm_usage.jsonl"

    @property
    def events(self) -> Path:
        return self.out_dir / "events.jsonl"

    @property
    def run_meta(self) -> Path:
        return self.out_dir / "run_meta.json"

    def section(self, key: str) -> Path:
        return self.sections / f"{key}.md"

    def review(self, key: str, *, revised: bool = False) -> Path:
        return self.reviews / (f"{key}_revised.json" if revised else f"{key}.json")


class RunContext:
    def __init__(
        self,
        config: RunConfig,
        sink: EventSink,
        *,
        ledger: UsageLedger,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.config = config
        self.sink = sink
        self.ledger = ledger
        self.transport = transport
        self.paths = Paths(config.out_dir)
        self._llm: LLMClient | None = None

    @property
    def llm(self) -> LLMClient:
        """Created on first use, so a run that needs no model (an export)
        never requires an API key."""
        if self._llm is None:
            self._llm = LLMClient(
                self.config.llm,
                ledger=self.ledger,
                sink=self.sink,
                concurrency=self.config.concurrency,
                transport=self.transport,
            )
        return self._llm

    @property
    def llm_started(self) -> bool:
        return self._llm is not None

    async def aclose(self) -> None:
        if self._llm is not None:
            await self._llm.aclose()
