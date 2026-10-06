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
# The API's trailing block ("\n\nWriting instructions: ..."), the same rule as
# api/application/graph_import.py; TXT outline bullets are brought into this
# shape by engine.spec.book_txt.summarize_body.
_WRITING_INSTRUCTIONS_RE = re.compile(r"(?:\A|\n\n)Writing instructions:.*\Z", re.DOTALL)


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


_RULE_RE = re.compile(r"^ {0,3}([-*_])( *\1){2,} *$")
_SETEXT_UNDERLINE_RE = re.compile(r"^ {0,3}(={3,}|-{3,}) *$")
_TABLE_DELIMITER_RE = re.compile(r"^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$")
# Emphasis wrappers that make a line a title: (opening, closing).
_TITLE_WRAPPERS = (
    ("***", "***"), ("___", "___"), ("**_", "_**"), ("_**", "**_"),
    ("*__", "__*"), ("__*", "*__"), ("**", "**"), ("__", "__"),
)
# A line that starts something other than a plain paragraph, so a lead-in is
# never merged into it and it is never a setext heading's text: indented code,
# ATX heading, list item, quote, table row, image, display math, fence, a line
# opening with bold (`**Note:** ...`, an inline lead-in already), a footnote
# definition, raw HTML or a LaTeX environment. A bare `*Italic* start`,
# `3.5 percent` or `-based` is ordinary text and is not matched.
_BLOCK_START_RE = re.compile(
    r"^(?: {4,}|\t)"
    r"|^\s*(?:#{1,6}\s|[-*+]\s|>|\||!\[|\$\$|\\\[|\d+[.)](?:\s|$)|```|~~~|\*\*"
    r"|\[\^[^\]]+\]:|<[A-Za-z/!]|\\begin\{)"
)
_MAX_TITLE_WORDS = 12
_MAX_SETEXT_WORDS = 10


def _indented(line: str) -> bool:
    return line.startswith(("  ", "\t"))


def _title_line_text(line: str) -> str | None:
    """The text of a title line: the whole (unindented) line wrapped in bold
    or bold-italic emphasis (`**x**`, `***x***`, `__x__`, `**_x_**`, ...),
    optionally followed by a `:` or `.` inside or outside the markers. None for
    anything else; in particular `**Note:** text` (bold at the start of a
    normal line), italic-only lines, and whole bold sentences or paragraphs
    (an internal sentence break or more than 12 words) are not title lines."""
    if _indented(line):
        return None
    text = line.strip()
    for opening, closing in _TITLE_WRAPPERS:
        if not (text.startswith(opening) and len(text) > len(opening) + len(closing)):
            continue
        rest = text[len(opening):]
        colon = ""
        trimmed = rest.rstrip()
        if trimmed[-1:] in (":", ".") and trimmed[:-1].rstrip().endswith(closing):
            colon = ":" if trimmed[-1] == ":" else ""
            trimmed = trimmed[:-1].rstrip()
        if not trimmed.endswith(closing):
            continue
        inner = trimmed[: -len(closing)].strip()
        if not inner or "**" in inner or "__" in inner:
            continue
        # Whole bold sentences are not titles; abbreviations (`**U.S. policy**`) are.
        if (re.search(r"[.!?]\s", inner) and inner[-1] in ".!?") or len(inner.split()) > _MAX_TITLE_WORDS:
            continue
        return inner + colon
    return None


def _lead_text(text: str) -> str:
    """Plain text of a heading: a balanced whole-text emphasis wrapper is
    unwrapped, inner bold markers are dropped (a lead-in is bold already)."""
    text = text.strip()
    text = _title_line_text(text) or text
    parts = re.split(r"(`[^`]*`)", text)  # code spans keep their characters
    text = "".join(p if p.startswith("`") else re.sub(r"\*\*|__", "", p) for p in parts)
    return re.sub(r"\s+", " ", text).strip()


def _lead_in(text: str) -> str:
    """`**Text.**`: a terminal `.`, `:`, `!` or `?` is kept, a period added
    otherwise."""
    if not text:
        return ""
    if text[-1] not in ".:!?":
        text += "."
    return f"**{text}**"


def _is_rule(line: str) -> bool:
    return bool(_RULE_RE.match(line))


def _is_plain_paragraph_line(line: str, following: str = "") -> bool:
    """Whether a lead-in may be merged into `line` (`following` is the line
    after it: a table header row is followed by a delimiter row)."""
    return (
        bool(line.strip())
        and not _BLOCK_START_RE.match(line)
        and not _HEADING_LINE_RE.match(line)
        and _title_line_text(line) is None
        and not _is_rule(line)
        and not _TABLE_DELIMITER_RE.match(following)
    )


def _is_setext_candidate(lines: list[str], i: int) -> bool:
    """`lines[i]` is the first line of a paragraph (after a blank line, a rule
    or the start of the body) and is plain text: the only shape a following
    `===`/`---` line can turn into a heading."""
    line = lines[i]
    if not line.strip() or _indented(line) or _BLOCK_START_RE.match(line) or _is_rule(line):
        return False
    # A rule at the very top (front matter) does not start a paragraph.
    return i == 0 or not lines[i - 1].strip() or (_is_rule(lines[i - 1]) and i > 1)


