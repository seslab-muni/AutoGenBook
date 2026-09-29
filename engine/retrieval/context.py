"""Context blocks handed to agents (unchanged observable format).

    [<rid>] kind=kb source="<file>" loc="<loc>" score=0.00 cite_key="<key>"
    <sanitised excerpt, <= 1500 chars>

Excerpts are small-to-big: a short hit chunk is expanded with its neighbours
from the same section (and page) up to the per-item budget; a long one is cut
to the sentence window that best matches the query instead of its first
1500 characters. Lines that look like prompt injection are dropped.
"""

from __future__ import annotations

import re
from typing import Sequence

from engine.retrieval.lexical import lemma_tokens
from engine.retrieval.types import Chunk, RetrievalItem

_INJECTION_PATTERNS = [
    re.compile(r"(?i)\b(ignore|disregard)\b.*\b(previous|above|system|instructions)\b"),
    re.compile(r"(?i)\byou are (chatgpt|an ai|a large language model)\b"),
    re.compile(r"(?i)\b(system prompt|developer message|tool call)\b"),
    re.compile(r"(?i)\bdo not follow\b"),
    re.compile(r"(?i)\bBEGIN (SYSTEM|INSTRUCTIONS)\b"),
]


def sanitize(text: str) -> str:
    kept = [line for line in (text or "").splitlines() if not any(p.search(line) for p in _INJECTION_PATTERNS)]
    return "\n".join(kept).strip()


def _sentences(text: str) -> list[str]:
    from engine.retrieval.chunking import split_sentences

    out: list[str] = []
    for para in re.split(r"\n\s*\n", text):
        out.extend(split_sentences(para) or ([para.strip()] if para.strip() else []))
    return out


def best_window(text: str, query: str, budget: int, lang: str = "en") -> str:
    """The contiguous run of sentences (<= budget chars) with the highest
    lemma overlap with `query`; ties go to the earliest window."""
    if len(text) <= budget:
        return text
    sentences = _sentences(text)
    if not sentences:
        return text[:budget]
    query_terms = set(lemma_tokens(query, lang))
    weights = [len(query_terms & set(lemma_tokens(s, lang))) for s in sentences]
    best = (-1, 0, 0)
    for start in range(len(sentences)):
        size = 0
        score = 0
        end = start
        while end < len(sentences) and size + len(sentences[end]) + 1 <= budget:
            size += len(sentences[end]) + 1
            score += weights[end]
            end += 1
        if end == start:  # a single sentence longer than the budget
            end = start + 1
        if score > best[0]:
            best = (score, start, end)
    _score, start, end = best
    window = " ".join(sentences[start:end])
    return window[:budget]


def expand_excerpt(chunks: Sequence[Chunk], hit: int, query: str, budget: int) -> str:
    """Small-to-big excerpt for `chunks[hit]` within `budget` characters."""
    chunk = chunks[hit]
    text = chunk.text
    if len(text) >= budget:
        return best_window(text, query, budget, chunk.lang)
    parts = {hit: text}
    size = len(text)
    lo = hi = hit

    def same_unit(i: int) -> bool:
        other = chunks[i]
        return other.doc == chunk.doc and other.section == chunk.section and other.page == chunk.page and other.kind == chunk.kind == "text"

    grew = True
    while grew:
        grew = False
        for candidate in (hi + 1, lo - 1):
            if 0 <= candidate < len(chunks) and candidate not in parts and same_unit(candidate):
                extra = len(chunks[candidate].text) + 2
                if size + extra <= budget:
                    parts[candidate] = chunks[candidate].text
                    size += extra
                    lo, hi = min(lo, candidate), max(hi, candidate)
                    grew = True
    return "\n\n".join(parts[i] for i in sorted(parts))


def format_item(item: RetrievalItem, item_chars: int = 1500) -> str:
    excerpt = sanitize(item.text)[:item_chars]
    header = (
        f"[{item.rid}] kind={item.kind} source=\"{item.source}\" "
        f"loc=\"{item.loc}\" score={item.score:.2f} cite_key=\"{item.cite_key}\""
    )
    if item.url:
        header += f" url=\"{item.url}\""
    if item.title and item.kind != "kb":
        header += f" title=\"{item.title}\""
    return f"{header}\n{excerpt}"


def format_context(items: Sequence[RetrievalItem], *, max_chars_total: int = 6000, item_chars: int = 1500) -> str:
    blocks: list[str] = []
    remaining = max_chars_total
    for item in items:
        block = format_item(item, item_chars)
        if len(block) + 2 > remaining:
            break
        blocks.append(block)
        remaining -= len(block) + 2
    return "\n\n".join(blocks)
