"""`engine.revise(request, sink) -> ReviseResult`: revise one section's existing
text in-process (issue #182, the Studio copilot).

Unlike `engine.run` there is no run directory, no `structure_graph.json`, no
queue and no file is written: the result is a pure function of the request
(the section text, the author's instruction, typed parameters, the section
brief, the LLM settings and an optional prebuilt knowledge base). The caller
decides what to do with the suggestion; nothing changes until it applies it.

* `scope="section"`: the model returns the whole revised body; the hunks come
  from a word-level diff against the original.
* `scope="range"`: the anchor is resolved first (an orphaned or only fuzzily
  matching anchor raises `AnchorOrphaned`); the model is asked only for the
  replacement of the range (the section is given as context); the engine
  splices it in, so text outside the range is unchanged by construction. An
  answer that repeats text from outside the range, or is implausibly long, is
  rejected; an empty answer deletes the range.

Parameters ("chips") are typed fields rendered into the prompt
deterministically (`render_requirements`). User-supplied text (section,
instruction, issue and comment texts, excerpts) sits between per-call random
delimiters and is declared data. Progress goes to the `EventSink` as stages
`retrieve`, `revise` and `diff`. Cancelling the awaiting task is clean: the
LLM client is closed and the diff worker told to stop.

Every failure leaves `revise` as an `InputError` (bad request) or a
`ReviseError` subclass carrying the usage spent so far (`.usage`).

Concurrency: `revise()` alone is self-contained (one client per call, one
structured-output probe per call). An API process should create one
`ReviseClientPool` and call `pool.revise(request, sink)`: the pool shares the
HTTP client, the adaptive limiter and the per-model capability probe across
calls, while every call keeps its own usage ledger. A pool belongs to the
event loop that first uses it and is not thread-safe.
"""

from __future__ import annotations

import asyncio
import dataclasses
import logging
import re
import secrets
import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, Mapping

import httpx
import openai

from engine.agents.base import Agent
from engine.agents.models import RangeRevision, SectionRevision
from engine.assemble.citations import CitationIndex
from engine.config import LLMSettings, RetrievalSettings, is_openrouter, llm_settings_from_env
from engine.errors import (
    AnchorOrphaned,
    EngineError,
    InputError,
    ReviseAuthError,
    ReviseConfigError,
    ReviseError,
    ReviseProviderError,
    ReviseRateLimited,
    ReviseTimeout,
    ReviseUnusableOutput,
    SchemaError,
)
from engine.events import EventSink
from engine.llm.client import LLMClient
from engine.llm.usage import UsageLedger
from engine.pipeline.text import equation_guidance, invalid_citations, lines_to_words, single_key_citations, strip_citations, target_lines, unwrap_fence
from engine.retrieval.context import format_context
from engine.retrieval.kb import HybridRetriever, KnowledgeBase
from engine.spec.language import detect_language, language_name, normalize_language
from engine.util.anchors import resolve_anchor_detailed
from engine.util.textdiff import DiffCancelled, Hunk, apply_hunks, diff_hunks_detailed

SECTION_REVISER = Agent("book/copilot_reviser", SectionRevision, "copilot.revise")
RANGE_REVISER = Agent("book/copilot_range", RangeRevision, "copilot.revise_range")
Scope = Literal["section", "range"]
ACCEPTED_ANCHOR_LEVELS = ("stored", "exact", "whitespace")
MIN_OVERLAP = 24  # a replacement starting/ending with this much of the surrounding text echoes it
VERBATIM_WINDOW = 200  # a run this long copied from outside the range is an echo
SHRINK_WARNING = 0.5
KNOWN_KINDS = ("book", "paper", "presentation")
ADJACENT = 1500  # how far around the range an echo of the surroundings is looked for
log = logging.getLogger(__name__)


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


