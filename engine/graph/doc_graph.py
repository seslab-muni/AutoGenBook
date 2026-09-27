"""The document tree and its `structure_graph.json` form (contract 3.4).

On disk: `{"graph": {...run-level attrs...}, "nodes": {key: attrs}, "edges":
[[parent, child], ...]}`, nodes and edges in DFS order, rooted at `"book"` for
every document type (paper and presentation reuse the book layout so API
support for them stays a thin change). Writes are atomic with a `.bak` copy
of the previous file, because the API polls the file once a second and also
edits it between runs (summary rewrites, scope and lock sync).

Reading is tolerant of old-engine graphs: numeric fields stored as strings
("1.5", "False") are coerced, Windows `content_file_path`s are kept as-is
(the section resolver falls back to `sections/<key>.<ext>`).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

from engine.graph.keys import ROOT, depth_of, sort_keys
from engine.util.fs import atomic_write_text

_BOOL_FIELDS = ("needsSubdivision", "structure_locked", "content_locked")


def _coerce_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "yes", "1"}:
            return True
        if lowered in {"false", "no", "0", ""}:
            return False
    return default


def _coerce_float(value: Any, default: float = 1.0) -> float:
    try:
        return float(str(value).replace(",", "."))
    except (TypeError, ValueError):
        return default


def normalize_node(attrs: dict[str, Any]) -> dict[str, Any]:
    out = dict(attrs)
    if "n_pages" in out:
        out["n_pages"] = _coerce_float(out["n_pages"], 1.0)
    for name in _BOOL_FIELDS:
        if name in out:
            out[name] = _coerce_bool(out[name])
    for name in ("title", "summary"):
        if name in out and out[name] is None:
            out[name] = ""
    return out


@dataclass
class DocGraph:
    attrs: dict[str, Any] = field(default_factory=dict)
    nodes: dict[str, dict[str, Any]] = field(default_factory=dict)
    children: dict[str, list[str]] = field(default_factory=dict)
    parent: dict[str, str] = field(default_factory=dict)

    # ---------------------------------------------------------- construction
    @classmethod
    def new(cls, root_attrs: dict[str, Any], graph_attrs: dict[str, Any] | None = None) -> "DocGraph":
        g = cls(attrs=dict(graph_attrs or {}))
        g.nodes[ROOT] = normalize_node(root_attrs)
        g.children[ROOT] = []
        return g

    def add_node(self, key: str, parent: str, attrs: dict[str, Any]) -> None:
        if parent not in self.nodes:
            raise KeyError(f"unknown parent {parent!r}")
        self.nodes[key] = normalize_node(attrs)
        self.children.setdefault(key, [])
        self.children.setdefault(parent, [])
        if key not in self.children[parent]:
            self.children[parent].append(key)
            self.children[parent] = sort_keys(self.children[parent])
        self.parent[key] = parent

    def remove_subtree(self, key: str) -> None:
        for child in list(self.children.get(key, [])):
            self.remove_subtree(child)
        parent = self.parent.pop(key, None)
        if parent is not None and key in self.children.get(parent, []):
            self.children[parent].remove(key)
        self.children.pop(key, None)
        self.nodes.pop(key, None)

    def remove_children(self, key: str) -> None:
        for child in list(self.children.get(key, [])):
            self.remove_subtree(child)

    # ---------------------------------------------------------------- queries
    def dfs(self, start: str = ROOT) -> Iterator[str]:
        """Keys in document order, `start` first."""
        yield start
        for child in self.children.get(start, []):
            yield from self.dfs(child)

    def is_leaf(self, key: str) -> bool:
        return key != ROOT and not self.children.get(key)

    def leaves(self) -> list[str]:
        return [key for key in self.dfs() if self.is_leaf(key)]

    def depth(self, key: str) -> int:
        return depth_of(key)

    def ancestors(self, key: str) -> list[str]:
        """Parent first, root last."""
        out: list[str] = []
        current = self.parent.get(key)
        while current is not None:
            out.append(current)
            current = self.parent.get(current)
        return out

    def siblings(self, key: str) -> list[str]:
        parent = self.parent.get(key)
        return list(self.children.get(parent, [])) if parent is not None else []

    def title(self, key: str) -> str:
        return str(self.nodes.get(key, {}).get("title") or "")

    # ------------------------------------------------------------- serialise
    def to_json(self) -> dict[str, Any]:
        ordered = list(self.dfs())
        # Orphans (should not exist) are kept rather than silently dropped.
        ordered += [k for k in sort_keys(self.nodes) if k not in ordered]
        edges = [[parent, child] for parent in ordered for child in self.children.get(parent, [])]
        return {
            "graph": dict(self.attrs),
            "nodes": {key: dict(self.nodes[key]) for key in ordered},
            "edges": edges,
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "DocGraph":
        g = cls(attrs=dict(data.get("graph") or {}))
        for key, attrs in (data.get("nodes") or {}).items():
            g.nodes[str(key)] = normalize_node(attrs if isinstance(attrs, dict) else {})
            g.children.setdefault(str(key), [])
        for edge in data.get("edges") or []:
            if not isinstance(edge, (list, tuple)) or len(edge) != 2:
                continue
            parent, child = str(edge[0]), str(edge[1])
            if parent not in g.nodes or child not in g.nodes:
                continue
            if child not in g.children[parent]:
                g.children[parent].append(child)
            g.parent[child] = parent
        for key in g.children:
            g.children[key] = sort_keys(g.children[key])
        if ROOT not in g.nodes:
            g.nodes[ROOT] = {"title": str(g.attrs.get("title") or ""), "summary": ""}
            g.children.setdefault(ROOT, [])
        return g

    @classmethod
    def load(cls, path: Path) -> "DocGraph":
        return cls.from_json(json.loads(path.read_text(encoding="utf-8")))

    def save(self, path: Path) -> None:
        atomic_write_text(path, json.dumps(self.to_json(), ensure_ascii=False, indent=2) + "\n", backup=True)
