"""Parser for `book_input.txt` (contract 3.2).

Accepted labels, case-insensitive, English or Czech (the API writes the
English ones; hand-written Czech specs such as `input/book/book_input.txt`
use the Czech ones):

    Title / Název            Summary / Obsah / Shrnutí / Popis / Anotace
    Target readers / Cílová skupina / Čtenáři / Audience
    Total pages / Počet stran / Rozsah     Additional requirements / Další požadavky
    Language / Jazyk (optional)            Author / Autor (optional)

An optional explicit outline uses `##`..`######` headings with a trailing
page hint `(N pages)` / `(N stran)` and `- ` bullets that become the node's
summary (the shape `api/application/book_spec.py:SpecRenderer` renders and
the old engine's `_extract_explicit_outline_from_txt` read).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

_LABELS: dict[str, tuple[str, ...]] = {
    "title": ("title", "název", "nazev", "titul", "book title"),
    "summary": ("summary", "obsah", "shrnutí", "shrnuti", "popis", "anotace", "description", "abstract"),
    "target_readers": ("target readers", "target audience", "audience", "cílová skupina", "cilova skupina", "čtenáři", "ctenari", "readers"),
    "total_pages": ("total pages", "pages", "počet stran", "pocet stran", "rozsah", "length"),
    "additional_requirements": ("additional requirements", "requirements", "další požadavky", "dalsi pozadavky", "požadavky", "pozadavky"),
    "language": ("language", "jazyk", "output language"),
    "author": ("author", "authors", "autor", "autoři", "autori"),
}
_IGNORED_LABELS = ("kapitoly", "chapters", "outline", "osnova")
_LABEL_RE = re.compile(r"^\s*([A-Za-zÀ-ž][A-Za-zÀ-ž ]{1,40}?)\s*:\s*(.*)$")
_HEADING_RE = re.compile(r"^(#{2,6})\s+(.+?)\s*$")
PAGE_HINT_RE = re.compile(
    r"\((?:~\s*)?(?P<pages>\d+(?:[.,]\d+)?)\s*(?:page|pages|strana|strany|stran|str\.?|slides?)?\)\s*$",
    re.IGNORECASE,
)
_ROOT_PAGE_HINT_RE = re.compile(
    r"(?:overall|total|celkov[ýaé]|rozsah).*?(?P<pages>\d+(?:[.,]\d+)?)\s*(?:pages?|stran|strany)",
    re.IGNORECASE,
)
_NUMBER_RE = re.compile(r"\d+(?:[.,]\d+)?")
_SCAFFOLD_LINES = {
    "content:", "obsah:", "framework:", "format:", "source:", "sources:", "zdroje:",
    "reference:", "references:", "literature:", "odkazy:", "zdroje a tutoriály:",
}


@dataclass
class OutlineSpecNode:
    title: str
    n_pages: float | None
    summary: str = ""
    children: list["OutlineSpecNode"] = field(default_factory=list)

    def to_structure(self) -> dict[str, Any]:
        children = [child.to_structure() for child in self.children]
        pages = self.n_pages
        if pages is None:
            pages = round(sum(float(c["n_pages"]) for c in children), 1) if children else 1.0
        out: dict[str, Any] = {
            "title": self.title,
            "summary": self.summary,
            "n_pages": float(pages),
            "needsSubdivision": bool(children),
            # An explicit outline is the author's structure: keep it, subdivide
            # only below it (the old engine's `_finalize_outline_node` rule).
            "structure_locked": True,
        }
        if children:
            out["childs"] = children
        return out


@dataclass
class BookSpec:
    title: str = ""
    summary: str = ""
    target_readers: str = ""
    total_pages: float | None = None
    additional_requirements: str = ""
    language: str | None = None
    author: str | None = None
    outline: list[OutlineSpecNode] = field(default_factory=list)
    extra: dict[str, str] = field(default_factory=dict)
    raw_text: str = ""

    @property
    def has_outline(self) -> bool:
        return bool(self.outline)


def _label_key(label: str) -> str | None:
    lowered = label.strip().casefold()
    for key, names in _LABELS.items():
        if lowered in names:
            return key
    return None


def normalize_outline_title(raw: str) -> tuple[str, float | None]:
    title = str(raw or "").strip()
    pages: float | None = None
    match = PAGE_HINT_RE.search(title)
    if match:
        pages = float(match.group("pages").replace(",", "."))
        title = title[: match.start()].rstrip()
    title = re.sub(r"^[*_`\s]+|[*_`\s]+$", "", title).strip()
    title = re.sub(
        r"^(?:chapter|kapitola|section|sekce|část|cast|part)\s+\d+(?:\.\d+)*\s*[:.\-–]\s*",
        "",
        title,
        flags=re.IGNORECASE,
    )
    title = re.sub(r"^\d+(?:\.\d+)*\s*(?:[:.\-–]\s*|\s+)", "", title).strip()
    return title, pages


def summarize_body(lines: list[str], max_chars: int = 1500) -> str:
    """Bullets and prose under a heading, flattened into one summary; source
    lists and bare URLs are dropped (they are not writing instructions)."""
    cleaned: list[str] = []
    skip_sources = False
    for raw in lines:
        stripped = raw.strip()
        if stripped.startswith("```"):
            continue
        if not stripped or stripped == "---":
            continue
        if re.match(r"^[*_`\s]*(?:sources?|references?|literature|zdroje|odkazy|literatura)\b[^:]*:?[ *_`\s]*$", stripped, re.IGNORECASE):
            skip_sources = True
            continue
        if skip_sources and not stripped.startswith(("**", "#")):
            continue
        skip_sources = False
        if stripped.lower().startswith(("http://", "https://")):
            continue
        line = re.sub(r"^[\-\*\+•>\s]+", "", stripped)
        line = re.sub(r"\*\*(.*?)\*\*", r"\1", line)
        line = re.sub(r"(?<!\w)\*(.*?)\*(?!\w)", r"\1", line)
        line = line.replace("`", "")
        line = re.sub(r"\s+", " ", line).strip()
        if line.lower() in _SCAFFOLD_LINES:
            continue
        if line:
            cleaned.append(line)
    summary = "\n".join(cleaned).strip()
    if len(summary) > max_chars:
        summary = summary[: max_chars - 3].rstrip() + "..."
    return summary


def parse_book_txt(text: str) -> BookSpec:
    spec = BookSpec(raw_text=text)
    current_label: str | None = None
    in_fence = False
    stack: list[tuple[int, OutlineSpecNode, list[str]]] = []
    bodies: list[tuple[OutlineSpecNode, list[str]]] = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("```"):
            in_fence = not in_fence
            if stack:
                stack[-1][2].append(line)
            continue
        heading = None if in_fence else _HEADING_RE.match(line)
        if heading:
            current_label = None
            level = len(heading.group(1))
            title, pages = normalize_outline_title(heading.group(2))
            if not title:
                continue
            node = OutlineSpecNode(title=title, n_pages=pages)
            body: list[str] = []
            while stack and stack[-1][0] >= level:
                stack.pop()
            if stack:
                stack[-1][1].children.append(node)
            else:
                spec.outline.append(node)
            stack.append((level, node, body))
            bodies.append((node, body))
            continue
        if stack:
            stack[-1][2].append(line)
            continue
        if in_fence:
            continue
        label = _LABEL_RE.match(line)
        if label:
            key = _label_key(label.group(1))
            if key is not None:
                current_label = key
                _append(spec, key, label.group(2).strip())
                continue
            if label.group(1).strip().casefold() in _IGNORED_LABELS:
                current_label = None
                continue
        if not stripped:
            current_label = None
            continue
        if current_label in {"summary", "additional_requirements", "target_readers"}:
            _append(spec, current_label, stripped)
    for node, body in bodies:
        node.summary = summarize_body(body)
    if spec.total_pages is None:
        for line in text.splitlines():
            match = _ROOT_PAGE_HINT_RE.search(line)
            if match:
                spec.total_pages = float(match.group("pages").replace(",", "."))
                break
    if spec.total_pages is None and spec.outline:
        pages = [n.to_structure()["n_pages"] for n in spec.outline]
        spec.total_pages = round(sum(pages), 1)
    return spec


def _append(spec: BookSpec, key: str, value: str) -> None:
    if key == "total_pages":
        match = _NUMBER_RE.search(value)
        if match:
            spec.total_pages = float(match.group(0).replace(",", "."))
        return
    if key == "language":
        spec.language = value.strip().lower() or None
        return
    if key == "author":
        spec.author = value.strip() or None
        return
    current = getattr(spec, key)
    setattr(spec, key, f"{current} {value}".strip() if current else value)