def _flatten_atx_only(lines: list[str]) -> list[str]:
    """Slide-body rule: ATX headings become standalone `**label**` lines, no
    other handling (`deck.slide_body` drops rules itself)."""
    out: list[str] = []
    in_fence = False
    for line in lines:
        if line.strip().startswith(("```", "~~~")):
            in_fence = not in_fence
            out.append(line)
            continue
        match = None if in_fence else _HEADING_LINE_RE.match(line)
        if not match:
            out.append(line)
            continue
        text = match.group(2).strip().strip("*").strip()
        if not text:
            continue
        if out and out[-1].strip():
            out.append("")
        out += [f"**{text}**", ""]
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(out))
    return text.split("\n")


def _flatten_headings(lines: list[str]) -> list[str]:
    """Body headings, title lines, setext headings and horizontal rules become
    run-in bold lead-ins (`**Resource integration.** Value emerges ...`): the
    outline is the document's structure, a body may not add levels of its own,
    and a model's workarounds (`***Title***` lines, `---` between blocks, a
    bold title glued to the next line) must not reach the PDF. Rules are
    dropped. A lead-in followed by a plain paragraph line is merged into it;
    before a list, equation, table, code or another lead-in it stays a
    paragraph of its own. Fenced code and indented lines are left alone."""
    # Pass 1: classify. Items are ("lead", text), ("rule", ""), ("code", line)
    # or ("line", line).
    items: list[tuple[str, str]] = []
    in_fence = False
    math_close: str | None = None  # closing delimiter of an open display-math block
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if math_close is not None:
            # Inside display math: verbatim until a line containing the opening
            # delimiter's closer (`$$ (1)`), and never across a blank line (pandoc's display
            # math cannot span one), so an unclosed `$$` cannot swallow the body.
            if not stripped:
                math_close = None
            else:
                if math_close in stripped:
                    math_close = None
                items.append(("code", line))
                i += 1
                continue
        if stripped.startswith(("```", "~~~")):
            in_fence = not in_fence
            items.append(("code", line))
            i += 1
            continue
        if in_fence:
            items.append(("code", line))
            i += 1
            continue
        if stripped in ("$$", "\\["):
            # A display-math block opened on a line of its own is kept verbatim.
            math_close = "$$" if stripped == "$$" else "\\]"
            items.append(("code", line))
            i += 1
            continue
        match = _HEADING_LINE_RE.match(line)
        if match:
            items.append(("lead", _lead_text(match.group(2))))
            i += 1
            continue
        title = _title_line_text(line)
        if title is not None:
            items.append(("lead", _lead_text(title)))
            i += 1
            continue
        underline = _SETEXT_UNDERLINE_RE.match(lines[i + 1]) if i + 1 < len(lines) else None
        if underline and _is_setext_candidate(lines, i):
            text = line.strip()
            if underline.group(1)[0] == "=" or (
                len(text.split()) <= _MAX_SETEXT_WORDS and text[-1] not in ".!?"
            ):
                items.append(("lead", _lead_text(text)))
                i += 2
                continue
        # A `===` line that did not start a setext heading is a stray underline: dropped.
        dropped = _is_rule(line) or _SETEXT_UNDERLINE_RE.match(line) and line.strip()[0] == "="
        items.append(("rule", "") if dropped else ("line", line))
        i += 1

    # Pass 2: render. Rules count as blank lines.
    out: list[str] = []
    pending: str | None = None  # a lead-in waiting for its paragraph line
    for idx, (kind, value) in enumerate(items):
        if kind == "rule" or (kind == "line" and not value.strip()):
            if pending is None:
                out.append("")
            continue  # blank lines between a lead-in and its paragraph vanish
        if pending is not None:
            following = items[idx + 1][1] if idx + 1 < len(items) and items[idx + 1][0] == "line" else ""
            if kind == "line" and _is_plain_paragraph_line(value, following):
                out.append(f"{pending} {value.strip()}")
                pending = None
                continue
            out += [pending, ""]
            pending = None
            if kind == "lead":
                pending = _lead_in(value) or None
                continue
            out.append(value)
            continue
        if kind == "lead":
            lead = _lead_in(value)
            if lead:
                if out and out[-1].strip():
                    out.append("")
                pending = lead
            continue
        out.append(value)
    if pending is not None:
        out += [pending, ""]
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(out))
    return text.split("\n")


def normalize_body(
    body: str, title: str, level: int, *, allow_headings: bool = False, lead_ins: bool = True
) -> str:
    """Drop a leading heading (or title line, or setext heading) that repeats
    the node title. Unless `allow_headings`, the body's own headings, title
    lines and rules are turned into run-in bold lead-ins (see
    `_flatten_headings`); with `lead_ins=False` (slides) only ATX headings
    become standalone `**label**` lines. With `allow_headings`, headings are
    shifted below the node heading (`level`) and nothing else is touched."""
    lines = body.split("\n")
    while lines and not lines[0].strip():
        lines.pop(0)
    if lines:
        first = _HEADING_LINE_RE.match(lines[0])
        if first and _norm(first.group(2)) == _norm(title):
            lines.pop(0)
        elif lead_ins and not allow_headings:
            repeated = _title_line_text(lines[0])
            if repeated is not None and _norm(repeated) == _norm(title):
                lines.pop(0)
            elif (
                len(lines) > 1
                and _SETEXT_UNDERLINE_RE.match(lines[1])
                and _norm(_lead_text(lines[0])) == _norm(title)
                and not _BLOCK_START_RE.match(lines[0])
            ):
                del lines[:2]
    if not allow_headings:
        flatten = _flatten_headings if lead_ins else _flatten_atx_only
        return "\n".join(flatten(lines)).strip()
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
    body_headings: bool = False,
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
        body = normalize_body(read_section(path), node_title, level, allow_headings=body_headings)
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