@dataclass
class ReviseRetrieval:
    """A prebuilt knowledge base to ground the revision in (lexical search,
    run off the event loop; no files are written). `kb_sources` restricts it to
    the section's sources. `citation_index` and `retriever` are caches filled
    on first use."""

    kb: KnowledgeBase
    kb_sources: tuple[str, ...] | None = None
    settings: RetrievalSettings = field(default_factory=RetrievalSettings)
    citation_index: CitationIndex | None = None
    retriever: HybridRetriever | None = None


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
    allow_fuzzy_anchor: bool = False  # accept an anchor that only matches approximately


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
    warnings: list[str] = field(default_factory=list)

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
            "warnings": list(self.warnings),
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


def _one_line(value: Any) -> str:
    """Untrusted text as one line (no newline can start a fake list item or block)."""
    return " ".join(str(value if value is not None else "").split())


def _issue_line(number: int, issue: dict[str, Any]) -> str:
    head = f"{number}. [{_one_line(issue.get('severity') or 'minor')}] {_one_line(issue.get('type') or 'other')}: {_one_line(issue.get('description'))}"
    fix = _one_line(issue.get("required_fix"))
    if fix:
        head += f" -> {fix}"
    quote = _one_line(issue.get("quote"))
    if quote:
        head += f"\n   Passage: {quote!r}"
    if issue.get("replace_from") and issue.get("replace_to") is not None:
        head += f"\n   Literal replacement: {_one_line(issue['replace_from'])!r} -> {_one_line(issue['replace_to'])!r}"
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
        lines += [f"  {n}. {_one_line(c)}" for n, c in enumerate(params.address_comments, 1)]
    return "\n".join(lines) or "(none beyond the request)"


def render_writing_settings(brief: SectionBrief) -> str:
    lines: list[str] = []
    if brief.target_pages:
        lines.append(f"- Target length of the section: about {lines_to_words(target_lines(brief.target_pages))} words (a guideline; the request wins).")
    if brief.equation_density:
        lines.append(f"- Equation density {brief.equation_density}/5: {equation_guidance(brief.equation_density)}")
    if brief.math_level:
        lines.append(f"- Math level: {_one_line(brief.math_level)}.")
    if brief.sub_prompt.strip():
        lines.append(f"- Standing instructions: {_one_line(brief.sub_prompt)}")
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
    if request.brief.document_kind not in KNOWN_KINDS:
        raise InputError(f"unknown document_kind {request.brief.document_kind!r} (expected one of {', '.join(KNOWN_KINDS)})")
    if not all(isinstance(i, dict) for i in p.fix_issues):
        raise InputError("fix_issues must be a list of issue objects")
    if request.anchor is not None and not isinstance(request.anchor, dict):
        raise InputError("anchor must be an object with a quote")
    density = request.brief.equation_density
    if density is not None and not (isinstance(density, int) and not isinstance(density, bool) and 1 <= density <= 5):
        raise InputError("equation_density must be an integer from 1 to 5")
    if request.scope == "range" and not (request.anchor and str(request.anchor.get("quote") or "").strip()):
        raise InputError("a range revision needs an anchor with a quote")
    if not request.llm.api_key and is_openrouter(request.llm.base_url):
        raise ReviseConfigError("no API key is configured for the LLM endpoint (OPENROUTER_API_KEY or AUTOGENBOOK_LLM_API_KEY)")


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
    if spec.retriever is None:
        spec.retriever = HybridRetriever(spec.kb, candidates=settings.candidates, item_chars=settings.item_chars, rerankers=())
    retriever = spec.retriever
    sources = list(spec.kb_sources) if spec.kb_sources is not None else None

    def search_and_index() -> tuple[list, CitationIndex]:
        # BM25 and the citation index are CPU work: keep them off the event loop.
        items = asyncio.run(retriever.search(queries, k=settings.top_k, kb_sources=sources, use_dense=False))
        if spec.citation_index is None:
            spec.citation_index = CitationIndex.from_kb_sources(spec.kb.kb_sources_json())
        return items, spec.citation_index

    items, index = await asyncio.to_thread(search_and_index)
    text = format_context(items, max_chars_total=settings.max_chars_total, item_chars=settings.item_chars)
    sink.emit("retrieve", f"Retrieved {len(items)} passage(s)", payload={"phase": "done", "passages": len(items)})
    return text or "(none)", index


