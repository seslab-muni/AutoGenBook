"""`paper_input.txt` parser and the `paper_structure.json` model.

Labels (English or Czech): Title, Summary/Abstract, Keywords, Research
questions, Contributions, Method, Experiments, Datasets, Metrics, Notes,
Venue, Total pages, Language, Author. An explicit `##` outline is accepted
as for books. Everything not recognised stays in the spec text the outline
agent reads.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from engine.graph.doc_graph import _coerce_bool, _coerce_float
from engine.spec.book_txt import BookSpec, parse_book_txt

ROLES = ("introduction", "related_work", "method", "results", "discussion", "conclusion", "other")
_PAPER_LABELS = {
    "keywords": ("keywords", "klíčová slova", "klicova slova"),
    "research_questions": ("research questions", "research question", "výzkumné otázky", "vyzkumne otazky"),
    "contributions": ("contributions", "příspěvky", "prispevky", "přínosy"),
    "method": ("method", "methods", "metoda", "metodika"),
    "experiments": ("experiments", "experimenty"),
    "datasets": ("datasets", "data", "datové sady"),
    "metrics": ("metrics", "metriky"),
    "notes": ("notes", "poznámky", "poznamky"),
    "venue": ("venue", "target venue", "časopis", "konference"),
}
_LABEL_RE = re.compile(r"^\s*([A-Za-zÀ-ž][A-Za-zÀ-ž ]{1,40}?)\s*:\s*(.*)$")
_ROLE_PATTERNS = [
    ("related_work", r"related work|background|prior work|literature|state of the art|související|souvisejici|přehled literatury|stav poznání"),
    ("introduction", r"introduction|úvod|uvod|motivation"),
    ("method", r"method|approach|methodology|design|metod|přístup|navrh|návrh"),
    ("results", r"result|evaluation|experiment|výsled|vysled|evaluace"),
    ("discussion", r"discussion|limitation|diskus|omezení"),
    ("conclusion", r"conclusion|summary|future work|závěr|zaver|shrnutí"),
]
RELATED_WORK_TITLE = {"cs": "Související práce", "sk": "Súvisiace práce", "de": "Verwandte Arbeiten"}


def infer_role(title: str) -> str:
    lowered = title.casefold()
    for role, pattern in _ROLE_PATTERNS:
        if re.search(pattern, lowered):
            return role
    return "other"


@dataclass
class PaperSpec(BookSpec):
    keywords: list[str] = field(default_factory=list)
    research_questions: str = ""
    contributions: list[str] = field(default_factory=list)
    method: str = ""
    experiments: str = ""
    datasets: str = ""
    metrics: str = ""
    notes: str = ""
    venue: str = ""


def _split_list(value: str) -> list[str]:
    parts = re.split(r"\(\d+\)|;|,(?![^()]*\))", value)
    return [p.strip(" .") for p in parts if p.strip(" .")]


def parse_paper_txt(text: str) -> PaperSpec:
    base = parse_book_txt(text)
    spec = PaperSpec(**{k: getattr(base, k) for k in BookSpec.__dataclass_fields__})
    for line in text.splitlines():
        match = _LABEL_RE.match(line)
        if not match:
            continue
        label, value = match.group(1).strip().casefold(), match.group(2).strip()
        for key, names in _PAPER_LABELS.items():
            if label in names:
                if key in {"keywords", "contributions"}:
                    setattr(spec, key, _split_list(value))
                else:
                    setattr(spec, key, value)
    if spec.total_pages is None:
        spec.total_pages = 8.0
    return spec


class PaperSection(BaseModel):
    model_config = ConfigDict(extra="ignore")

    title: str = ""
    summary: str = ""
    role: str = "other"
    n_pages: float = 1.0
    needsSubdivision: bool = False
    structure_locked: bool = False
    content_locked: bool = False
    content_file: str = ""
    kb_scope: str = "inherit"
    kb_sources: list[str] = Field(default_factory=list)
    childs: list["PaperSection"] = Field(default_factory=list)


class PaperStructure(BaseModel):
    model_config = ConfigDict(extra="ignore")

    title: str = "Untitled Paper"
    abstract: str = ""
    keywords: list[str] = Field(default_factory=list)
    contributions: list[str] = Field(default_factory=list)
    target_venue: str = "arXiv"
    citation_style: str = "bibtex"
    n_pages: float = 8.0
    target_readers: str = ""
    additional_requirements: str = ""
    equation_frequency_level: int = 3
    max_depth: int = 3
    max_output_pages: float = 1.5
    language: str | None = None
    author: str | None = None
    sections: list[PaperSection] = Field(default_factory=list)


def normalize_paper_structure(raw: dict[str, Any]) -> PaperStructure:
    data = dict(raw or {})
    sections = data.get("sections")
    if not isinstance(sections, list):
        sections = data.get("childs") if isinstance(data.get("childs"), list) else []

    def node(item: dict[str, Any]) -> dict[str, Any]:
        nested = next((item.get(name) for name in ("childs", "subsections", "children") if isinstance(item.get(name), list)), [])
        children = [node(c) for c in nested if isinstance(c, dict)]
        title = str(item.get("title", "") or "").strip()
        role = str(item.get("role", "") or "").strip().lower()
        return {
            "title": title,
            "summary": str(item.get("summary", "") or "").strip(),
            "role": role if role in ROLES else infer_role(title),
            "n_pages": max(0.1, _coerce_float(item.get("n_pages", 1.0), 1.0)),
            "needsSubdivision": bool(children) or _coerce_bool(item.get("needsSubdivision", False)),
            "structure_locked": _coerce_bool(item.get("structure_locked", False)) or _coerce_bool(item.get("content_locked", False)),
            "content_locked": _coerce_bool(item.get("content_locked", False)),
            "content_file": str(item.get("content_file", "") or "").strip(),
            "kb_scope": str(item.get("kb_scope", "inherit") or "inherit"),
            "kb_sources": [str(s) for s in (item.get("kb_sources") or []) if str(s).strip()],
            "childs": children,
        }

    keywords = data.get("keywords") or []
    if isinstance(keywords, str):
        keywords = _split_list(keywords)
    contributions = data.get("contributions") or []
    if isinstance(contributions, str):
        contributions = _split_list(contributions)
    return PaperStructure.model_validate({
        "title": str(data.get("title", "") or "").strip() or "Untitled Paper",
        "abstract": str(data.get("abstract", data.get("summary", "")) or "").strip(),
        "keywords": [str(k) for k in keywords],
        "contributions": [str(c) for c in contributions],
        "target_venue": str(data.get("target_venue", "") or "arXiv"),
        "citation_style": str(data.get("citation_style", "") or "bibtex"),
        "n_pages": _coerce_float(data.get("n_pages", 8.0), 8.0) or 8.0,
        "target_readers": str(data.get("target_readers", "") or ""),
        "additional_requirements": str(data.get("additional_requirements", "") or ""),
        "equation_frequency_level": max(1, min(5, int(_coerce_float(data.get("equation_frequency_level", 3), 3)))),
        "max_depth": max(1, int(_coerce_float(data.get("max_depth", 3), 3))),
        "max_output_pages": max(0.2, _coerce_float(data.get("max_output_pages", 1.5), 1.5)),
        "language": (str(data.get("language")).strip().lower() or None) if data.get("language") else None,
        "author": (str(data.get("author")).strip() or None) if data.get("author") else None,
        "sections": [node(s) for s in sections if isinstance(s, dict)],
    })


def paper_to_book_structure(paper: PaperStructure) -> dict[str, Any]:
    """The book-shaped dict `graph_from_structure` builds the graph from."""

    def child(section: PaperSection) -> dict[str, Any]:
        out = section.model_dump()
        out["childs"] = [child(c) for c in section.childs]
        return out

    return {
        "title": paper.title,
        "summary": paper.abstract,
        "n_pages": paper.n_pages,
        "target_readers": paper.target_readers or f"readers of {paper.target_venue}",
        "additional_requirements": paper.additional_requirements,
        "equation_frequency_level": paper.equation_frequency_level,
        "max_depth": paper.max_depth,
        "max_output_pages": paper.max_output_pages,
        "language": paper.language,
        "author": paper.author,
        "childs": [child(s) for s in paper.sections],
    }
