"""Applying an accepted suggestion to the node's *current* text (issue #182).

A suggestion is computed against `originalMarkdown` (hash `baseContentHash`).
Accepting it later must never silently overwrite what the user wrote in the
meantime, so `apply_revision` distinguishes:

* the text is unchanged since the base (hashes agree): the result is exactly
  `replacementMarkdown` (or, for `hunkIndexes`, the original with only those
  hunks applied);
* the text changed, `scope="range"`: the suggestion's anchor (kept up to date
  by `reanchor_node_cards`) is re-resolved in the current text; at the
  `stored` / `exact` / `whitespace` level the replacement of the range is
  spliced in there, otherwise `StaleSuggestion`;
* the text changed, `scope="section"`: every hunk to apply must find its
  `removed` text (with its original surroundings as context) at exactly one
  re-resolvable place of the current text - a pure insertion is located by the
  text around it - and the places must not overlap. One hunk that cannot be
  placed cleanly makes the whole accept a `StaleSuggestion` (409): the user
  rebases by asking again.

Pure functions over strings: no I/O, safe to test exhaustively.
"""
from __future__ import annotations

import hashlib
from typing import Any

from engine.util.anchors import CONTEXT, resolve_anchor_detailed
from engine.util.textdiff import Hunk, apply_hunks

from api.application.comment_anchors import ACCEPTED_LEVELS

MIN_INSERTION_CONTEXT = 12


class StaleSuggestion(Exception):
    """The suggestion no longer applies cleanly to the current text."""


class MalformedSuggestion(Exception):
    """The stored payload is not a usable suggestion."""


def content_hash(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


def hunks_of(payload: dict[str, Any]) -> list[Hunk]:
    try:
        return [
            Hunk(int(h["start"]), int(h["end"]), str(h["removed"]), str(h["added"]))
            for h in payload["hunks"]
        ]
    except (KeyError, TypeError, ValueError) as exc:
        raise MalformedSuggestion("the suggestion carries no usable changes") from exc


def _locate_hunk(current: str, original: str, hunk: Hunk) -> tuple[int, int] | None:
    """Where `hunk` applies in `current`: the span its `removed` text now
    occupies (an empty span for a pure insertion), or None."""
    if hunk.removed:
        anchor = {
            "quote": hunk.removed,
            "prefix": original[max(0, hunk.start - CONTEXT) : hunk.start],
            "suffix": original[hunk.end : hunk.end + CONTEXT],
            "start": hunk.start,
            "end": hunk.end,
        }
        resolved, level = resolve_anchor_detailed(current, anchor)
        if resolved["start"] is None or level not in ACCEPTED_LEVELS:
            return None
        return resolved["start"], resolved["end"]
    before = original[max(0, hunk.start - CONTEXT) : hunk.start]
    after = original[hunk.start : hunk.start + CONTEXT]
    if len((before + after).strip()) < MIN_INSERTION_CONTEXT:
        return None
    anchor = {
        "quote": before + after,
        "prefix": "",
        "suffix": "",
        "start": hunk.start - len(before),
        "end": hunk.start + len(after),
    }
    resolved, level = resolve_anchor_detailed(current, anchor)
    if resolved["start"] is None or level not in ("stored", "exact"):
        return None
    point = resolved["start"] + len(before)
    return point, point


def _apply_hunks_to_changed(current: str, original: str, hunks: list[Hunk]) -> str:
    placed: list[tuple[int, int, str]] = []
    for hunk in hunks:
        span = _locate_hunk(current, original, hunk)
        if span is None:
            raise StaleSuggestion(
                "the section changed since this suggestion was made and part of it no "
                "longer applies cleanly"
            )
        placed.append((span[0], span[1], hunk.added))
    placed.sort(key=lambda p: (p[0], p[1]))
    for earlier, later in zip(placed, placed[1:]):
        if later[0] < earlier[1]:
            raise StaleSuggestion("the changes of this suggestion overlap after the edit")
    text = current
    for start, end, added in reversed(placed):
        text = text[:start] + added + text[end:]
    return text


def _range_replacement(payload: dict[str, Any]) -> str:
    original, replacement = payload["originalMarkdown"], payload["replacementMarkdown"]
    anchor = payload.get("anchor") or {}
    start, end = anchor.get("start"), anchor.get("end")
    if not isinstance(start, int) or not isinstance(end, int):
        raise MalformedSuggestion("the suggestion has no resolved range")
    tail = len(original) - end
    return replacement[start : len(replacement) - tail]


def apply_revision(
    current: str,
    payload: dict[str, Any],
    anchor: dict[str, Any] | None,
    hunk_indexes: list[int] | None = None,
) -> str:
    """The node text after accepting the suggestion (see the module docstring).
    Raises `StaleSuggestion` (409) or `MalformedSuggestion` (500-ish)."""
    try:
        original = str(payload["originalMarkdown"])
        replacement = str(payload["replacementMarkdown"])
        base_hash = str(payload["baseContentHash"])
        scope = str(payload["scope"])
    except KeyError as exc:
        raise MalformedSuggestion("the suggestion is incomplete") from exc
    hunks = hunks_of(payload)
    if hunk_indexes is not None:
        if scope != "section":
            raise MalformedSuggestion("hunkIndexes apply to section suggestions only")
        if any(not 0 <= i < len(hunks) for i in hunk_indexes):
            raise MalformedSuggestion("hunkIndexes out of range")
        chosen = [hunks[i] for i in sorted(set(hunk_indexes))]
    else:
        chosen = hunks

    if content_hash(current) == base_hash:
        if hunk_indexes is None:
            return replacement
        return apply_hunks(original, chosen)

    if scope == "range":
        if anchor is None:
            raise StaleSuggestion("the selected range is gone")
        resolved, level = resolve_anchor_detailed(current, anchor)
        if resolved["start"] is None or level not in ACCEPTED_LEVELS:
            raise StaleSuggestion(
                "the selected text changed since this suggestion was made; ask again"
            )
        new_range = _range_replacement(payload)
        return current[: resolved["start"]] + new_range + current[resolved["end"] :]
    return _apply_hunks_to_changed(current, original, chosen)