def _check_citations(new: str, reference: str, index: CitationIndex | None, sink: EventSink) -> tuple[str, list[str]]:
    """With a knowledge base: `\\cite{}` forms become `[key]` markers and keys
    the model invented (not in the KB and not already in `reference`, the whole
    original section) are removed."""
    if index is None:
        return new, []
    new = single_key_citations(new, index)
    known = set(invalid_citations(reference, index))
    bad = [k for k in invalid_citations(new, index) if k not in known]
    if bad:
        sink.emit("revise", f"Removed {len(bad)} citation(s) of unknown keys: {', '.join(bad[:10])}", level="warning")
        new = strip_citations(new, bad, index)
    return new, bad


# -------------------------------------------------------- output post-processing
def _is_fenced(text: str) -> bool:
    stripped = text.strip()
    return len(stripped) >= 6 and stripped.startswith("```") and stripped.endswith("```")


_FENCE_WRAP = re.compile(r"^\s*```(markdown|md)?[ \t]*\n(.*)\n```\s*$", re.DOTALL | re.IGNORECASE)
_CODE_WORDS = re.compile(r"\b(code|snippet|fenced?|listing|verbatim|monospace)\b", re.IGNORECASE)


def _unfence(model_text: str, original: str, instruction: str = "") -> str:
    """The model's text without a code fence it wrapped around everything.
    Conservative: only a `markdown`/`md` fence, or a bare fence around clearly
    prose-like text (several paragraphs, no nested fence) when the request was
    not about code, is removed - and never when the original is itself fenced."""
    text = model_text.replace("\r\n", "\n")
    if _is_fenced(original):
        return text.strip()
    m = _FENCE_WRAP.match(text)
    if m is None:
        return text.strip()
    inner = m.group(2)
    if m.group(1) or ("\n\n" in inner and "```" not in inner and not _CODE_WORDS.search(instruction)):
        return inner.strip()
    return text.strip()


def _match_newlines(text: str, original: str) -> str:
    """Keep the original's CRLF line endings (only when it uses nothing else)."""
    if "\r\n" in original and "\n" not in original.replace("\r\n", ""):
        return text.replace("\r\n", "\n").replace("\n", "\r\n")
    return text


def _with_edge_whitespace(model_text: str, original: str) -> str:
    """The model's text with the leading/trailing whitespace of `original`, so
    paragraph spacing at the edges never shows up as an edit."""
    lead = original[: len(original) - len(original.lstrip())]
    trail = original[len(original.rstrip()):]
    return lead + model_text.strip() + trail


def _strip_overlap(new: str, before: str, after: str, inside: str) -> str:
    """Remove a head that repeats the end of `before` and a tail that repeats
    the start of `after` (the model echoing its surroundings, at least
    `MIN_OVERLAP` characters). Not an echo: a short run of whole lines (a
    repeated table row or list item the author wants twice), or text the
    range itself starts/ends with."""
    for k in range(min(len(new) - 1, len(before), 3000), MIN_OVERLAP - 1, -1):
        head = before[-k:]
        if not new.startswith(head) or inside.startswith(head):
            continue
        whole_lines = head.endswith("\n") and (k == len(before) or before[-k - 1] == "\n")
        if whole_lines and k < 120 and head.count("\n") < 2:
            continue
        new = new[k:]
        break
    for k in range(min(len(new) - 1, len(after), 3000), MIN_OVERLAP - 1, -1):
        tail = after[:k]
        if not new.endswith(tail) or inside.endswith(tail):
            continue
        whole_lines = tail.startswith("\n") and (k == len(after) or after[k] == "\n")
        if whole_lines and k < 120 and tail.count("\n") < 2:
            continue
        new = new[:-k]
        break
    return new


_EXEMPT = re.compile(r"```.*?```|~~~.*?~~~|\$\$.*?\$\$", re.DOTALL)


