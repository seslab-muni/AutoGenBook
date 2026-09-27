"""Resume rules (contract 3.5).

`--resume` reuses `out/structure_graph.json` verbatim (including the API's
edits: cleared `content_file_path`, rewritten `summary`, synced scopes and
locks) only when it belongs to this input: `graph.input_sha256` must equal
the current hash of `-i`, `graph.input_path` (when recorded) must be the same
file and `graph.doc_type` (when recorded) the same mode. Otherwise resume is
refused and the outline is rebuilt - the guard the API's drift checks rely
on. A graph without a stored hash (hand-made, or written by a pre-hash old
run) is accepted and stamped, like `tests/api/fake_cli.py` does.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from engine.config import RunConfig
from engine.events import EventSink
from engine.graph.doc_graph import DocGraph


@dataclass
class ResumeDecision:
    graph: DocGraph | None
    accepted: bool
    reason: str
    refused: bool = False  # a saved structure existed but belongs to another input/mode
    content_changed: bool = False  # ... and the input's content (or the mode) differs

    @property
    def force_txt(self) -> bool:
        """A resume refused because the input changed regenerates the outline
        from the TXT (unless --use-json), as the old engine did: the structure
        JSON was derived from the previous input. A moved but unchanged input
        keeps its structure JSON."""
        return self.refused and self.content_changed


def _load_graph(path: Path) -> DocGraph | None:
    for candidate in (path, path.with_name(path.name + ".bak")):
        if not candidate.is_file():
            continue
        try:
            return DocGraph.load(candidate)
        except (OSError, ValueError):
            continue
    return None


def decide_resume(config: RunConfig, input_sha256: str, sink: EventSink) -> ResumeDecision:
    if not config.resume:
        return ResumeDecision(None, False, "no --resume")
    path = config.out_dir / "structure_graph.json"
    if not path.exists():
        sink.emit("resume", "No saved structure in the output directory; starting a full run.")
        return ResumeDecision(None, False, "no saved graph")
    sink.emit("resume", f"Loading saved structure from {path.name}")
    graph = _load_graph(path)
    if graph is None:
        sink.emit("resume", "Saved structure is unreadable; starting a full run.", level="warning")
        return ResumeDecision(None, False, "unreadable graph")
    stored_path = str(graph.attrs.get("input_path") or "").strip()
    if stored_path:
        try:
            same = Path(stored_path).expanduser().resolve() == config.input_path
        except OSError:
            same = False
        if not same:
            reason = f"the saved structure belongs to a different input file ({Path(stored_path).name})"
            sink.emit("resume", f"Skipping --resume: {reason}. Starting a new run from the current input.")
            stored = str(graph.attrs.get("input_sha256") or "").strip()
            return ResumeDecision(None, False, reason, refused=True, content_changed=stored != input_sha256)
    stored_sha = str(graph.attrs.get("input_sha256") or "").strip()
    if stored_sha and stored_sha != input_sha256:
        reason = f"the input changed since the last run (saved {stored_sha[:12]}..., now {input_sha256[:12]}...)"
        sink.emit("resume", f"Skipping --resume: {reason}. Starting a new run from the current input.")
        return ResumeDecision(None, False, reason, refused=True, content_changed=True)
    doc_type = str(graph.attrs.get("doc_type") or "").strip()
    if doc_type and doc_type != config.mode:
        reason = f"the saved structure is a {doc_type}, not a {config.mode}"
        sink.emit("resume", f"Skipping --resume: {reason}.")
        return ResumeDecision(None, False, reason, refused=True, content_changed=True)
    if not stored_sha:
        sink.emit("resume", "Saved structure has no input hash; resuming and stamping the current one.", level="warning")
    return ResumeDecision(graph, True, "accepted")
