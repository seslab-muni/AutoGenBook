"""`presentation_input.txt` parser and the `presentation_structure.json` model.

Two spec shapes are accepted, English or Czech labels:

    Title / Název: ...                Summary / Shrnutí / Popis: ...
    Audience / Publikum: ...          Duration / Délka: 20 minutes
    Slides / Počet snímků: 12         Style / Styl: ...
    Author / Presenter / Autor: ...   Theme: Madrid
    Must include / Musí obsahovat: ...  Notes / Poznámky: ...
    Language / Jazyk: ...

and/or explicit slides (the old engine's `input/presentation` sample):

    Slide 3: Topic 1                  Snímek 3: Téma 1
    Text on slide:                    Text na snímku:
    • first bullet                    • první odrážka

Explicit slides are used verbatim as the slide list (no outline call); their
bullets become the slide's draft, which the writer refines rather than
replaces. `presentation_structure.json` keeps the old engine's keys
(`slides[]` with `title`, `summary`, `n_pages` = slide count,
`needsSubdivision`, plus the deck settings) so old files load unchanged.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from engine.graph.doc_graph import _coerce_bool, _coerce_float
from engine.spec.book_txt import BookSpec

_LABELS: dict[str, tuple[str, ...]] = {
    "title": ("title", "název", "nazev", "presentation title", "název prezentace"),
    "summary": ("summary", "description", "abstract", "shrnutí", "shrnuti", "popis", "anotace", "obsah"),
    "audience": ("audience", "target audience", "publikum", "cílová skupina", "cilova skupina", "posluchači"),
    "duration": ("duration", "length", "talk length", "délka", "delka", "doba", "trvání", "trvani"),
    "slide_count": ("slides", "slide count", "number of slides", "desired slide count", "počet snímků", "pocet snimku", "počet slidů", "pocet slidu"),
    "style": ("style", "tone", "styl", "tón"),
    "author": ("author", "presenter", "speaker", "autor", "přednášející", "prednasejici"),
    "theme": ("theme", "beamer theme", "motiv"),
    "must_include": ("must include", "required content", "musí obsahovat", "musi obsahovat", "povinný obsah"),
    "notes": ("notes", "additional requirements", "requirements", "poznámky", "poznamky", "požadavky", "pozadavky"),
    "language": ("language", "jazyk", "output language"),
}
_LABEL_RE = re.compile(r"^\s*([A-Za-zÀ-ž][A-Za-zÀ-ž ]{1,40}?)\s*:\s*(.*)$")
_SLIDE_RE = re.compile(r"^\s*(?:#+\s*)?(?:slide|snímek|snimek|slajd|folie)\s+(\d+)\s*[:.)\-–]\s*(.*?)\s*$", re.IGNORECASE)
_BODY_LABEL_RE = re.compile(r"^\s*(?:text on (?:the )?slide|slide text|text na snímku|text na snimku|obsah snímku|obsah snimku)\s*:\s*(.*)$", re.IGNORECASE)
_BULLET_RE = re.compile(r"^\s*(?:[•●▪◦‣∙·*+\-–]|\d+[.)])\s+")
_NUMBER_RE = re.compile(r"\d+(?:[.,]\d+)?")
DEFAULT_SLIDES = 10
_GENERIC_FIRST_TITLES = {"úvod", "uvod", "introduction", "intro", "title", "title slide", "titulní snímek", "titulni snimek", "welcome"}


@dataclass
class SlideSpec:
    title: str
    bullets: list[str] = field(default_factory=list)

    @property
    def draft(self) -> str:
        return "\n".join(f"- {b}" for b in self.bullets)


@dataclass
class PresentationSpec(BookSpec):
    audience: str = ""
    duration_minutes: float | None = None
    slide_count: int | None = None
    style: str = ""
    theme: str = ""
    must_include: str = ""
    notes: str = ""
    slides: list[SlideSpec] = field(default_factory=list)

    @property
    def has_slides(self) -> bool:
        return bool(self.slides)

    def target_slides(self) -> int:
        if self.slide_count:
            return self.slide_count
        if self.slides:
            return len(self.slides)
        if self.duration_minutes:
            return max(3, min(40, round(self.duration_minutes / 1.5)))
        return DEFAULT_SLIDES


def _label_key(label: str) -> str | None:
    lowered = label.strip().casefold()
    for key, names in _LABELS.items():
        if lowered in names:
            return key
    return None


def _first_number(value: str) -> float | None:
    match = _NUMBER_RE.search(value)
    return float(match.group(0).replace(",", ".")) if match else None


def parse_presentation_txt(text: str) -> PresentationSpec:
    spec = PresentationSpec(raw_text=text)
    current: SlideSpec | None = None
    last_key: str | None = None
    for raw in text.splitlines():
        line = raw.rstrip()
        slide = _SLIDE_RE.match(line)
        if slide:
            current = SlideSpec(title=slide.group(2).strip() or f"Slide {slide.group(1)}")
            spec.slides.append(current)
            last_key = None
            continue
        if current is not None:
            body = _BODY_LABEL_RE.match(line)
            if body:
                if body.group(1).strip():
                    current.bullets.append(body.group(1).strip())
                continue
            if line.strip():
                label = _LABEL_RE.match(line)
                if label and _label_key(label.group(1)) and not _BULLET_RE.match(line):
                    current = None  # a spec label after the slides ends the slide list
                else:
                    current.bullets.append(_BULLET_RE.sub("", line).strip())
                    continue
            else:
                continue
        label = _LABEL_RE.match(line)
        key = _label_key(label.group(1)) if label else None
        if key is not None and label is not None:
            _set(spec, key, label.group(2).strip())
            last_key = key
        elif line.strip() and last_key in {"summary", "notes", "must_include", "style"}:
            _set(spec, last_key, line.strip(), append=True)
        elif not line.strip():
            last_key = None
    if not spec.title and spec.slides:
        first = spec.slides[0]
        # "Slide 1: Introduction / • Course X ..." names the talk in its first bullet.
        generic = first.title.casefold() in _GENERIC_FIRST_TITLES
        spec.title = first.bullets[0] if (generic and first.bullets) else first.title
    spec.target_readers = spec.audience
    extras = [f"Must include: {spec.must_include}" if spec.must_include else "", spec.notes]
    spec.additional_requirements = "\n".join(e for e in extras if e)
    if spec.slide_count:
        spec.total_pages = float(spec.slide_count)
    return spec


def _set(spec: PresentationSpec, key: str, value: str, *, append: bool = False) -> None:
    if key == "duration":
        spec.duration_minutes = _first_number(value)
    elif key == "slide_count":
        number = _first_number(value)
        spec.slide_count = int(number) if number else None
    elif key in {"title", "summary", "audience", "style", "author", "theme", "must_include", "notes", "language"}:
        old = getattr(spec, key) or ""
        setattr(spec, key, f"{old} {value}".strip() if append else value)


# ------------------------------------------------------------ structure JSON
class SlideNode(BaseModel):
    model_config = ConfigDict(extra="ignore")

    title: str = ""
    summary: str = ""
    n_pages: float = 1.0  # slides, as in the old engine
    needsSubdivision: bool = False
    slide_draft: str = ""
    structure_locked: bool = False
    content_locked: bool = False
    content_file: str = ""
    kb_scope: str = "inherit"
    kb_sources: list[str] = Field(default_factory=list)
    childs: list["SlideNode"] = Field(default_factory=list)


class PresentationStructure(BaseModel):
    model_config = ConfigDict(extra="ignore")

    title: str = "Untitled Presentation"
    summary: str = ""
    audience: str = ""
    duration_minutes: float = 15.0
    style_guidance: str = ""
    theme: str = "Madrid"
    paginate: bool = False
    outline: bool = True
    author: str = ""
    header: str = ""
    footer: str = ""
    max_depth: int = 3
    max_output_pages: float = 1.0
    n_pages: float = 0.0
    additional_requirements: str = ""
    language: str | None = None
    slides: list[SlideNode] = Field(default_factory=list)


def normalize_presentation_structure(raw: dict[str, Any]) -> PresentationStructure:
    """Old-engine `_normalize_presentation_json` semantics: `slides` (or
    `childs`/`sections`), `n_pages` >= 0.1, `needsSubdivision` defaulting to
    `n_pages > max_output_pages`."""
    data = dict(raw or {})
    max_pages = max(0.5, _coerce_float(data.get("max_output_pages", 1.0), 1.0))
    slides = next((data.get(k) for k in ("slides", "childs", "sections") if isinstance(data.get(k), list)), [])

    def node(item: dict[str, Any]) -> dict[str, Any]:
        nested = next((item.get(k) for k in ("childs", "slides", "subsections", "children") if isinstance(item.get(k), list)), [])
        children = [node(c) for c in nested if isinstance(c, dict)]
        pages = max(0.1, _coerce_float(item.get("n_pages", item.get("n_slides", 1.0)), 1.0))
        return {
            "title": str(item.get("title", "") or "").strip(),
            "summary": str(item.get("summary", "") or "").strip(),
            "n_pages": pages,
            "needsSubdivision": bool(children) or _coerce_bool(item.get("needsSubdivision", pages > max_pages), pages > max_pages),
            "slide_draft": str(item.get("slide_draft", "") or "").strip(),
            "structure_locked": _coerce_bool(item.get("structure_locked", False)) or _coerce_bool(item.get("content_locked", False)),
            "content_locked": _coerce_bool(item.get("content_locked", False)),
            "content_file": str(item.get("content_file", "") or "").strip(),
            "kb_scope": str(item.get("kb_scope", "inherit") or "inherit"),
            "kb_sources": [str(s) for s in (item.get("kb_sources") or []) if str(s).strip()],
            "childs": children,
        }

    nodes = [node(s) for s in slides if isinstance(s, dict)]
    total = sum(n["n_pages"] for n in nodes)
    theme = str(data.get("theme", "") or "").strip()
    return PresentationStructure.model_validate({
        "title": str(data.get("title", "") or "").strip() or "Untitled Presentation",
        "summary": str(data.get("summary", "") or "").strip(),
        "audience": str(data.get("audience", "") or "").strip(),
        "duration_minutes": _coerce_float(data.get("duration_minutes", 15), 15.0),
        "style_guidance": str(data.get("style_guidance", "") or "").strip(),
        "theme": "Madrid" if not theme or theme.lower() == "beamer" else theme,
        "paginate": _coerce_bool(data.get("paginate", False)),
        "outline": _coerce_bool(data.get("outline", True), True),
        "author": str(data.get("author", "") or "").strip(),
        "header": str(data.get("header", "") or "").strip(),
        "footer": str(data.get("footer", "") or "").strip(),
        "max_depth": max(1, int(_coerce_float(data.get("max_depth", 3), 3))),
        "max_output_pages": max_pages,
        "n_pages": _coerce_float(data.get("n_pages", total), total) or total,
        "additional_requirements": str(data.get("additional_requirements", "") or "").strip(),
        "language": (str(data.get("language")).strip().lower() or None) if data.get("language") else None,
        "slides": nodes,
    })


DECK_ATTRS = ("audience", "duration_minutes", "style_guidance", "theme", "paginate", "outline", "header", "footer")


def presentation_to_book_structure(deck: PresentationStructure) -> dict[str, Any]:
    """The book-shaped dict `graph_from_structure` builds the graph from
    (slides become the root's children; the root stays `book`)."""

    def child(slide: SlideNode) -> dict[str, Any]:
        out = slide.model_dump()
        out["childs"] = [child(c) for c in slide.childs]
        return out

    return {
        "title": deck.title,
        "summary": deck.summary,
        "n_pages": deck.n_pages,
        "target_readers": deck.audience,
        "additional_requirements": deck.additional_requirements,
        "max_depth": deck.max_depth,
        "max_output_pages": deck.max_output_pages,
        "language": deck.language,
        "author": deck.author or None,
        "childs": [child(s) for s in deck.slides],
    }


def parse_slide_ranges(value: str) -> set[int]:
    """`--presentation-exclude-slides` ("2,5,10-12"); bad parts are ignored."""
    out: set[int] = set()
    for part in (value or "").split(","):
        part = part.strip()
        if not part:
            continue
        match = re.fullmatch(r"(\d+)\s*-\s*(\d+)", part)
        if match:
            lo, hi = sorted((int(match.group(1)), int(match.group(2))))
            out.update(range(lo, hi + 1))
        elif part.isdigit():
            out.add(int(part))
    return out
