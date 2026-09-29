"""`book_structure.json` (contract 3.2) and its conversion into a `DocGraph`.

Normalisation mirrors the old engine's `_normalize_book_json`/
`_normalize_book_child`, so a structure the API's `StructureBuilder` renders
(or one an LLM produced) needs no further massaging. Unknown fields are
tolerated and ignored.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from engine.graph.doc_graph import DocGraph, _coerce_bool, _coerce_float
from engine.graph.keys import ROOT, child_key

KB_SCOPES = ("inherit", "all", "selected")


class StructureNode(BaseModel):
    model_config = ConfigDict(extra="ignore")

    title: str = ""
    summary: str = ""
    n_pages: float = 1.0
    needsSubdivision: bool = False
    structure_locked: bool = False
    content_locked: bool = False
    content_file: str = ""
    kb_scope: str = "inherit"
    kb_sources: list[str] = Field(default_factory=list)
    childs: list["StructureNode"] = Field(default_factory=list)


class BookStructure(BaseModel):
    model_config = ConfigDict(extra="ignore")

    title: str = "Untitled Book"
    summary: str = ""
    n_pages: float = 40.0
    target_readers: str = ""
    equation_frequency_level: int = 4
    do_consider_outline: bool = True
    do_consider_previous_sections: bool = True
    additional_requirements: str = ""
    max_depth: int = 5
    max_output_pages: float = 1.5
    language: str | None = None
    author: str | None = None
    childs: list[StructureNode] = Field(default_factory=list)


def _normalize_scope(raw: dict[str, Any]) -> dict[str, Any]:
    scope = str(raw.get("kb_scope", "inherit") or "inherit").strip().lower()
    if scope not in KB_SCOPES:
        scope = "inherit"
    out: dict[str, Any] = {"kb_scope": scope, "kb_sources": []}
    if scope == "selected":
        sources = raw.get("kb_sources", [])
        if not isinstance(sources, list):
            sources = []
        out["kb_sources"] = [str(s).strip() for s in sources if str(s).strip()]
    return out


def _normalize_child(raw: dict[str, Any]) -> dict[str, Any]:
    childs = [_normalize_child(c) for c in (raw.get("childs") or []) if isinstance(c, dict)]
    out: dict[str, Any] = {
        "title": str(raw.get("title", "") or "").strip(),
        "summary": str(raw.get("summary", "") or "").strip(),
        "n_pages": max(0.1, _coerce_float(raw.get("n_pages", 1.0), 1.0)),
        "needsSubdivision": _coerce_bool(raw.get("needsSubdivision", bool(childs)), bool(childs)),
        "structure_locked": _coerce_bool(raw.get("structure_locked", False)),
        "content_locked": _coerce_bool(raw.get("content_locked", False)),
        "content_file": str(raw.get("content_file", "") or "").strip(),
        "childs": childs,
    }
    if childs:
        out["needsSubdivision"] = True
    if out["content_locked"]:
        # A content-locked leaf must stay the leaf its text belongs to.
        out["structure_locked"] = True
    out.update(_normalize_scope(raw))
    return out


def normalize_structure(raw: dict[str, Any]) -> BookStructure:
    data = dict(raw or {})
    level = int(_coerce_float(data.get("equation_frequency_level", 4), 4))
    normalized = {
        "title": str(data.get("title", "") or "").strip() or "Untitled Book",
        "summary": str(data.get("summary", "") or "").strip(),
        "n_pages": _coerce_float(data.get("n_pages", 40), 40.0),
        "target_readers": str(data.get("target_readers", "") or "").strip(),
        "equation_frequency_level": max(1, min(5, level)),
        "do_consider_outline": _coerce_bool(data.get("do_consider_outline", True), True),
        "do_consider_previous_sections": _coerce_bool(data.get("do_consider_previous_sections", True), True),
        "additional_requirements": str(data.get("additional_requirements", "") or "").strip(),
        "max_depth": max(1, int(_coerce_float(data.get("max_depth", 5), 5))),
        "max_output_pages": max(0.2, _coerce_float(data.get("max_output_pages", 1.5), 1.5)),
        "language": (str(data.get("language")).strip().lower() or None) if data.get("language") else None,
        "author": (str(data.get("author")).strip() or None) if data.get("author") else None,
        "childs": [_normalize_child(c) for c in (data.get("childs") or []) if isinstance(c, dict)],
    }
    return BookStructure.model_validate(normalized)


def _node_attrs(node: StructureNode) -> dict[str, Any]:
    attrs: dict[str, Any] = {
        "title": node.title,
        "summary": node.summary,
        "n_pages": float(node.n_pages),
        "needsSubdivision": bool(node.needsSubdivision),
    }
    if node.structure_locked:
        attrs["structure_locked"] = True
    if node.content_locked:
        attrs["content_locked"] = True
        attrs["structure_locked"] = True
    if node.content_file:
        attrs["content_file"] = node.content_file
    # Only non-default scopes are written, like the old engine, so nodes
    # without a scope stay byte-identical to what the API expects.
    if node.kb_scope == "all":
        attrs["kb_scope"] = "all"
    elif node.kb_scope == "selected":
        attrs["kb_scope"] = "selected"
        attrs["kb_sources"] = list(node.kb_sources)
    return attrs


def graph_from_structure(structure: BookStructure, *, doc_type: str = "book") -> DocGraph:
    graph_attrs = {
        "doc_type": doc_type,
        "title": structure.title,
        "summary": structure.summary,
        "n_pages": structure.n_pages,
        "target_readers": structure.target_readers,
        "additional_requirements": structure.additional_requirements,
        "equation_frequency_level": structure.equation_frequency_level,
        "do_consider_outline": structure.do_consider_outline,
        "do_consider_previous_sections": structure.do_consider_previous_sections,
        "max_depth": structure.max_depth,
        "max_output_pages": structure.max_output_pages,
    }
    if structure.language:
        graph_attrs["language"] = structure.language
    if structure.author:
        graph_attrs["author"] = structure.author
    g = DocGraph.new(
        {
            "title": structure.title,
            "summary": structure.summary,
            "n_pages": structure.n_pages,
            "needsSubdivision": bool(structure.childs),
        },
        graph_attrs,
    )

    def add(parent: str, children: list[StructureNode]) -> None:
        for index, child in enumerate(children, start=1):
            key = child_key(parent, index)
            g.add_node(key, parent, _node_attrs(child))
            if child.childs:
                add(key, child.childs)

    add(ROOT, structure.childs)
    return g
