"""Paragraph/sentence chunking to a token budget, with heading paths.

Rules (#152): split on paragraph and sentence boundaries, never inside a
sentence; a chunk holds at most `budget` approximate tokens (words and
punctuation marks; a single sentence longer than the budget becomes its own
chunk); consecutive pieces of one over-long paragraph overlap by one sentence;
tables and code blocks are kept whole; slides are chunked per slide; the
heading path ("Doc › Chapter › Section") is prefixed to the indexed text and
kept as metadata.
"""

from __future__ import annotations

import re
from pathlib import Path

from engine.retrieval.ids import make_cite_key, make_rid, source_id_from_path
from engine.retrieval.types import Block, Chunk, ExtractedDoc

_TOKEN_RE = re.compile(r"\w+|[^\w\s]", re.UNICODE)
_ABBREVIATIONS = {
    "e.g", "i.e", "etc", "vs", "dr", "mr", "mrs", "ms", "prof", "no", "fig", "eq", "vol", "pp", "p", "ch", "sec", "cf",
    "al", "approx", "jr", "sr", "st", "tzv", "např", "atd", "apod", "tj", "resp", "tzn", "př", "str", "obr", "tab", "kap",
    "doc", "ing", "mgr", "bc", "phd", "cca", "mj", "popř", "srov", "viz", "z.b", "usw", "bzw", "vgl",
}
_SENTENCE_END_RE = re.compile(r"(?<=[.!?…])[\"'”’»)\]]*\s+(?=[\"'“„«(\[]?[A-ZÀ-ŽА-Я0-9])")


def count_tokens(text: str) -> int:
    return len(_TOKEN_RE.findall(text))


def split_sentences(text: str) -> list[str]:
    """Regex sentence splitter that keeps abbreviations and decimals intact."""
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return []
    sentences: list[str] = []
    start = 0
    for match in _SENTENCE_END_RE.finditer(text):
        candidate = text[start : match.start()].strip()
        last_word = re.findall(r"([\w.]+)[.!?…][\"'”’»)\]]*$", candidate)
        if last_word:
            word = last_word[0].rstrip(".").casefold()
            if word in _ABBREVIATIONS or (len(word) == 1 and word.isalpha()):
                continue
        if candidate:
            sentences.append(candidate)
        start = match.end()
    tail = text[start:].strip()
    if tail:
        sentences.append(tail)
    return sentences


class _Builder:
    def __init__(self, doc: ExtractedDoc, doc_index: int, root: Path, budget: int) -> None:
        self.doc = doc
        self.doc_index = doc_index
        self.budget = budget
        path = Path(doc.path)
        self.source_path = str(path)
        self.source_id = source_id_from_path(path, root)
        self.name = Path(doc.rel_path).stem.replace("_", " ")
        self.chunks: list[Chunk] = []
        self.per_loc_counter: dict[str, int] = {}
        self.section = 0

    def emit(self, text: str, heading_path: list[str], page: int | None, slide: int | None, kind: str) -> None:
        text = text.strip()
        if not text:
            return
        if page is not None:
            loc_base = f"page {page}"
        elif slide is not None:
            loc_base = f"slide {slide}"
        else:
            loc_base = "chunk"
        index = self.per_loc_counter.get(loc_base, 0) + 1
        self.per_loc_counter[loc_base] = index
        loc = f"chunk {index}" if loc_base == "chunk" else f"{loc_base}, chunk {index}"
        self.chunks.append(
            Chunk(
                source_path=self.source_path,
                rel_path=self.doc.rel_path,
                source_id=self.source_id,
                loc=loc,
                rid=make_rid(self.source_id, loc_base, index),
                cite_key=make_cite_key(self.source_id, loc_base, index),
                text=text,
                heading_path=list(heading_path),
                page=page,
                slide=slide,
                section=self.section,
                position=len(self.chunks),
                doc=self.doc_index,
                lang=self.doc.lang,
                kind=kind,
            )
        )

    def flush_section(self, blocks: list[Block], heading_path: list[str]) -> None:
        if not blocks:
            return
        current: list[str] = []
        current_tokens = 0
        current_page: int | None = None
        current_slide: int | None = None

        def flush() -> None:
            nonlocal current, current_tokens
            if current:
                self.emit("\n\n".join(current), heading_path, current_page, current_slide, "slide" if current_slide else "text")
            current = []
            current_tokens = 0

        for block in blocks:
            if block.kind in {"table", "code"}:
                flush()
                self.emit(block.text, heading_path, block.page, block.slide, block.kind)
                continue
            tokens = count_tokens(block.text)
            new_page = block.page != current_page and current and block.page is not None
            if tokens > self.budget:
                flush()
                current_page, current_slide = block.page, block.slide
                for piece in self.split_long(block.text):
                    self.emit(piece, heading_path, block.page, block.slide, "slide" if block.slide else "text")
                continue
            if current and (current_tokens + tokens > self.budget or new_page):
                flush()
            if not current:
                current_page, current_slide = block.page, block.slide
            current.append(block.text)
            current_tokens += tokens
        flush()

    def split_long(self, text: str) -> list[str]:
        sentences = split_sentences(text)
        pieces: list[str] = []
        group: list[str] = []
        tokens = 0
        for sentence in sentences:
            n = count_tokens(sentence)
            if group and tokens + n > self.budget:
                pieces.append(" ".join(group))
                overlap = group[-1]
                group = [overlap] if count_tokens(overlap) + n <= self.budget else []
                tokens = sum(count_tokens(s) for s in group)
            group.append(sentence)
            tokens += n
        if group:
            pieces.append(" ".join(group))
        return pieces


def chunk_document(doc: ExtractedDoc, doc_index: int, root: Path, budget: int = 400) -> list[Chunk]:
    builder = _Builder(doc, doc_index, root, budget)
    stack: list[tuple[int, str]] = []
    pending: list[Block] = []

    def heading_path() -> list[str]:
        return [builder.name] + [title for _level, title in stack]

    for block in doc.blocks:
        if block.kind == "heading":
            builder.flush_section(pending, heading_path())
            pending = []
            builder.section += 1
            while stack and stack[-1][0] >= max(1, block.level):
                stack.pop()
            stack.append((max(1, block.level), block.text.strip()))
            continue
        pending.append(block)
    builder.flush_section(pending, heading_path())
    return builder.chunks
