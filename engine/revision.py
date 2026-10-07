"""`engine.revise(request, sink) -> ReviseResult`: revise one section's existing
text in-process (issue #182, the Studio copilot).

Unlike `engine.run` there is no run directory, no `structure_graph.json`, no
queue and no file is written: the result is a pure function of the request
(the section text, the author's instruction, typed parameters, the section
brief, the LLM settings and an optional prebuilt knowledge base). The caller
decides what to do with the suggestion; nothing changes until it applies it.

* `scope="section"`: the model returns the whole revised body; the hunks come
  from a word-level diff against the original.
* `scope="range"`: the model is asked only for the replacement of the anchored
  range (the section is given as context); the engine splices it in, so text
  outside the range is unchanged by construction, and still verifies it.

Parameters ("chips") are typed fields rendered into the prompt
deterministically (`render_requirements`); progress goes to the `EventSink`
as stages `retrieve`, `revise` and `diff`; cancelling the awaiting task is
clean (the LLM client is closed either way).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx

from engine.agents.base import Agent
from engine.agents.models import RangeRevision, SectionRevision
from engine.assemble.citations import CitationIndex
from engine.config import LLMSettings, RetrievalSettings
from engine.errors import AnchorOrphaned, InputError, ReviseError
from engine.events import EventSink
from engine.llm.client import LLMClient
from engine.llm.usage import UsageLedger
from engine.pipeline.text import equation_guidance, invalid_citations, lines_to_words, single_key_citations, strip_citations, target_lines, unwrap_fence
from engine.retrieval.context import format_context
from engine.retrieval.kb import HybridRetriever, KnowledgeBase
from engine.spec.language import detect_language, language_name, normalize_language
from engine.util.anchors import resolve_anchor
from engine.util.textdiff import Hunk, apply_hunks, diff_hunks

SECTION_REVISER = Agent("book/copilot_reviser", SectionRevision, "copilot.revise")
RANGE_REVISER = Agent("book/copilot_range", RangeRevision, "copilot.revise_range")
RANGE_MARKER = "[[SELECTED PASSAGE]]"
Scope = Literal["section", "range"]


@dataclass(frozen=True)
class ReviseParams:
    """The copilot's parameter chips. `fix_issues` are reviewer issue dicts
    (`type, severity, description, required_fix`, optionally `quote`,
    `replace_from`, `replace_to`); `address_comments` are comment texts."""

    more_proofs: bool = False
    more_examples: bool = False
    more_rigorous: bool = False
    shorter: bool = False
    longer: bool = False
    cite_sources: bool = False
    fix_issues: tuple[dict[str, Any], ...] = ()
    address_comments: tuple[str, ...] = ()


@dataclass(frozen=True)
class SectionBrief:
    """What the section is and the chapter options that ride along."""

    title: str = ""
    summary: str = ""
    book_title: str = ""
    target_readers: str = ""
    document_kind: str = "book"
    language: str | None = None  # code (`en`, `cs`); None = detected from the text
    target_pages: float | None = None
    equation_density: int | None = None  # 1..5
    math_level: str = ""
    sub_prompt: str = ""
    outline: str = ""  # the outline as text, the section marked; free-form
    neighbours: str = ""  # previous / next section summaries; free-form
    glossary: str = ""


@dataclass(frozen=True)
class ReviseRetrieval:
    """A prebuilt knowledge base to ground the revision in (lexical search; no
    files are written). `kb_sources` restricts it to the section's sources."""

    kb: KnowledgeBase
    kb_sources: tuple[str, ...] | None = None
    settings: RetrievalSettings = field(default_factory=RetrievalSettings)


@dataclass(frozen=True)
class ReviseRequest:
    body_markdown: str
    instruction: str = ""
    scope: Scope = "section"
    anchor: dict[str, Any] | None = None  # required for scope="range" (engine.util.anchors)
    params: ReviseParams = field(default_factory=ReviseParams)
    brief: SectionBrief = field(default_factory=SectionBrief)
    llm: LLMSettings = field(default_factory=LLMSettings)
    retrieval: ReviseRetrieval | None = None


