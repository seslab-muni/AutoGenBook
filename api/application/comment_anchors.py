"""Anchor resolution for margin cards (issue #182).

An anchor is a W3C text-quote selector over a section's Markdown source
(`contentMarkdown`)::

    {"quote": str, "prefix": str, "suffix": str, "start": int | None, "end": int | None}

`start`/`end` are offsets in Unicode code points (Python `str` indices), `end`
exclusive; both `None` = orphaned. `prefix`/`suffix` are up to `CONTEXT_LEN`
code points of surrounding text.

`resolve_anchor` is the single hook that decides where an anchor points in a
given content. This track ships the cheap strategy (client offsets if they
verify, else a unique exact match, else orphaned). The full resolver (exact ->
whitespace-normalised -> fuzzy near the stored offset, `engine/util/anchors.py`)
replaces the body of this function later; callers: `CommentService.create`
today. Contract for the full resolver: on a normalised/fuzzy re-anchor the
stored `quote` is rewritten to the text actually matched.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

CONTEXT_LEN = 32


def _with_context(content: str, quote: str, start: int, end: int) -> dict[str, Any]:
    return {
        "quote": quote,
        "prefix": content[max(0, start - CONTEXT_LEN) : start],
        "suffix": content[end : end + CONTEXT_LEN],
        "start": start,
        "end": end,
    }


def _find_all(content: str, quote: str) -> list[int]:
    found, pos = [], content.find(quote)
    while pos != -1:
        found.append(pos)
        pos = content.find(quote, pos + 1)
    return found


def resolve_anchor(content: str, anchor: Mapping[str, Any]) -> dict[str, Any]:
    """Return `anchor` re-resolved against `content`: `start`/`end` set (and
    `prefix`/`suffix` refreshed from `content`) when the quote was found, both
    `None` (original prefix/suffix kept) when it was not."""
    quote = anchor["quote"]
    start, end = anchor.get("start"), anchor.get("end")
    if start is not None and end is not None and content[start:end] == quote:
        return _with_context(content, quote, start, end)
    matches = _find_all(content, quote)
    if len(matches) > 1:
        # Several exact matches: keep those whose surroundings agree with the
        # stored prefix/suffix (only when there is context to compare).
        prefix, suffix = anchor.get("prefix", ""), anchor.get("suffix", "")
        if prefix or suffix:
            matches = [
                m
                for m in matches
                if content.endswith(prefix, 0, m) and content.startswith(suffix, m + len(quote))
            ]
    if len(matches) == 1:
        return _with_context(content, quote, matches[0], matches[0] + len(quote))
    return {
        "quote": quote,
        "prefix": anchor.get("prefix", ""),
        "suffix": anchor.get("suffix", ""),
        "start": None,
        "end": None,
    }


def is_resolved(anchor: Mapping[str, Any]) -> bool:
    return anchor.get("start") is not None and anchor.get("end") is not None
