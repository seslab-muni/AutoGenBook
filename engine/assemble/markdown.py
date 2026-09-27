"""Final Markdown document from the graph and `sections/<key>.md`.

Layout (compatible with the old engine and the API): `# <title>`, an
`**Author:** <names>` line (the API rewrites it on upload), then one heading
per node at level depth+1 in DFS order, each leaf followed by its section
body. Inline citations are resolved to numbered references and a
bibliography section closes the document.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from engine.assemble.citations import (
    CitationIndex,
    Numbering,
    bibliography_lines,
    references_title,
    resolve_numeric,
)
from engine.graph.doc_graph import DocGraph
from engine.graph.keys import ROOT
from engine.util.fs import decode_text_bytes

_HEADING_LINE_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
# From the API's trailing block ("\n\nWriting instructions: ...") or a TXT
# outline bullet ("- Writing instructions: ...") to the end of the summary.
_WRITING_INSTRUCTIONS_RE = re.compile(r"(?:\A|\n)[ \t]*(?:[-*][ \t]+)?Writing instructions:.*\Z", re.DOTALL)


def strip_writing_instructions(summary: str) -> str:
    """The API folds per-node options into a trailing `Writing instructions:`
    block of `summary`; it is a brief for the writer, never book content."""
    return _WRITING_INSTRUCTIONS_RE.sub("", summary or "").strip()


def section_path(out_dir: Path, key: str, node: dict[str, Any]) -> Path | None:
    """The section file of a leaf: `content_file_path` when it exists on this
    machine, else `sections/<key>.md` (or a legacy `.tex` from an old
    `--legacy-tex` run)."""
    raw = str(node.get("content_file_path") or "")
    if raw:
        candidate = Path(raw)
        if candidate.is_file():
            return candidate
    for ext in (".md", ".tex"):
        candidate = out_dir / "sections" / f"{key}{ext}"
        if candidate.is_file():
            return candidate
    return None


def read_section(path: Path) -> str:
    return decode_text_bytes(path.read_bytes()).replace("\r\n", "\n").strip()


def _norm(text: str) -> str:
    return re.sub(r"\W+", " ", text).strip().casefold()


def normalize_body(body: str, title: str, level: int) -> str:
    """Drop a leading heading that repeats the node title and shift the
    body's own headings below the node heading (`level`)."""
    lines = body.split("\n")
    while lines and not lines[0].strip():
        lines.pop(0)
    if lines:
        first = _HEADING_LINE_RE.match(lines[0])
        if first and _norm(first.group(2)) == _norm(title):
            lines.pop(0)
    in_fence = False
    levels: list[int] = []
    for line in lines:
        if line.strip().startswith(("```", "~~~")):
            in_fence = not in_fence
            continue
        match = None if in_fence else _HEADING_LINE_RE.match(line)
        if match:
            levels.append(len(match.group(1)))
    if levels:
        shift = max(0, (level + 1) - min(levels))
        if shift:
            in_fence = False
            out = []
            for line in lines:
                if line.strip().startswith(("```", "~~~")):
                    in_fence = not in_fence
                match = None if in_fence else _HEADING_LINE_RE.match(line)
                if match:
                    new_level = min(6, len(match.group(1)) + shift)
                    line = "#" * new_level + " " + match.group(2)
                out.append(line)
            lines = out
    return "\n".join(lines).strip()


@dataclass
class AssembledDocument:
    title: str
    author: str
    language: str
    body_markdown: str  # headings + sections + references, without title/author lines
    numbering: Numbering
    sections: list[tuple[str, str]] = field(default_factory=list)  # (key, body before citation resolution)
    missing: list[str] = field(default_factory=list)
    legacy_tex: bool = False

    @property
    def markdown(self) -> str:
        lines = [f"# {_heading_text(self.title)}", ""]
        if self.author:
            lines += [f"**Author:** {_heading_text(self.author)}", ""]
        return "\n".join(lines) + "\n" + self.body_markdown.rstrip() + "\n"


def _heading_text(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def assemble_document(
    graph: DocGraph,
    out_dir: Path,
    *,
    index: CitationIndex,
    language: str,
    author: str = "",
    front_matter: list[str] | None = None,
    numbering: Numbering | None = None,
    resolve: "Callable[[str, Numbering, str], str]" = resolve_numeric,
    bibliography: "Callable[[Numbering, str], list[str]] | None" = bibliography_lines,
) -> AssembledDocument:
    """`resolve` renders a section's citation markers (numbered by default),
    `bibliography` the closing reference list (None: no list, e.g. footnotes
    or a BibTeX-driven LaTeX build)."""
    numbering = numbering if numbering is not None else Numbering(index)
    title = str(graph.nodes.get(ROOT, {}).get("title") or graph.attrs.get("title") or "Book")
    doc = AssembledDocument(title=title, author=author, language=language, body_markdown="", numbering=numbering)
    parts: list[str] = list(front_matter or [])
    for key in graph.dfs():
        if key == ROOT:
            continue
        node = graph.nodes[key]
        level = min(6, graph.depth(key) + 1)
        node_title = _heading_text(str(node.get("title") or ""))
        if node_title:
            parts.append(f"{'#' * level} {node_title}")
        if not graph.is_leaf(key):
            continue
        path = section_path(out_dir, key, node)
        if path is None:
            doc.missing.append(key)
            continue
        if path.suffix.lower() == ".tex":
            doc.legacy_tex = True
        body = normalize_body(read_section(path), node_title, level)
        doc.sections.append((key, body))
        if body:
            parts.append(resolve(body, numbering, key))
    if numbering.numbers and bibliography is not None:
        parts.append(f"## {references_title(language)} {{.unnumbered}}")
        parts.extend(bibliography(numbering, language))
    doc.body_markdown = "\n\n".join(p for p in parts if p is not None) + "\n"
    return doc


def markdown_for_humans(doc: AssembledDocument) -> str:
    """The `.md` artifact: pandoc attributes (`{.unnumbered}`) are LaTeX-only."""
    return doc.markdown.replace(" {.unnumbered}", "")