@dataclass
class ReviseResult:
    replacement_markdown: str  # the full new section body
    original_markdown: str  # the body as given (hunk offsets index this)
    hunks: list[Hunk]
    summary: str
    changes_made: list[str]
    usage: dict[str, Any]
    scope: Scope
    anchor: dict[str, Any] | None  # the range as resolved in original_markdown
    dropped_citations: list[str] = field(default_factory=list)
    model: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "replacement_markdown": self.replacement_markdown,
            "original_markdown": self.original_markdown,
            "hunks": [h.to_dict() for h in self.hunks],
            "summary": self.summary,
            "changes_made": list(self.changes_made),
            "usage": self.usage,
            "scope": self.scope,
            "anchor": self.anchor,
            "dropped_citations": list(self.dropped_citations),
            "model": self.model,
        }


# ------------------------------------------------------------------- prompts
_CHIPS = (
    ("more_proofs", "Add rigorous proofs, or proof sketches where a full proof is out of scope, for the claims that are stated without one."),
    ("more_examples", "Add concrete worked examples that illustrate the key ideas."),
    ("more_rigorous", "Make the argument more rigorous: state assumptions and definitions precisely before using them, replace hand-waving with exact statements."),
    ("shorter", "Make the text noticeably shorter: cut redundancy and filler, keep every essential point."),
    ("longer", "Expand the text: develop the explanations and add the missing detail, without padding."),
    ("cite_sources", "Support factual claims with citations to the retrieved excerpts, using their keys exactly as shown; leave a claim uncited when no excerpt supports it."),
)


def _issue_line(number: int, issue: dict[str, Any]) -> str:
    head = f"{number}. [{issue.get('severity') or 'minor'}] {issue.get('type') or 'other'}: {str(issue.get('description') or '').strip()}"
    fix = str(issue.get("required_fix") or "").strip()
    if fix:
        head += f" -> {fix}"
    quote = str(issue.get("quote") or "").strip()
    if quote:
        head += f"\n   Passage: {quote!r}"
    if issue.get("replace_from") and issue.get("replace_to") is not None:
        head += f"\n   Literal replacement: {issue['replace_from']!r} -> {issue['replace_to']!r}"
    return head


def render_requirements(params: ReviseParams, *, have_sources: bool = True) -> str:
    """The chips as prompt text, in a fixed order (deterministic)."""
    if params.shorter and params.longer:
        raise InputError("`shorter` and `longer` cannot both be set")
    lines = [f"- {text}" for name, text in _CHIPS if getattr(params, name) and (name != "cite_sources" or have_sources)]
    if params.fix_issues:
        lines.append("- Fix these reviewer issues (most severe first):")
        order = {"critical": 0, "major": 1, "minor": 2}
        issues = sorted(params.fix_issues, key=lambda i: order.get(str(i.get("severity")), 3))
        lines += ["  " + _issue_line(n, issue).replace("\n", "\n  ") for n, issue in enumerate(issues, 1)]
    if params.address_comments:
        lines.append("- Address these comments from the author's colleagues:")
        lines += [f"  {n}. {' '.join(str(c).split())}" for n, c in enumerate(params.address_comments, 1)]
    return "\n".join(lines) or "(none beyond the request)"


def render_writing_settings(brief: SectionBrief) -> str:
    lines: list[str] = []
    if brief.target_pages:
        lines.append(f"- Target length of the section: about {lines_to_words(target_lines(brief.target_pages))} words (a guideline; the request wins).")
    if brief.equation_density:
        lines.append(f"- Equation density {brief.equation_density}/5: {equation_guidance(brief.equation_density)}")
    if brief.math_level:
        lines.append(f"- Math level: {brief.math_level}.")
    if brief.sub_prompt.strip():
        lines.append(f"- Standing instructions: {' '.join(brief.sub_prompt.split())}")
    return "\n".join(lines) or "(none)"


