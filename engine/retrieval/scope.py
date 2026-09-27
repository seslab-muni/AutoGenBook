"""Per-node KB scopes (`kb_scope` inherit|all|selected + `kb_sources`, issue #138)."""

from __future__ import annotations

from pathlib import Path
from typing import Callable, Iterable

from engine.graph.doc_graph import DocGraph


def resolve_kb_sources(graph: DocGraph, key: str) -> list[str] | None:
    """Effective restriction for `key`: walk up to the root and return the
    first explicit scope; `None` means the whole KB (`all`, or nothing set),
    a list the selected sources (possibly empty = no KB results)."""
    current: str | None = key
    seen: set[str] = set()
    while current is not None and current not in seen:
        seen.add(current)
        attrs = graph.nodes.get(current, {})
        scope = str(attrs.get("kb_scope", "inherit") or "inherit").strip().lower()
        if scope == "all":
            return None
        if scope == "selected":
            sources = attrs.get("kb_sources", [])
            if not isinstance(sources, list):
                return []
            return [str(s) for s in sources if str(s).strip()]
        current = graph.parent.get(current)
    return None


def make_source_filter(kb_root: Path, sources: Iterable[str]) -> Callable[[str], bool]:
    """Predicate over a chunk's `rel_path` (relative to --kb-dir): accepted when
    it is one of `sources` or lies under one, by whole path segments."""
    prefixes = {
        Path(str(s).strip()).as_posix().strip("/")
        for s in sources
        if str(s).strip().strip("/") not in {"", "."}
    }

    def accept(rel_path: str) -> bool:
        return any(rel_path == p or rel_path.startswith(p + "/") for p in prefixes)

    return accept
