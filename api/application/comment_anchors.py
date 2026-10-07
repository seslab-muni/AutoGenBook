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
today, and every `contentMarkdown` PATCH (re-anchoring all of a node's rows)
in a later track.
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


def resolve_anchor(content: str, anchor: Mapping[str, Any]) -> dict[str, Any]:
    """Return `anchor` re-resolved against `content`: `start`/`end` set (and
    `prefix`/`suffix` refreshed from `content`) when the quote was found, both
    `None` (original prefix/suffix kept) when it was not."""
    quote = anchor["quote"]
    start, end = anchor.get("start"), anchor.get("end")
    if start is not None and end is not None and content[start:end] == quote:
        return _with_context(content, quote, start, end)
    found = content.find(quote)
    if found != -1 and content.find(quote, found + 1) == -1:
        return _with_context(content, quote, found, found + len(quote))
    return {
        "quote": quote,
        "prefix": anchor.get("prefix", ""),
        "suffix": anchor.get("suffix", ""),
        "start": None,
        "end": None,
    }


def is_resolved(anchor: Mapping[str, Any]) -> bool:
    return anchor.get("start") is not None and anchor.get("end") is not None