def _validate(request: ReviseRequest) -> None:
    if request.scope not in ("section", "range"):
        raise InputError(f"unknown scope {request.scope!r} (expected 'section' or 'range')")
    if not request.body_markdown.strip():
        raise InputError("the section is empty; there is nothing to revise")
    p = request.params
    if not (request.instruction.strip() or p.more_proofs or p.more_examples or p.more_rigorous or p.shorter or p.longer
            or p.cite_sources or p.fix_issues or p.address_comments):
        raise InputError("nothing to do: give an instruction or at least one parameter")
    if p.shorter and p.longer:
        raise InputError("`shorter` and `longer` cannot both be set")
    if request.scope == "range" and not (request.anchor and str(request.anchor.get("quote") or "").strip()):
        raise InputError("a range revision needs an anchor with a quote")


# ----------------------------------------------------------------- retrieval
async def _retrieve(request: ReviseRequest, range_text: str | None, sink: EventSink) -> tuple[str, CitationIndex | None]:
    spec = request.retrieval
    if spec is None or not spec.kb.chunks:
        if request.params.cite_sources:
            sink.emit("retrieve", "No knowledge base is available; the revision cannot add citations", level="warning")
        return "(none)", None
    brief, settings = request.brief, spec.settings
    queries = [" ".join(q.split()) for q in (
        f"{request.instruction} {range_text or ''}".strip()[:600],
        f"{brief.title} {brief.summary}".strip()[:600],
    )]
    queries = [q for q in dict.fromkeys(queries) if q]
    sink.emit("retrieve", "Retrieving context from the knowledge base", payload={"phase": "start", "queries": queries})
    retriever = HybridRetriever(spec.kb, candidates=settings.candidates, item_chars=settings.item_chars, rerankers=())
    sources = list(spec.kb_sources) if spec.kb_sources is not None else None
    items = await retriever.search(queries, k=settings.top_k, kb_sources=sources, use_dense=False)
    text = format_context(items, max_chars_total=settings.max_chars_total, item_chars=settings.item_chars)
    sink.emit("retrieve", f"Retrieved {len(items)} passage(s)", payload={"phase": "done", "passages": len(items)})
    return text or "(none)", CitationIndex.from_kb_sources(spec.kb.kb_sources_json())


def _check_citations(new: str, reference: str, index: CitationIndex | None, sink: EventSink) -> tuple[str, list[str]]:
    """With a knowledge base: `\\cite{}` forms become `[key]` markers and keys
    the model invented (not in the KB and not already in the text) are removed."""
    if index is None:
        return new, []
    new = single_key_citations(new, index)
    known = set(invalid_citations(reference, index))
    bad = [k for k in invalid_citations(new, index) if k not in known]
    if bad:
        sink.emit("revise", f"Removed {len(bad)} citation(s) of unknown keys: {', '.join(bad[:10])}", level="warning")
        new = strip_citations(new, bad, index)
    return new, bad


def _with_edge_whitespace(model_text: str, original: str) -> str:
    """The model's text with the leading/trailing whitespace of `original`, so
    paragraph spacing at the edges never shows up as an edit."""
    lead = original[: len(original) - len(original.lstrip())]
    trail = original[len(original.rstrip()):]
    return lead + model_text.strip() + trail


# --------------------------------------------------------------------- entry
async def revise(request: ReviseRequest, sink: EventSink, *, transport: httpx.AsyncBaseTransport | None = None) -> ReviseResult:
    """Revise one section (or one range of it); see the module docstring.
    `transport`, when given, carries every outbound HTTP request (tests inject
    the fake LLM here)."""
    _validate(request)
    ledger = UsageLedger(None)
    llm = LLMClient(request.llm, ledger=ledger, sink=sink, concurrency=2, transport=transport)
    try:
        return await _revise(request, sink, llm, ledger)
    finally:
        try:
            await asyncio.shield(llm.aclose())
        except Exception:  # noqa: BLE001 - closing must never mask the result
            pass