def _copies_outside(new: str, before: str, after: str, inside: str) -> bool:
    """True when `new` contains a run of `VERBATIM_WINDOW`+ characters taken
    from the text immediately around the range (the echo case) that the range
    itself does not contain. Fenced code and display math are exempt, and so is
    text from far away (a formula the author refers back to)."""
    w = VERBATIM_WINDOW
    probe = _EXEMPT.sub("\0", new)
    if len(probe) < w:
        return False
    near = (before[-ADJACENT:], after[:ADJACENT])
    outside = {t[i:i + w] for t in near for i in range(max(0, len(t) - w + 1))}
    if not outside:
        return False
    own = {inside[i:i + w] for i in range(max(0, len(inside) - w + 1))}
    return any(c in outside and c not in own for c in (probe[i:i + w] for i in range(len(probe) - w + 1)))


def _trailing_newlines(text: str) -> int:
    return text[len(text.rstrip("\r\n")):].count("\n")


def _delete_range(original: str, start: int, end: int) -> tuple[str, str, str]:
    """`original` without `[start, end)`, the seam repaired, as `(text,
    before_kept, after_kept)`: the text always starts with `before_kept` and
    ends with `after_kept`, both verbatim slices of the original.

    Whole lines (the range starts a line and ends at, or with, a line end) are
    removed with their line break and the following line keeps its indentation;
    the blank lines at the seam are the larger of the two sides, never their
    sum (a table or tight list stays one block). Inside a line only horizontal
    whitespace at the seam is adjusted."""
    before, inside, after = original[:start], original[start:end], original[end:]
    line_start = before.rfind("\n") + 1
    if not before[line_start:].strip(" \t"):
        before = before[:line_start]  # the range began after the line's indentation: the indentation goes too
    blank = len(after) - len(after.lstrip(" \t"))
    if after[blank:blank + 1] in ("", "\n", "\r"):
        after = after[blank:]  # nothing but blanks follows the range on its last line
    at_line_start = before == "" or before.endswith("\n")
    at_line_end = after == "" or after[0] in "\r\n"
    unit = "\r\n" if "\r\n" in original else "\n"
    if at_line_start and (at_line_end or inside.endswith("\n")):
        core_before = before.rstrip("\r\n")
        core_after = after.lstrip("\r\n")
        left, right = _trailing_newlines(before), after[:len(after) - len(core_after)].count("\n")
        if not core_before:
            seam = ""
        elif not core_after:
            seam = unit if (left or right or inside.endswith("\n")) else ""
        else:
            seam = unit * min(2, max(left, right, 1))
        return core_before + seam + core_after, core_before, core_after
    left_text, right_text = before.rstrip(" \t"), after.lstrip(" \t")
    if not left_text or left_text.endswith("\n") or not right_text or right_text[0] in "\r\n.,;:!?)]}":
        seam = ""
    else:
        seam = " "
    return left_text + seam + right_text, left_text, right_text


# --------------------------------------------------------------------- errors
def _typed(exc: BaseException, usage: dict[str, Any]) -> ReviseError | None:
    """Provider and engine failures as `ReviseError` subclasses (None: not ours)."""
    if isinstance(exc, ReviseError):
        if not exc.usage:
            exc.usage = usage
        return exc
    if isinstance(exc, (openai.AuthenticationError, openai.PermissionDeniedError)):
        typed: ReviseError = ReviseAuthError(f"the LLM provider rejected the credentials: {exc}", usage=usage)
    elif isinstance(exc, openai.RateLimitError):
        typed = ReviseRateLimited(f"the LLM provider is rate limiting requests: {exc}", usage=usage)
    elif isinstance(exc, (openai.APITimeoutError, httpx.TimeoutException)):
        typed = ReviseTimeout(f"the LLM provider did not answer in time: {exc}", usage=usage)
    elif isinstance(exc, SchemaError):
        typed = ReviseUnusableOutput(str(exc), usage=usage)
    elif isinstance(exc, (openai.OpenAIError, httpx.HTTPError)):
        typed = ReviseProviderError(f"LLM request failed: {exc}", usage=usage)
    elif isinstance(exc, InputError):
        return None
    elif isinstance(exc, EngineError):
        typed = ReviseProviderError(str(exc), usage=usage)
    else:
        return None
    typed.__cause__ = exc
    return typed


