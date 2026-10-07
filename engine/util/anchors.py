"""Text-quote anchors over a section's Markdown source (issue #182).

An anchor is a W3C text-quote selector::

    {"quote": str, "prefix": str, "suffix": str, "start": int | None, "end": int | None}

* `start`/`end` are offsets into the section's Markdown source counted in
  **Unicode code points** (Python `str` indices; the web client converts from
  UTF-16), `end` exclusive. Both `None` means the anchor is orphaned: the
  quote could not be found any more.
* `prefix`/`suffix` hold up to `CONTEXT` code points of surrounding text. They
  disambiguate a quote that occurs more than once.

This module is pure stdlib and imports nothing from the engine, so the API
imports it too. Resolution strategies, cheapest first (`resolve_anchor`):

1. the stored offsets still hold the quote;
2. an exact match (several: prefix/suffix agreement, then distance to the
   stored start);
3. a whitespace-normalised match (runs of whitespace compare equal; the match
   is mapped back to real offsets in the original text);
4. a fuzzy match near seed hits / the stored offset (bounded `difflib`
   alignment, with a similarity threshold so unrelated text never matches);
5. orphan.

`resolve_quote` is for a bare quote without offsets (reviewer issues, where an
LLM copied a span of the section): the same ladder plus a tolerant level that
forgives what models change when they quote (curly vs straight quotes,
non-breaking hyphens and spaces, zero-width characters, Markdown emphasis
markers, leading/trailing ellipsis or quote marks, an ellipsis standing for
elided text in the middle).

Whenever a match is found the returned anchor's `quote` is the text actually
matched, so `text[start:end] == quote` always holds for a non-orphaned anchor.
"""

from __future__ import annotations

import unicodedata
from bisect import bisect_left
from difflib import SequenceMatcher
from typing import Any

CONTEXT = 32
FUZZY_THRESHOLD = 0.8
QUOTE_FUZZY_THRESHOLD = 0.85
MIN_FUZZY_LEN = 8
MAX_FUZZY_LEN = 2000
MAX_ELISION_GAP = 1200
_MAX_POSITIONS = 2000

Anchor = dict[str, Any]

# --------------------------------------------------------------------- public


def make_anchor(text: str, start: int, end: int) -> Anchor:
    """The anchor for `text[start:end]` (code-point offsets)."""
    if not (0 <= start <= end <= len(text)):
        raise ValueError(f"range {start}:{end} is outside the text (length {len(text)})")
    return {
        "quote": text[start:end],
        "prefix": text[max(0, start - CONTEXT):start],
        "suffix": text[end:end + CONTEXT],
        "start": start,
        "end": end,
    }


def resolve_anchor(text: str, anchor: Anchor) -> Anchor:
    """`anchor` located in `text`: fresh `start`/`end` (and refreshed
    prefix/suffix) when found, `start`/`end` None when orphaned."""
    quote = str(anchor.get("quote") or "")
    prefix = str(anchor.get("prefix") or "")
    suffix = str(anchor.get("suffix") or "")
    start, end = anchor.get("start"), anchor.get("end")
    hint = start if isinstance(start, int) and not isinstance(start, bool) else None
    if not quote:
        return _orphan(quote, prefix, suffix)
    # 1. the stored offsets still hold the quote
    if isinstance(start, int) and isinstance(end, int) and 0 <= start <= end <= len(text) and text[start:end] == quote:
        return _found(text, start, end)
    span = _locate(text, quote, prefix, suffix, hint, tolerant=False, fuzzy=FUZZY_THRESHOLD)
    if span is None:
        return _orphan(quote, prefix, suffix)
    return _found(text, *span)


def resolve_quote(
    text: str,
    quote: str,
    *,
    prefix: str = "",
    suffix: str = "",
    fuzzy: bool = True,
) -> Anchor:
    """Locate a bare `quote` (no stored offsets) in `text`, tolerating the
    typographic differences LLMs introduce when quoting. Orphaned (start/end
    None, `quote` unchanged) when nothing matches well enough."""
    quote = str(quote or "")
    if not quote.strip():
        return _orphan(quote, prefix, suffix)
    span = _locate(text, quote, prefix, suffix, None, tolerant=True, fuzzy=QUOTE_FUZZY_THRESHOLD if fuzzy else None)
    if span is None:
        return _orphan(quote, prefix, suffix)
    return _found(text, *span)


# --------------------------------------------------------------------- results


def _found(text: str, start: int, end: int) -> Anchor:
    return make_anchor(text, start, end)


def _orphan(quote: str, prefix: str, suffix: str) -> Anchor:
    return {"quote": quote, "prefix": prefix, "suffix": suffix, "start": None, "end": None}


# ------------------------------------------------------------ folded text views

