"""Usage ledger: every HTTP request to a model endpoint is one line of
`out/llm_usage.jsonl` (successes, failures, retries, repair calls,
embeddings, reranks), and `totals()` aggregates the `run_meta.json` keys the
API sums (`token_totals`, `cost_totals_usd`)."""

from __future__ import annotations

import json
import threading
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


@dataclass
class UsageEntry:
    label: str
    kind: str  # chat | chat_stream | embeddings | rerank | score | tts | pricing
    model: str
    status: int | str = "ok"
    node_key: str | None = None
    attempt: int = 1
    response_format: str | None = None
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    cost_usd: float | None = None
    cost_source: str | None = None
    latency_s: float = 0.0
    error: str | None = None
    ts: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_json(self) -> dict[str, Any]:
        data = asdict(self)
        # Same key the old engine's ledger used, so bench/analysis code can
        # read both formats.
        data["usage"] = {
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.total_tokens,
        }
        return data


class UsageLedger:
    def __init__(self, path: Path | None) -> None:
        self.path = path
        self.entries: list[UsageEntry] = []
        self._lock = threading.Lock()
        if path is not None:
            path.parent.mkdir(parents=True, exist_ok=True)

    def record(self, entry: UsageEntry) -> None:
        with self._lock:
            self.entries.append(entry)
            if self.path is not None:
                with self.path.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(entry.to_json(), ensure_ascii=False) + "\n")

    @property
    def request_count(self) -> int:
        return len(self.entries)

    def totals(self) -> dict[str, Any]:
        tokens_by_model: dict[str, int] = {}
        cost_by_model: dict[str, float | None] = {}
        prompt = completion = total = 0
        by_label: dict[str, dict[str, Any]] = {}
        errors = throttled = 0
        with self._lock:
            entries = list(self.entries)
        for e in entries:
            tokens_by_model[e.model] = tokens_by_model.get(e.model, 0) + e.total_tokens
            if e.cost_usd is not None:
                cost_by_model[e.model] = (cost_by_model.get(e.model) or 0.0) + e.cost_usd
            else:
                cost_by_model.setdefault(e.model, None)
            prompt += e.prompt_tokens
            completion += e.completion_tokens
            total += e.total_tokens
            bucket = by_label.setdefault(e.label, {"requests": 0, "total_tokens": 0})
            bucket["requests"] += 1
            bucket["total_tokens"] += e.total_tokens
            if e.status != "ok":
                errors += 1
            if e.status == 429:
                throttled += 1
        known = [c for c in cost_by_model.values() if c is not None]
        return {
            "token_totals": tokens_by_model,
            "cost_totals_usd": {m: (round(c, 8) if c is not None else None) for m, c in cost_by_model.items()},
            "total_tokens": total,
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "total_cost_usd": round(sum(known), 8) if known else None,
            "requests": len(entries),
            "failed_requests": errors,
            "throttled_requests": throttled,
            "by_label": by_label,
        }