# --------------------------------------------------------------------- entry
async def revise(
    request: ReviseRequest,
    sink: EventSink,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    pool: "ReviseClientPool | None" = None,
) -> ReviseResult:
    """Revise one section (or one range of it); see the module docstring.
    `transport`, when given, carries every outbound HTTP request (tests inject
    the fake LLM here). With a `pool` the HTTP client, limiter and capability
    probe are shared with other calls; the transport then belongs to the pool
    (`ReviseClientPool(transport=...)`), so giving both is an error."""
    if pool is not None and transport is not None:
        raise InputError("give the transport to the ReviseClientPool, not to revise()")
    _validate(request)
    ledger = UsageLedger(None)
    lease = None
    if pool is not None:
        lease = pool._acquire(request.llm, sink)
        llm = lease.base.fork(ledger, sink, request.llm)
    else:
        llm = LLMClient(request.llm, ledger=ledger, sink=sink, concurrency=2, transport=transport)
    stop = threading.Event()
    try:
        return await _revise(request, sink, llm, ledger, stop)
    except asyncio.CancelledError:
        stop.set()
        usage = ledger.totals()
        sink.emit("revise", "Revision cancelled", level="warning", payload={"phase": "cancelled", "usage": usage})
        raise
    except Exception as exc:
        typed = _typed(exc, ledger.totals())
        if typed is None or typed is exc:
            raise
        raise typed from exc
    finally:
        stop.set()
        try:
            await asyncio.shield(llm.aclose())
        except Exception:  # noqa: BLE001 - closing must never mask the result
            pass
        if lease is not None:
            await asyncio.shield(pool._release(lease))  # type: ignore[union-attr]


def _delimited_values(request: ReviseRequest, context: str) -> tuple[str, str]:
    """A boundary code that occurs in none of the texts it delimits."""
    texts = [request.body_markdown, request.instruction, context, *(str(c) for c in request.params.address_comments)]
    texts += [str(v) for issue in request.params.fix_issues for v in issue.values()]
    b = request.brief
    texts += [b.title, b.summary, b.book_title, b.target_readers, b.glossary, b.outline, b.neighbours, b.sub_prompt]
    while True:
        boundary = secrets.token_hex(4)
        if not any(boundary in t for t in texts):
            return boundary, f"[[SELECTED PASSAGE {boundary}]]"