async def _revise(request: ReviseRequest, sink: EventSink, llm: LLMClient, ledger: UsageLedger) -> ReviseResult:
    original = request.body_markdown
    brief = request.brief
    anchor: dict[str, Any] | None = None
    span: tuple[int, int] | None = None
    if request.scope == "range":
        assert request.anchor is not None
        anchor = resolve_anchor(original, request.anchor)
        if anchor["start"] is None:
            raise AnchorOrphaned(str(request.anchor.get("quote") or ""))
        span = (anchor["start"], anchor["end"])
    range_text = original[span[0]:span[1]] if span else None
    sink.emit("revise", f"Revising the {'selected range' if span else 'section'}", payload={"phase": "start", "scope": request.scope})

    context, index = await _retrieve(request, range_text, sink)
    language = normalize_language(brief.language) or detect_language(original)
    values: dict[str, Any] = {
        "language_name": language_name(language),
        "document_kind": brief.document_kind or "book",
        "book_title": brief.book_title or "(untitled)",
        "target_readers": brief.target_readers or "(not specified)",
        "glossary": brief.glossary or "(none)",
        "neighbours": brief.neighbours or "(not provided)",
        "outline": brief.outline or "(not provided)",
        "section_title": brief.title or "(untitled section)",
        "section_summary": brief.summary or "(no summary)",
        "writing_settings": render_writing_settings(brief),
        "instruction": request.instruction.strip() or "(no free-text request; apply the revision requirements)",
        "requirements": render_requirements(request.params, have_sources=index is not None),
        "retrieved_context": context,
    }
    sink.emit("revise", "Asking the model for the revision", payload={"phase": "model"})
    if span is None:
        revision = await SECTION_REVISER.run(llm, {**values, "section_body": original})
        model_body = unwrap_fence(revision.body_markdown)
        if not model_body.strip():
            raise ReviseError("the model returned an empty section")
        new_text, dropped = _check_citations(model_body, original, index, sink)
        replacement = _with_edge_whitespace(new_text, original)
        summary, changes = revision.summary, revision.changes_made
    else:
        start, end = span
        values["section_context"] = original[:start] + RANGE_MARKER + original[end:]
        values["range_text"] = original[start:end]
        revision_r = await RANGE_REVISER.run(llm, values)
        model_range = unwrap_fence(revision_r.replacement_markdown).replace(RANGE_MARKER, "")
        if not model_range.strip():
            raise ReviseError("the model returned an empty replacement for the selected range")
        new_range, dropped = _check_citations(model_range, original[start:end], index, sink)
        replacement = original[:start] + _with_edge_whitespace(new_range, original[start:end]) + original[end:]
        summary, changes = revision_r.summary, revision_r.changes_made
        # Outside the range nothing may differ: true by construction, verified anyway.
        if not (replacement.startswith(original[:start]) and replacement.endswith(original[end:])):
            raise ReviseError("internal error: text outside the selected range changed")

    sink.emit("diff", "Computing the changes", payload={"phase": "start"})
    if span is None:
        hunks = await asyncio.to_thread(diff_hunks, original, replacement)
    else:
        start, end = span
        new_range_full = replacement[start:len(replacement) - (len(original) - end)]
        hunks = await asyncio.to_thread(diff_hunks, original[start:end], new_range_full, base=start)
    if apply_hunks(original, hunks) != replacement:  # the hunks are the contract; never ship ones that do not add up
        raise ReviseError("internal error: the computed changes do not reproduce the revision")
    sink.emit("diff", f"{len(hunks)} change(s)", payload={"phase": "done", "hunks": len(hunks)})
    usage = ledger.totals()
    sink.emit("revise", "Revision ready", payload={"phase": "done", "hunks": len(hunks), "total_tokens": usage["total_tokens"]})
    return ReviseResult(
        replacement_markdown=replacement,
        original_markdown=original,
        hunks=hunks,
        summary=summary,
        changes_made=list(changes),
        usage=usage,
        scope=request.scope,
        anchor=anchor,
        dropped_citations=dropped,
        model=request.llm.resolve("main"),
    )
