"""Anchor resolution for margin cards (issue #182).

An anchor is a W3C text-quote selector over a section's Markdown source
(`contentMarkdown`)::

    {"quote": str, "prefix": str, "suffix": str, "start": int | None, "end": int | None}

`start`/`end` are offsets in Unicode code points (Python `str` indices), `end`
exclusive; both `None` = orphaned. `prefix`/`suffix` are up to `CONTEXT_LEN`
code points of surrounding text.

The resolver is the engine's (`engine/util/anchors.py`, ENGINE_REWRITE.md
4.9): stored offsets if they still hold the quote, else exact -> whitespace-
normalised -> NFC -> bounded fuzzy matching near the stored offset, else
orphaned. A false-positive match is worse than an orphan. On a normalised or
fuzzy re-anchor the returned `quote` is the text actually matched, so
`content[start:end] == quote` always holds for a resolved anchor. Client
offsets on create are only a hint; the server resolves.

`api.application.reanchor` re-resolves all the live cards of a node when its
text changes; `resolve_anchors` is the batch (CPU-bound, thread-friendly)
entry point it uses.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from engine.util.anchors import CONTEXT as CONTEXT_LEN
from engine.util.anchors import resolve_anchor_detailed

# Levels at which a match is trusted without question (the same set
# `engine.revise` accepts for a range revision).
ACCEPTED_LEVELS = ("stored", "exact", "whitespace")


def resolve_anchor(content: str, anchor: Mapping[str, Any]) -> dict[str, Any]:
    """Return `anchor` re-resolved against `content`: `start`/`end` set (and
    `prefix`/`suffix` refreshed from `content`) when the quote was found, both
    `None` (original prefix/suffix kept) when it was not."""
    return resolve_anchor_detailed(content, dict(anchor))[0]


def resolve_anchor_level(content: str, anchor: Mapping[str, Any]) -> tuple[dict[str, Any], str]:
    """`resolve_anchor` plus the engine's match level (`stored`, `exact`,
    `whitespace`, `tolerant`, `fuzzy` or `orphan`)."""
    return resolve_anchor_detailed(content, dict(anchor))


def resolve_anchors(
    content: str, anchors: Sequence[Mapping[str, Any]]
) -> list[dict[str, Any]]:
    """`resolve_anchor` for many anchors against the same text. Pure CPU, no
    I/O: callers with large inputs run it in a worker thread."""
    return [resolve_anchor(content, anchor) for anchor in anchors]


def is_resolved(anchor: Mapping[str, Any]) -> bool:
    return anchor.get("start") is not None and anchor.get("end") is not None


def resolve_anchors_detailed(
    content: str, anchors: Sequence[Mapping[str, Any]]
) -> list[tuple[dict[str, Any], str]]:
    """`(anchor, level)` for each anchor (see `resolve_anchor_level`)."""
    return [resolve_anchor_level(content, anchor) for anchor in anchors]


def _nows(text: str) -> str:
    return "".join(text.split())


def context_agrees(content: str, stored: Mapping[str, Any], start: int, end: int) -> bool:
    """Whether the text around `content[start:end]` is what the stored anchor
    remembers: its full `prefix` ends right before `start`, or its full `suffix`
    starts right at `end` (whitespace ignored). An empty stored prefix/suffix
    agrees only at the edge of the text it was taken at (start 0 / end of text)."""
    prefix, suffix = str(stored.get("prefix") or ""), str(stored.get("suffix") or "")
    if prefix.strip():
        want = _nows(prefix)
        if _nows(content[max(0, start - 2 * len(prefix) - 8) : start]).endswith(want):
            return True
    elif start == 0:
        return True
    if suffix.strip():
        want = _nows(suffix)
        if _nows(content[end : end + 2 * len(suffix) + 8]).startswith(want):
            return True
    elif end == len(content):
        return True
    return False


def suggestion_anchor_accepted(
    content: str,
    stored: Mapping[str, Any],
    resolved: Mapping[str, Any],
    level: str,
    *,
    original_unique: bool,
) -> bool:
    """May a pending suggestion's `stored` anchor move to where the engine
    found it (`resolved` at `level`)? Only an unchanged quote, and only if that
    is demonstrably the same place: the stored context agrees there, or the quote
    was unique when the suggestion was made (`payload.anchorUnique`) and still
    occurs exactly once. A copy of the quote elsewhere is not the selected text -
    that includes a duplicate that slid onto the stored offsets."""
    if resolved.get("start") is None or level not in ACCEPTED_LEVELS:
        return False
    start, end = resolved["start"], resolved["end"]
    if context_agrees(content, stored, start, end):
        return True
    quote = str(resolved.get("quote") or "")
    return bool(original_unique and quote and content.count(quote) == 1)