_DASHES = "\u2010\u2011\u2012\u2013\u2014\u2015\u2212\u2043\ufe58\ufe63\uff0d"
_SINGLE_QUOTES = "\u2018\u2019\u201a\u201b\u2032\u02bc\u00b4"
_DOUBLE_QUOTES = "\u201c\u201d\u201e\u201f\u2033\u00ab\u00bb"
_FOLD_CHARS = {
    **{c: "-" for c in _DASHES},
    **{c: "'" for c in _SINGLE_QUOTES},
    **{c: '"' for c in _DOUBLE_QUOTES},
}
# Zero-width characters and the Markdown emphasis / code markers models drop
# when they quote rendered text.
_DROPPED = frozenset("\u200b\u200c\u200d\u2060\ufeff\u00ad*_`")
_EDGE = " \"'.\u2026"  # stripped from a quote's ends at the tolerant level


class _View:
    """A normalised copy of a text plus, for every normalised character, the
    index of the original character it came from."""

    __slots__ = ("s", "idx")

    def __init__(self, s: str, idx: list[int] | None) -> None:
        self.s = s
        self.idx = idx

    def to_view(self, pos: int) -> int:
        """Original offset -> first view index at or after it."""
        return pos if self.idx is None else bisect_left(self.idx, pos)

    def to_orig(self, start: int, end: int) -> tuple[int, int]:
        """View range -> original range."""
        if self.idx is None:
            return start, end
        return self.idx[start], self.idx[end - 1] + 1


def _fold(text: str, level: int) -> _View:
    """Level 0: identity. Level 1: runs of whitespace become one space.
    Level 2: level 1 plus typographic folding (curly quotes, dashes, NFKC
    compatibility forms such as the ellipsis character) and removal of
    zero-width characters and Markdown emphasis/code markers."""
    if level == 0:
        return _View(text, None)
    out: list[str] = []
    idx: list[int] = []
    in_space = False
    for i, ch in enumerate(text):
        if ch.isspace():
            if not in_space:
                out.append(" ")
                idx.append(i)
                in_space = True
            continue
        if level >= 2:
            if ch in _DROPPED:
                continue
            ch = _FOLD_CHARS.get(ch, ch)
            if ord(ch) > 127:
                ch = unicodedata.normalize("NFKC", ch)
        in_space = False
        for c in ch:
            out.append(c)
            idx.append(i)
    return _View("".join(out), idx)


def _fold_str(s: str, level: int) -> str:
    return _fold(s, level).s


# ------------------------------------------------------------------ the ladder


def _locate(
    text: str,
    quote: str,
    prefix: str,
    suffix: str,
    hint: int | None,
    *,
    tolerant: bool,
    fuzzy: float | None,
) -> tuple[int, int] | None:
    """The best (start, end) of `quote` in `text`, or None."""
    top = 2 if tolerant else 1
    for level in range(0, top + 1):
        view = _fold(text, level)
        needles = _needles(quote, level)
        ctx_prefix, ctx_suffix = _fold_str(prefix, level), _fold_str(suffix, level)
        hint_v = view.to_view(hint) if hint is not None else None
        for needle in needles:
            positions = _find_all(view.s, needle)
            if positions:
                i = _pick(view.s, positions, len(needle), ctx_prefix, ctx_suffix, hint_v)
                return view.to_orig(i, i + len(needle))
        if level == top and tolerant:
            for needle in needles:
                span = _elided(view, needle, ctx_prefix, ctx_suffix, hint_v)
                if span is not None:
                    return span
    if fuzzy is not None:
        return _fuzzy(text, quote.strip(), prefix, suffix, hint, fuzzy)
    return None


def _needles(quote: str, level: int) -> list[str]:
    """Search strings for one level: the quote as given, then (tolerant level)
    without the quote marks / ellipses / spaces models put around it."""
    if level == 0:
        return [quote] if quote else []
    folded = _fold_str(quote, level)
    out = [folded.strip(" ")] if folded.strip(" ") else []
    if level >= 2:
        trimmed = folded.strip(_EDGE).strip()
        # "..." is the NFKC form of the ellipsis character; strip() above takes
        # single characters so a run of dots is removed as well.
        if trimmed and trimmed not in out:
            out.append(trimmed)
    return out


def _find_all(haystack: str, needle: str) -> list[int]:
    if not needle:
        return []
    out: list[int] = []
    pos = haystack.find(needle)
    while pos != -1 and len(out) < _MAX_POSITIONS:
        out.append(pos)
        pos = haystack.find(needle, pos + 1)
    return out


def _common_suffix(a: str, b: str) -> int:
    n = 0
    for x, y in zip(reversed(a), reversed(b)):
        if x != y:
            break
        n += 1
    return n


def _common_prefix(a: str, b: str) -> int:
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n


def _context_score(hay: str, i: int, j: int, prefix: str, suffix: str) -> int:
    score = 0
    if prefix:
        score += _common_suffix(hay[max(0, i - len(prefix)):i], prefix)
    if suffix:
        score += _common_prefix(hay[j:j + len(suffix)], suffix)
    return score


