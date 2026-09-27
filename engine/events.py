"""The single place the stdout protocol of the contract lives (ENGINE_REWRITE.md 3.3).

`EventSink.emit(stage, message, ...)` prints one line with the contract prefix
for that stage (`[KB]`, `[JSON]`, `[SUBDIVIDE]`, `[GEN]`, `[MD]`, `[LATEX]`,
`[PDF]`, `[RESUME]`, `[WARN]`, `[INFO]`, `[TOKENS]`, `[COST]`), flushed line by
line, and appends a structured record `{ts, stage, level, node_key, message,
payload}` to `out/events.jsonl` for the API to adopt later.

Warnings always print with `[WARN]` (the API maps that prefix to warning
level) whatever their logical stage; the logical stage is kept in
events.jsonl. Messages are single-line: embedded newlines would otherwise
start unprefixed lines the API classifies as plain log output.
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import IO, Any, Protocol

STAGE_PREFIX: dict[str, str] = {
    "kb": "[KB]",
    "json": "[JSON]",
    "subdivide": "[SUBDIVIDE]",
    "generate": "[GEN]",
    "markdown": "[MD]",
    "latex": "[LATEX]",
    "pdf": "[PDF]",
    "resume": "[RESUME]",
    "warning": "[WARN]",
    "info": "[INFO]",
    "tokens": "[TOKENS]",
    "cost": "[COST]",
    "log": "",
}
LEVELS = ("debug", "info", "warning", "error")


def format_line(stage: str, message: str, level: str = "info") -> str:
    """The exact stdout line for one event."""
    text = " ".join(str(message).split("\n")).replace("\r", " ").strip()
    if level in {"warning", "error"} and stage != "log":
        prefix = "[WARN]"
    else:
        prefix = STAGE_PREFIX.get(stage, "[INFO]")
    return f"{prefix} {text}" if prefix else text


class EventSink(Protocol):
    def emit(
        self,
        stage: str,
        message: str,
        *,
        level: str = "info",
        node_key: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> None: ...

    def close(self) -> None: ...


class _Base:
    def warn(self, message: str, *, stage: str = "warning", node_key: str | None = None, payload: dict[str, Any] | None = None) -> None:
        self.emit(stage, message, level="warning", node_key=node_key, payload=payload)  # type: ignore[attr-defined]

    def close(self) -> None:
        return None


class StreamSink(_Base):
    """Contract stdout lines to a text stream (flushed per line)."""

    def __init__(self, stream: IO[str]) -> None:
        self._stream = stream
        self._lock = threading.Lock()

    def emit(self, stage: str, message: str, *, level: str = "info", node_key: str | None = None, payload: dict[str, Any] | None = None) -> None:
        if level == "debug":
            return
        line = format_line(stage, message, level)
        with self._lock:
            self._stream.write(line + "\n")
            self._stream.flush()


class JsonlSink(_Base):
    """Structured records to `out/events.jsonl`."""

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._handle = path.open("a", encoding="utf-8")
        self._lock = threading.Lock()

    def emit(self, stage: str, message: str, *, level: str = "info", node_key: str | None = None, payload: dict[str, Any] | None = None) -> None:
        record = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "stage": stage,
            "level": level,
            "node_key": node_key,
            "message": str(message),
            "payload": payload,
        }
        with self._lock:
            if self._handle.closed:
                return
            self._handle.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
            self._handle.flush()

    def close(self) -> None:
        with self._lock:
            if not self._handle.closed:
                self._handle.close()


class MemorySink(_Base):
    """Collects events in memory (tests, the typed API without stdout)."""

    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []
        self._lock = threading.Lock()

    def emit(self, stage: str, message: str, *, level: str = "info", node_key: str | None = None, payload: dict[str, Any] | None = None) -> None:
        with self._lock:
            self.events.append(
                {"stage": stage, "level": level, "node_key": node_key, "message": str(message), "payload": payload}
            )

    def lines(self) -> list[str]:
        return [format_line(e["stage"], e["message"], e["level"]) for e in self.events if e["level"] != "debug"]


class CompositeSink(_Base):
    def __init__(self, *sinks: EventSink) -> None:
        self.sinks = list(sinks)

    def add(self, sink: EventSink) -> None:
        self.sinks.append(sink)

    def emit(self, stage: str, message: str, *, level: str = "info", node_key: str | None = None, payload: dict[str, Any] | None = None) -> None:
        for sink in self.sinks:
            sink.emit(stage, message, level=level, node_key=node_key, payload=payload)

    def close(self) -> None:
        for sink in self.sinks:
            sink.close()


def warn(sink: EventSink, message: str, *, stage: str = "warning", node_key: str | None = None, payload: dict[str, Any] | None = None) -> None:
    sink.emit(stage, message, level="warning", node_key=node_key, payload=payload)
