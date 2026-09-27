"""Prompt-building helpers shared by the document pipelines."""

from __future__ import annotations

import json
import math
import re
from typing import Any, Iterable

from engine.agents.models import Glossary
from engine.assemble.citations import CitationIndex, find_citations
from engine.assemble.markdown import normalize_body, strip_writing_instructions
from engine.graph.doc_graph import DocGraph
from engine.graph.keys import ROOT

# Page budget: a page is 40 typeset lines of ~90 characters. A Markdown
# paragraph is one source line, so a non-blank line counts ceil(len/90).
LINES_PER_PAGE = 40
CHARS_PER_LINE = 90
WORDS_PER_LINE = 13.5
LENGTH_TOLERANCE = 0.25

EQUATION_GUIDANCE = {
    1: "Avoid formulas; explain everything in words. Use an equation only when it cannot be avoided.",
    2: "Use formulas sparingly; prose carries the explanation and simple equations support it.",
    3: "Balance prose and formulas: equations state key relationships, prose explains them.",
    4: "Use formulas actively to state concepts precisely, always explained in the surrounding prose.",
    5: "Express concepts and relationships through equations wherever it helps; derive where appropriate.",
}


def effective_lines(text: str) -> int:
    return sum(max(1, math.ceil(len(line.strip()) / CHARS_PER_LINE)) for line in text.splitlines() if line.strip())


def target_lines(n_pages: float) -> int:
    return max(4, int(round(float(n_pages or 1.0) * LINES_PER_PAGE)))


def lines_to_words(lines: int) -> int:
    return max(40, int(round(lines * WORDS_PER_LINE)))


def word_count(text: str) -> int:
    return len(re.findall(r"\w+", text))


def equation_guidance(level: Any) -> str:
    try:
        return EQUATION_GUIDANCE[max(1, min(5, int(level)))]
    except (TypeError, ValueError):
        return EQUATION_GUIDANCE[3]


def outline_text(graph: DocGraph, *, focus: str | None = None, with_summaries: str = "focus-chapter", max_summary: int = 220) -> str:
    """Indented outline. Summaries are shown for the focus node's chapter only
    (titles elsewhere), which keeps prompts of 100-leaf books compact."""
    focus_chapter = None
    if focus is not None and focus != ROOT:
        chain = [focus] + graph.ancestors(focus)
        focus_chapter = next((k for k in chain if graph.parent.get(k) == ROOT), focus)
    lines: list[str] = []
    for key in graph.dfs():
        if key == ROOT:
            continue
        node = graph.nodes[key]
        depth = graph.depth(key)
        pages = node.get("n_pages")
        marker = "   <== THIS SECTION" if key == focus else ""
        page_text = f" ({float(pages):g} p.)" if isinstance(pages, (int, float)) else ""
        lines.append(f"{'  ' * (depth - 1)}{key} {node.get('title', '')}{page_text}{marker}")
        show = with_summaries == "all" or (
            with_summaries == "focus-chapter" and focus_chapter is not None
            and (key == focus_chapter or focus_chapter in graph.ancestors(key))
        )
        summary = strip_writing_instructions(str(node.get("summary") or ""))
        if show and summary:
            short = summary if len(summary) <= max_summary else summary[: max_summary - 3].rstrip() + "..."
            lines.append(f"{'  ' * depth}- {short}")
    return "\n".join(lines) or "(no outline)"


def glossary_text(glossary: Glossary | None, max_chars: int = 4000) -> str:
    if glossary is None:
        return "(none)"
    parts: list[str] = []
    if glossary.terms:
        parts.append("Terms:")
        parts += [f"- {t.term}: {t.definition}" + (f" ({t.note})" if t.note else "") for t in glossary.terms]
    if glossary.notation:
        parts.append("Notation:")
        parts += [f"- {n.symbol}: {n.meaning}" for n in glossary.notation]
    if glossary.audience:
        parts.append(f"Audience: {glossary.audience}")
    if glossary.tone:
        parts.append(f"Tone: {glossary.tone}")
    if glossary.conventions:
        parts.append("Conventions:")
        parts += [f"- {c}" for c in glossary.conventions]
    text = "\n".join(parts) or "(none)"
    return text if len(text) <= max_chars else text[: max_chars - 3] + "..."


def heading_rule(graph: DocGraph, key: str) -> str:
    # The node's own heading is level depth+1 in the assembled document, so
    # body sub-headings start one level below it; past `######` there is none.
    level = graph.depth(key) + 2
    if level > 6:
        return "Do not use headings inside the body."
    return f"Use sub-headings only if the section is long, starting at level {'#' * level} (never higher)."


_FENCE_WRAP_RE = re.compile(r"^\s*```(?:markdown|md)?\s*\n(.*)\n```\s*$", re.DOTALL | re.IGNORECASE)
_LATEX_CITE_RE = re.compile(r"\\cite[pt]?\*?(?:\[[^\]]*\])?\{([^{}]*)\}")
_FOOTNOTE_SOURCE_RE = re.compile(r"\\footnote\{\s*(?:Source|Zdroj)\s*:\s*([^{}]*)\}", re.IGNORECASE)


def clean_body(body: str, title: str, graph: DocGraph, key: str, index: CitationIndex) -> str:
    """Normalise a model-written body: unwrap a whole-body code fence, drop a
    repeated title heading, fix heading levels, and rewrite `\\cite{}` and
    `\\footnote{Source: RID:...}` into `[cite_key]` markers."""
    text = (body or "").replace("\r\n", "\n").strip()
    match = _FENCE_WRAP_RE.match(text)
    if match:
        text = match.group(1).strip()

    def cite_repl(m: re.Match[str]) -> str:
        keys = [index.canonical(k.strip()) for k in m.group(1).split(",") if k.strip()]
        return "[" + "; ".join(keys) + "]" if keys else ""

    text = _LATEX_CITE_RE.sub(cite_repl, text)
    text = _FOOTNOTE_SOURCE_RE.sub(cite_repl, text)
    level = min(6, graph.depth(key) + 1)
    return normalize_body(text, title, level)


def invalid_citations(body: str, index: CitationIndex) -> list[str]:
    bad: list[str] = []
    for match in find_citations(body, index):
        for token in match.keys:
            if not index.known(token) and token not in bad:
                bad.append(token)
    return bad


def strip_citations(body: str, tokens: Iterable[str], index: CitationIndex | None = None) -> str:
    """Remove the given citation tokens (hallucinated keys) from the markers
    `invalid_citations` found - the same spans, so code blocks and link
    labels are never touched. A marker left without keys disappears together
    with the space before it."""
    drop = set(tokens)
    out: list[str] = []
    pos = 0
    for match in find_citations(body, index or CitationIndex()):
        if not any(k.strip() in drop for k in match.keys):
            continue
        out.append(body[pos : match.start])
        kept = [k.strip() for k in match.keys if k.strip() not in drop]
        if kept:
            out.append("[" + "; ".join(kept) + "]")
        elif out and out[-1].endswith(" "):
            out[-1] = out[-1].rstrip(" ")
        pos = match.end
    out.append(body[pos:])
    return "".join(out)


def dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2)