def _pick(hay: str, positions: list[int], n: int, prefix: str, suffix: str, hint: int | None) -> int:
    """Among several exact matches: most prefix/suffix agreement, then nearest
    to the stored start (no stored start: the first)."""
    if len(positions) == 1:
        return positions[0]
    return min(
        positions,
        key=lambda i: (-_context_score(hay, i, i + n, prefix, suffix), abs(i - hint) if hint is not None else i),
    )


def _elided(view: _View, needle: str, prefix: str, suffix: str, hint: int | None) -> tuple[int, int] | None:
    """`first ... last`: a quote whose middle the model elided with an
    ellipsis. The span runs from the first segment to the last one found in
    order within `MAX_ELISION_GAP` characters."""
    if "..." not in needle:
        return None
    segments = [seg.strip() for seg in needle.split("...")]
    segments = [seg for seg in segments if seg]
    if len(segments) < 2:
        return None
    s = view.s
    chains: list[tuple[int, int]] = []
    for first in _find_all(s, segments[0]):
        cursor = first + len(segments[0])
        ok = True
        for seg in segments[1:]:
            nxt = s.find(seg, cursor, cursor + MAX_ELISION_GAP + len(seg))
            if nxt == -1:
                ok = False
                break
            cursor = nxt + len(seg)
        if ok:
            chains.append((first, cursor))
    if not chains:
        return None
    first, end = min(
        chains,
        key=lambda c: (-_context_score(s, c[0], c[1], prefix, suffix), abs(c[0] - hint) if hint is not None else c[0]),
    )
    return view.to_orig(first, end)


# ------------------------------------------------------------------ fuzzy match


def _fuzzy(text: str, quote: str, prefix: str, suffix: str, hint: int | None, threshold: float) -> tuple[int, int] | None:
    """Diff-match-patch style: align the quote against a few bounded regions
    of the text (around seed hits, and around the stored offset) and accept
    the best span only when its similarity reaches `threshold`."""
    n = len(quote)
    if not text or n < MIN_FUZZY_LEN or n > MAX_FUZZY_LEN:
        return None
    slack = max(8, n // 4)
    regions: list[tuple[int, int]] = []
    # Seed hits: short pieces of the quote that survived the edit unchanged.
    seed_len = 8 if n < 40 else 12
    step = max(1, (n - seed_len) // 11)
    aligned: list[int] = []
    for off in range(0, n - seed_len + 1, step):
        seed = quote[off:off + seed_len]
        if len(set(seed)) < 3:
            continue
        pos = text.find(seed)
        hits = 0
        while pos != -1 and hits < 25:
            aligned.append(pos - off)
            hits += 1
            pos = text.find(seed, pos + 1)
    aligned.sort()
    clusters: list[list[int]] = []
    for a in aligned:
        if clusters and a - clusters[-1][-1] <= slack:
            clusters[-1].append(a)
        else:
            clusters.append([a])
    clusters.sort(key=len, reverse=True)
    for cluster in clusters[:6]:
        regions.append((max(0, cluster[0] - slack), min(len(text), cluster[-1] + n + slack)))
    if hint is not None:
        w = max(200, n)
        regions.append((max(0, hint - w), min(len(text), hint + n + w)))
    best: tuple[float, int, int] | None = None
    seen: set[tuple[int, int]] = set()
    for lo, hi in regions:
        if hi - lo < 3:
            continue
        span = _best_span(quote, text, lo, hi, slack)
        if span is None or span in seen:
            continue
        seen.add(span)
        a, b = span
        ratio = SequenceMatcher(None, quote, text[a:b], autojunk=False).ratio()
        if ratio < threshold:
            continue
        ctx = _context_score(text, a, b, prefix, suffix) / max(1, len(prefix) + len(suffix))
        near = -abs(a - hint) / (len(text) + 1) if hint is not None else 0.0
        score = ratio + 0.15 * ctx + 0.05 * near
        if best is None or score > best[0]:
            best = (score, a, b)
    return None if best is None else (best[1], best[2])


def _best_span(quote: str, text: str, lo: int, hi: int, slack: int) -> tuple[int, int] | None:
    """The densest run of matching blocks of `quote` inside `text[lo:hi]`,
    as absolute offsets. Isolated short blocks (common letters scattered over
    the region) are ignored so they cannot stretch the span."""
    region = text[lo:hi]
    blocks = [b for b in SequenceMatcher(None, quote, region, autojunk=False).get_matching_blocks() if b.size >= 3]
    if not blocks:
        return None
    runs: list[list[Any]] = []
    for block in blocks:
        if runs and block.b - (runs[-1][-1].b + runs[-1][-1].size) <= slack:
            runs[-1].append(block)
        else:
            runs.append([block])
    run = max(runs, key=lambda r: sum(b.size for b in r))
    return lo + run[0].b, lo + run[-1].b + run[-1].size