async def _revise(request: ReviseRequest, sink: EventSink, llm: LLMClient, ledger: UsageLedger, stop: threading.Event) -> ReviseResult:
    original = request.body_markdown
    brief = request.brief
    anchor: dict[str, Any] | None = None
    span: tuple[int, int] | None = None
    if request.scope == "range":
        assert request.anchor is not None
        anchor, level = resolve_anchor_detailed(original, request.anchor)
        if anchor["start"] is None or (level not in ACCEPTED_ANCHOR_LEVELS and not request.allow_fuzzy_anchor):
            raise AnchorOrphaned(str(request.anchor.get("quote") or ""))
        span = (anchor["start"], anchor["end"])
    range_text = original[span[0]:span[1]] if span else None
    sink.emit("revise", f"Revising the {'selected range' if span else 'section'}", payload={"phase": "start", "scope": request.scope})

    try:
        context, index = await _retrieve(request, range_text, sink)
    except (asyncio.CancelledError, ReviseError):
        raise
    except Exception as exc:  # noqa: BLE001 - a search failure is a typed revise failure
        raise ReviseError(f"retrieval from the knowledge base failed: {type(exc).__name__}: {exc}") from exc
    language = normalize_language(brief.language) or detect_language(original)
    boundary, marker = _delimited_values(request, context)
    values: dict[str, Any] = {
        "boundary": boundary,
        "language_name": language_name(language),
        "document_kind": brief.document_kind,
        "book_title": _one_line(brief.book_title) or "(untitled)",
        "target_readers": _one_line(brief.target_readers) or "(not specified)",
        "glossary": brief.glossary or "(none)",
        "neighbours": brief.neighbours or "(not provided)",
        "outline": brief.outline or "(not provided)",
        "section_title": _one_line(brief.title) or "(untitled section)",
        "section_summary": brief.summary or "(no summary)",
        "writing_settings": render_writing_settings(brief),
        "instruction": request.instruction.strip() or "(no free-text request; apply the revision requirements)",
        "requirements": render_requirements(request.params, have_sources=index is not None),
        "retrieved_context": context,
    }
    warnings: list[str] = []
    deleted = False
    sink.emit("revise", "Asking the model for the revision", payload={"phase": "model"})
    if span is None:
        revision = await SECTION_REVISER.run(llm, {**values, "section_body": original})
        model_body = _unfence(revision.body_markdown, original, request.instruction)
        if not model_body.strip():
            raise ReviseError("the model returned an empty section")
        new_text, dropped = _check_citations(_match_newlines(model_body, original), original, index, sink)
        replacement = _with_edge_whitespace(new_text, original)
        summary, changes = revision.summary, revision.changes_made
        if len(replacement.strip()) < SHRINK_WARNING * len(original.strip()) and not request.params.shorter:
            warnings.append("The revised section is less than half as long as the original although shortening was not requested.")
            sink.emit("revise", warnings[-1], level="warning")
        kept_before = kept_after = None
    else:
        start, end = span
        before, inside, after = original[:start], original[start:end], original[end:]
        values["range_marker"] = marker
        values["section_context"] = before + marker + after
        values["range_text"] = inside
        revision_r = await RANGE_REVISER.run(llm, values)
        raw = revision_r.replacement_markdown
        if marker in raw:
            raise ReviseError("the model echoed the section context instead of replacing only the selected range")
        model_range = _strip_overlap(_unfence(raw, inside, request.instruction), before, after, inside)
        if _copies_outside(model_range, before, after, inside):
            raise ReviseError("the model's replacement repeats text from around the selected range")
        if len(model_range) > 12 * len(inside) + max(3000, len(original)):
            warnings.append("The replacement is much longer than the selected range.")
            sink.emit("revise", warnings[-1], level="warning")
        summary, changes = revision_r.summary, revision_r.changes_made
        if not model_range.strip():
            replacement, kept_before, kept_after = _delete_range(original, start, end)
            dropped = []
            deleted = True
            warnings.append("The selected range was removed.")
            removed = original[len(kept_before):len(original) - len(kept_after)]
            if not (replacement.startswith(kept_before) and replacement.endswith(kept_after)
                    and inside in removed and removed.replace(inside, "", 1).strip(" \t\r\n") == ""):
                raise ReviseError("internal error: text outside the removed range changed")
        else:
            new_range, dropped = _check_citations(_match_newlines(model_range, original), original, index, sink)
            replacement = before + _with_edge_whitespace(new_range, inside) + after
            kept_before, kept_after = before, after
            # Outside the range nothing may differ: true by construction, verified anyway.
            if not (replacement.startswith(before) and replacement.endswith(after)):
                raise ReviseError("internal error: text outside the selected range changed")

    sink.emit("diff", "Computing the changes", payload={"phase": "start"})
    try:
        if span is None or deleted:
            hunks, coarse = await asyncio.to_thread(diff_hunks_detailed, original, replacement, should_stop=stop.is_set)
        else:
            start, end = span
            new_range_full = replacement[start:len(replacement) - (len(original) - end)]
            hunks, coarse = await asyncio.to_thread(diff_hunks_detailed, original[start:end], new_range_full, base=start, should_stop=stop.is_set)
    except asyncio.CancelledError:
        stop.set()
        raise
    except DiffCancelled as exc:
        raise ReviseError("the revision was cancelled while computing the changes") from exc
    if coarse:
        warnings.append(f"{coarse} part(s) of the change are too repetitive to itemise; their hunks cover whole blocks.")
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
        warnings=warnings,
    )


# ---------------------------------------------------------- integration helpers
class _PoolSink:
    """The sink of a pooled base client: limiter and throttle notices reach
    whichever calls are in flight right now."""

    def __init__(self) -> None:
        self.targets: list[EventSink] = []

    def emit(self, stage: str, message: str, **kw: Any) -> None:
        for sink in list(self.targets):
            sink.emit(stage, message, **kw)

    def close(self) -> None:
        return None


@dataclass
class _Lease:
    key: tuple
    base: LLMClient
    sink: EventSink


class ReviseClientPool:
    """Shares the HTTP client, adaptive limiter and per-model structured-output
    probe between `revise` calls to the same endpoint (one base client per
    endpoint/key/timeouts). At most `max_clients` idle base clients are kept
    (least recently used first; a client in use is never closed). One pool per
    API process and event loop, not thread-safe; `await pool.aclose()` at
    shutdown. Throttle notices go to the sinks of the calls in flight."""

    def __init__(self, *, concurrency: int = 4, transport: httpx.AsyncBaseTransport | None = None, max_clients: int = 8) -> None:
        self.concurrency = concurrency
        self.transport = transport
        self.max_clients = max_clients
        self._clients: "OrderedDict[tuple, tuple[LLMClient, _PoolSink]]" = OrderedDict()
        self._active: dict[tuple, int] = {}

    @staticmethod
    def _key(settings: LLMSettings) -> tuple:
        return (settings.base_url.rstrip("/").lower(), settings.api_key, settings.timeout_s, settings.max_retries,
                settings.http_referer, settings.x_title, settings.pricing_disabled)

    def client_for(self, settings: LLMSettings) -> LLMClient:
        """The shared base client for these settings (created on first use)."""
        key = self._key(settings)
        entry = self._clients.get(key)
        if entry is None:
            hub = _PoolSink()
            client = LLMClient(settings, ledger=UsageLedger(None), sink=hub, concurrency=self.concurrency, transport=self.transport)
            entry = self._clients[key] = (client, hub)
        self._clients.move_to_end(key)
        return entry[0]

    def _acquire(self, settings: LLMSettings, sink: EventSink) -> _Lease:
        base = self.client_for(settings)
        key = self._key(settings)
        self._clients[key][1].targets.append(sink)
        self._active[key] = self._active.get(key, 0) + 1
        return _Lease(key, base, sink)

    async def _release(self, lease: _Lease) -> None:
        entry = self._clients.get(lease.key)
        if entry is not None and lease.sink in entry[1].targets:
            entry[1].targets.remove(lease.sink)
        self._active[lease.key] = self._active.get(lease.key, 1) - 1
        if self._active[lease.key] <= 0:
            self._active.pop(lease.key, None)
        idle = [k for k in self._clients if k not in self._active]
        while len(self._clients) > self.max_clients and idle:
            old = idle.pop(0)
            client, _hub = self._clients.pop(old)
            await client.aclose()

    @property
    def size(self) -> int:
        return len(self._clients)

    async def revise(self, request: ReviseRequest, sink: EventSink) -> ReviseResult:
        return await revise(request, sink, pool=self)

    async def aclose(self) -> None:
        clients, self._clients, self._active = list(self._clients.values()), OrderedDict(), {}
        for client, _hub in clients:
            await client.aclose()


def interactive_llm_settings(
    env: Mapping[str, str] | None = None,
    *,
    model: str | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
    timeout_s: float = 90.0,
    max_retries: int = 1,
    reasoning_effort: str | None = None,
) -> LLMSettings:
    """`LLMSettings` for an interactive call (a user is waiting): the same
    environment parsing as a full run, with a short timeout and few retries
    (never looser than the environment's own limits). Explicit arguments win
    over the environment (per-project model, endpoint and key).

    The environment's API key belongs to the environment's endpoint: when
    `base_url` names a different endpoint, `api_key` must be given too
    (`ReviseConfigError` otherwise; pass `"local"` for a keyless endpoint).
    `reasoning_effort` is not inherited from the environment: pass it
    explicitly (None = not sent)."""
    import os

    from engine.config import _normalize_base_url

    source = dict(os.environ if env is None else env)
    base = llm_settings_from_env(source)
    changes: dict[str, Any] = {
        "timeout_s": min(base.timeout_s, timeout_s),
        "max_retries": min(base.max_retries, max_retries),
        "reasoning_effort": reasoning_effort,
    }
    if base_url and _normalize_base_url(base_url) != _normalize_base_url(base.base_url):
        if not api_key:
            raise ReviseConfigError("an explicit api_key is required when base_url differs from the environment's endpoint (the environment key is not sent elsewhere)")
        changes["base_url"] = base_url.strip()
        changes["api_key"] = api_key
    elif api_key:
        changes["api_key"] = api_key
    if model:
        changes.update(model=model, mini_model=model)
    return dataclasses.replace(base, **changes)


_RETRIEVAL_CACHE: "OrderedDict[tuple, ReviseRetrieval]" = OrderedDict()
_RETRIEVAL_CACHE_LOCK = threading.Lock()
_PATH_LOCKS: dict[str, threading.Lock] = {}
_RETRIEVAL_CACHE_SIZE = 2


def _load_retrieval_sync(kb_dir: Path, cache_dir: Path, kb_sources: tuple[str, ...] | None, settings: RetrievalSettings) -> ReviseRetrieval | None:
    import hashlib

    key_hash = hashlib.sha256(str(kb_dir.expanduser().resolve()).encode("utf-8")).hexdigest()[:16]
    pkl = cache_dir / f"engine_kb_{key_hash}.pkl"
    try:
        stat = pkl.stat()
    except OSError:
        return None
    key = (str(pkl), stat.st_mtime_ns, stat.st_size)
    with _RETRIEVAL_CACHE_LOCK:
        path_lock = _PATH_LOCKS.setdefault(str(pkl), threading.Lock())
    with path_lock:  # concurrent first loads unpickle once
        with _RETRIEVAL_CACHE_LOCK:
            cached = _RETRIEVAL_CACHE.get(key)
            if cached is not None:
                _RETRIEVAL_CACHE.move_to_end(key)
        if cached is None:
            kb = KnowledgeBase.load_cached(kb_dir, cache_dir)
            if kb is None or not kb.chunks:
                return None
            cached = ReviseRetrieval(kb, citation_index=CitationIndex.from_kb_sources(kb.kb_sources_json()))
            with _RETRIEVAL_CACHE_LOCK:
                for old in [k for k in _RETRIEVAL_CACHE if k[0] == key[0]]:
                    del _RETRIEVAL_CACHE[old]  # an older version of the same index file
                _RETRIEVAL_CACHE[key] = cached
                while len(_RETRIEVAL_CACHE) > _RETRIEVAL_CACHE_SIZE:
                    _RETRIEVAL_CACHE.popitem(last=False)
    # Per-call copy: the retriever is built lazily with the caller's settings.
    return dataclasses.replace(cached, kb_sources=kb_sources, settings=settings, retriever=None)


async def load_revision_retrieval(
    work_dir: Path,
    *,
    kb_sources: tuple[str, ...] | None = None,
    settings: RetrievalSettings | None = None,
    kb_dir: Path | None = None,
    cache_dir: Path | None = None,
) -> ReviseRetrieval | None:
    """The knowledge base a finished run saved, for `ReviseRequest.retrieval`.

    `work_dir` is the run's work directory (`<work_dir>/out/.kb_cache` holds
    the index, `<work_dir>/kb` the sources; override with `cache_dir`/`kb_dir`).
    It must be derived by the server (a project's own directory), never from
    user input: the index is a pickle, trusted like the rest of the work
    directory. The index is only loaded, never built (no file is read or
    extracted), off the event loop, and cached per index file (the two most
    recent); the BM25 index and the citation index are built once. Returns
    None when the run saved none or the saved one cannot be used by this
    engine version. The index is not checked against the current files: it is
    the one the run's text was written with."""
    kb = (kb_dir or work_dir / "kb")
    cache = cache_dir or (work_dir / "out" / ".kb_cache")
    return await asyncio.to_thread(_load_retrieval_sync, kb, cache, kb_sources, settings or RetrievalSettings())
