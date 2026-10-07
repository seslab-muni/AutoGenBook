"""Text-quote anchors over a section's Markdown source (issue #182).

An anchor is a W3C text-quote selector::

    {"quote": str, "prefix": str, "suffix": str, "start": int | None, "end": int | None}

* `start`/`end` are offsets into the section's Markdown source counted in
  **Unicode code points** (Python `str` indices; the web client converts from
  UTF-16), `end` exclusive. Both `None` means the anchor is orphaned: the
  quote could not be found any more. Offsets that are not plain ints (floats,
  strings, bools) are treated as absent.
* `prefix`/`suffix` hold up to `CONTEXT` code points of surrounding text. They
  disambiguate a quote that occurs more than once.

This module is pure stdlib and imports nothing from the engine, so the API
imports it too. The guiding rule is that **a false-positive match is worse
than an orphan**: whenever the evidence does not single out one place, the
anchor is orphaned. Strategies, cheapest first (`resolve_anchor`):

1. the stored offsets still hold the quote, and the quote is unique in the
   text or the stored prefix/suffix agree there (`stored`);
2. an exact match (`exact`); several: prefix/suffix agreement, then distance
   to the stored start; a short quote (under `MIN_NEEDLE_CHARS` characters and
   `MIN_NEEDLE_WORDS` words) must sit on word boundaries and be singled out
   by context or by being the only occurrence;
3. a whitespace-normalised match, then an NFC-normalised one (`whitespace`,
   `tolerant`); the match is mapped back to real offsets in the original text;
4. a bounded fuzzy match (`fuzzy`): seed hits and the stored offset give a few
   small regions that are aligned with `difflib`; the span must be close to the
   quote's length, snap to word boundaries and reach a similarity threshold.
   Quotes longer than `MAX_FUZZY_LEN` are anchored by their first and last
   `HEAD_TAIL` characters instead (both must match, at a plausible distance);
5. orphan.

`resolve_quote` is for a bare quote without offsets (reviewer issues, where an
LLM copied a span of the section): the same ladder plus a tolerant level for
what models change when they quote (curly vs straight quotes, non-breaking
hyphens and spaces, zero-width characters, Markdown emphasis markers,
leading/trailing ellipsis or quote marks, an ellipsis for elided text).

Whenever a match is found the returned anchor's `quote` is the text actually
matched, so `text[start:end] == quote` always holds for a non-orphaned anchor.
The `*_detailed` variants also return the level that matched (`LEVELS`); the
anchor shape itself never changes.
"""

from __future__ import annotations

import re
import unicodedata
from bisect import bisect_left
from difflib import SequenceMatcher
from typing import Any

CONTEXT = 32
FUZZY_THRESHOLD = 0.8
QUOTE_FUZZY_THRESHOLD = 0.85
MIN_FUZZY_LEN = 20
MAX_FUZZY_LEN = 600
HEAD_TAIL = 200
MIN_NEEDLE_CHARS = 12
MIN_NEEDLE_WORDS = 3
MIN_SEGMENT_CHARS = 12
MIN_BARE_CHARS = 4  # shortest quote that may stand alone, without context or stored offsets
MIN_REPEATABLE_CHARS = 30  # shortest quote whose first occurrence is taken when it repeats
LEVELS = ("stored", "exact", "whitespace", "tolerant", "fuzzy", "orphan")
_MAX_POSITIONS = 2000
_WINDOW = 4000
_CONTEXT_AGREE = 12

Anchor = dict[str, Any]
Span = tuple[int, int]

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
    return resolve_anchor_detailed(text, anchor)[0]


def resolve_anchor_detailed(text: str, anchor: Anchor) -> tuple[Anchor, str]:
    """`resolve_anchor` plus the level that matched (one of `LEVELS`)."""
    quote = str(anchor.get("quote") or "")
    prefix = str(anchor.get("prefix") or "")
    suffix = str(anchor.get("suffix") or "")
    start, end = anchor.get("start"), anchor.get("end")
    hint = start if _is_offset(start, len(text)) else None
    if not quote.strip():
        return _orphan(quote, prefix, suffix), "orphan"
    if hint is not None and _is_offset(end, len(text)) and start <= end and text[start:end] == quote:
        if _unique(text, quote) or _agrees(text, start, end, prefix, suffix):
            return make_anchor(text, start, end), "stored"
    span, level = _locate(text, quote, prefix, suffix, hint, tolerant=False)
    if span is None:
        span = _fuzzy(text, quote.strip(), prefix, suffix, hint, FUZZY_THRESHOLD)
        level = "fuzzy"
    if span is None:
        return _orphan(quote, prefix, suffix), "orphan"
    return make_anchor(text, *span), level


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
    return resolve_quote_detailed(text, quote, prefix=prefix, suffix=suffix, fuzzy=fuzzy)[0]


def resolve_quote_detailed(
    text: str, quote: str, *, prefix: str = "", suffix: str = "", fuzzy: bool = True
) -> tuple[Anchor, str]:
    quote = str(quote or "")
    if not quote.strip():
        return _orphan(quote, prefix, suffix), "orphan"
    span, level = _locate(text, quote, prefix, suffix, None, tolerant=True)
    if span is None and fuzzy:
        span = _fuzzy(text, quote.strip(), prefix, suffix, None, QUOTE_FUZZY_THRESHOLD)
        level = "fuzzy"
    if span is None:
        return _orphan(quote, prefix, suffix), "orphan"
    return make_anchor(text, *span), level


# --------------------------------------------------------------------- helpers


def _is_offset(value: Any, size: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= size


def _orphan(quote: str, prefix: str, suffix: str) -> Anchor:
    return {"quote": quote, "prefix": prefix, "suffix": suffix, "start": None, "end": None}


def _unique(text: str, quote: str) -> bool:
    first = text.find(quote)
    return first != -1 and text.find(quote, first + 1) == -1


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


def _agrees(text: str, start: int, end: int, prefix: str, suffix: str) -> bool:
    """The stored context still surrounds [start, end) (up to a few edits far away)."""
    if prefix and _common_suffix(text[max(0, start - len(prefix)):start], prefix) < min(len(prefix), _CONTEXT_AGREE):
        return False
    if suffix and _common_prefix(text[end:end + len(suffix)], suffix) < min(len(suffix), _CONTEXT_AGREE):
        return False
    return True


def _is_short(needle: str) -> bool:
    return len(needle) < MIN_NEEDLE_CHARS and len(needle.split()) < MIN_NEEDLE_WORDS


def _on_boundaries(hay: str, i: int, j: int) -> bool:
    if hay[i:i + 1].isalnum() and i > 0 and (hay[i - 1].isalnum() or hay[i - 1] == "_"):
        return False
    if j > 0 and hay[j - 1:j].isalnum() and j < len(hay) and (hay[j].isalnum() or hay[j] == "_"):
        return False
    return True


# ------------------------------------------------------------ folded text views

_DASHES = "‐‑‒–—―−⁃﹘﹣－"
_SINGLE_QUOTES = "‘’‚‛′ʼ´"
_DOUBLE_QUOTES = "“”„‟″«»"
_FOLD_CHARS = {
    **{c: "-" for c in _DASHES},
    **{c: "'" for c in _SINGLE_QUOTES},
    **{c: '"' for c in _DOUBLE_QUOTES},
}
# Zero-width characters and the Markdown emphasis / code markers models drop
# when they quote rendered text.
_DROPPED = frozenset("​‌‍⁠﻿­*_`")
_MARKERS = "*_`"
_EDGE = " \"'.…"  # stripped from a quote's ends at the tolerant level
_SPACE_OR_WORD = re.compile(r"\s+|\S+")


class _View:
    """A normalised copy of a text plus, for every normalised character, the
    original range it came from (`idx[i]:end[i]`)."""

    __slots__ = ("s", "idx", "end")

    def __init__(self, s: str, idx: list[int] | None, end: list[int] | None) -> None:
        self.s, self.idx, self.end = s, idx, end

    def to_view(self, pos: int) -> int:
        return pos if self.idx is None else bisect_left(self.idx, pos)

    def to_orig(self, a: int, b: int) -> Span:
        if self.idx is None or self.end is None:
            return a, b
        return self.idx[a], self.end[b - 1]


def _clusters(chunk: str, base: int):
    """(text, start, end) of each base character with its combining marks."""
    i, n = 0, len(chunk)
    while i < n:
        j = i + 1
        while j < n and unicodedata.combining(chunk[j]):
            j += 1
        yield chunk[i:j], base + i, base + j
        i = j


def _fold(text: str, level: int) -> _View:
    """Level 0 identity; 1 whitespace runs collapse to one space; 2 adds NFC;
    3 adds typographic folding (curly quotes, dashes, NFKC forms such as the
    ellipsis character) and removal of zero-width characters and Markdown
    emphasis/code markers."""
    if level == 0:
        return _View(text, None, None)
    out: list[str] = []
    idx: list[int] = []
    end: list[int] = []
    for m in _SPACE_OR_WORD.finditer(text):
        chunk, a, b = m.group(0), m.start(), m.end()
        if chunk[0].isspace():
            out.append(" ")
            idx.append(a)
            end.append(b)
            continue
        if level == 1 or (chunk.isascii() and (level < 3 or not any(c in _DROPPED for c in chunk))):
            out.append(chunk)
            idx.extend(range(a, b))
            end.extend(range(a + 1, b + 1))
            continue
        for cluster, ca, cb in _clusters(chunk, a):
            if level >= 3:
                if cluster in _DROPPED:
                    continue
                cluster = "".join(_FOLD_CHARS.get(c, c) for c in cluster)
                cluster = unicodedata.normalize("NFKC", cluster)
            else:
                cluster = unicodedata.normalize("NFC", cluster)
            for c in cluster:
                out.append(c)
                idx.append(ca)
                end.append(cb)
    return _View("".join(out), idx, end)


def _fold_str(s: str, level: int) -> str:
    return _fold(s, level).s


# ------------------------------------------------------------------ the ladder


def _locate(text: str, quote: str, prefix: str, suffix: str, hint: int | None, *, tolerant: bool) -> tuple[Span | None, str]:
    """The best (start, end) of `quote` in `text` (exact, whitespace, NFC and,
    when `tolerant`, typographic levels), with the level name."""
    plan: list[tuple[int, str]] = [(0, "exact")]
    if any(c.isspace() for c in quote):
        plan.append((1, "whitespace"))
    if not (unicodedata.is_normalized("NFC", text) and unicodedata.is_normalized("NFC", quote)):
        plan.append((2, "tolerant"))
    if tolerant:
        plan.append((3, "tolerant"))
    for lv, label in plan:
        view = _fold(text, lv)
        ctx_p, ctx_s = _fold_str(prefix, lv), _fold_str(suffix, lv)
        hint_v = view.to_view(hint) if hint is not None else None
        needles = _needles(quote, lv)
        for needle in needles:
            positions, truncated = _find_all(view.s, needle)
            if truncated:
                positions = _near_hint(view.s, needle, hint_v) if hint_v is not None else []
                if not positions:
                    return None, "orphan"
            short = _is_short(needle)
            if short:
                positions = [i for i in positions if _on_boundaries(view.s, i, i + len(needle))]
            if positions:
                chosen = _choose(view.s, positions, len(needle), ctx_p, ctx_s, hint_v, short)
                if chosen is None:
                    return None, "orphan"
                a, b = view.to_orig(chosen, chosen + len(needle))
                if lv >= 3:
                    a, b = _extend_markers(text, a, b)
                return (a, b), label
        if lv == 3:
            for needle in needles:
                span = _elided(view, needle, ctx_p, ctx_s, hint_v)
                if span is not None:
                    return _extend_markers(text, *span), label
    return None, "orphan"


def _needles(quote: str, level: int) -> list[str]:
    """Search strings for one level: the quote as given, then (typographic
    level) without the quote marks / ellipses / spaces models put around it."""
    if level == 0:
        return [quote]
    folded = _fold_str(quote, level).strip(" ")
    out = [folded] if folded else []
    if level >= 3:
        trimmed = folded.strip(_EDGE).strip()
        if trimmed and trimmed not in out:
            out.append(trimmed)
    return out


def _find_all(haystack: str, needle: str) -> tuple[list[int], bool]:
    if not needle:
        return [], False
    out: list[int] = []
    pos = haystack.find(needle)
    while pos != -1:
        if len(out) >= _MAX_POSITIONS:
            return out, True
        out.append(pos)
        pos = haystack.find(needle, pos + 1)
    return out, False


def _near_hint(hay: str, needle: str, hint: int) -> list[int]:
    """Occurrences within a window around the stored offset (used when the
    quote is too frequent to list every occurrence)."""
    lo, hi = max(0, hint - _WINDOW), min(len(hay), hint + len(needle) + _WINDOW)
    out: list[int] = []
    pos = hay.find(needle, lo, hi)
    while pos != -1 and len(out) < _MAX_POSITIONS:
        out.append(pos)
        pos = hay.find(needle, pos + 1, hi)
    return out


def _choose(hay: str, positions: list[int], n: int, prefix: str, suffix: str, hint: int | None, short: bool) -> int | None:
    """One occurrence among `positions`, or None when the evidence does not
    single one out (a short quote needs evidence; a long one falls back to the
    first occurrence, which is the same text)."""
    if len(positions) == 1:
        if n < MIN_BARE_CHARS and not (prefix or suffix or hint is not None):
            return None  # a lone character or two, with nothing to vouch for the place
        return positions[0]
    scored = sorted(
        ((-_context_score(hay, i, i + n, prefix, suffix), abs(i - hint) if hint is not None else 0, i) for i in positions)
    )
    best = scored[0]
    tie = scored[1][:2] == best[:2]
    has_context = best[0] < 0
    if short:
        if tie or not (has_context or (hint is not None and best[1] <= 64)):
            return None
        return best[2]
    if tie and not has_context and hint is None:
        return positions[0] if n >= MIN_REPEATABLE_CHARS else None  # a repeated long sentence is the same text
    return best[2]


def _elided(view: _View, needle: str, prefix: str, suffix: str, hint: int | None) -> Span | None:
    """`first ... last`: a quote whose middle the model elided. Every segment
    must be substantial, the segments must follow in order within a span of a
    small multiple of the quote, and exactly one such chain may exist unless
    context or the stored offset singles one out."""
    if "..." not in needle:
        return None
    segments = [seg.strip() for seg in needle.split("...")]
    segments = [seg for seg in segments if seg]
    if len(segments) < 2 or any(len(seg) < MIN_SEGMENT_CHARS for seg in segments):
        return None
    s = view.s
    limit = 4 * len(needle) + 200
    chains: list[Span] = []
    firsts, truncated = _find_all(s, segments[0])
    if truncated:
        return None
    for first in firsts:
        cursor, ok = first + len(segments[0]), True
        for seg in segments[1:]:
            nxt = s.find(seg, cursor, first + limit)
            if nxt == -1:
                ok = False
                break
            cursor = nxt + len(seg)
        if ok and cursor - first <= limit:
            chains.append((first, cursor))
    if not chains:
        return None
    if len(chains) > 1:
        scored = sorted((-_context_score(s, a, b, prefix, suffix), abs(a - hint) if hint is not None else 0, a, b) for a, b in chains)
        if scored[0][0] == 0 and (hint is None or scored[0][1] == scored[1][1]) or scored[0][:2] == scored[1][:2]:
            return None
        a, b = scored[0][2], scored[0][3]
    else:
        a, b = chains[0]
    return view.to_orig(a, b)


def _extend_markers(text: str, a: int, b: int) -> Span:
    """A tolerant match must not stop inside an emphasis delimiter: extend the
    span over flanking `*`/`_`/backtick runs directly adjacent to it."""
    i = a
    while i > 0 and text[i - 1] in _MARKERS:
        i -= 1
    if i < a and i > 0 and (text[i - 1].isalnum()):
        i = a  # an in-word underscore, not a delimiter
    j = b
    while j < len(text) and text[j] in _MARKERS:
        j += 1
    if j > b and j < len(text) and text[j].isalnum():
        j = b
    return i, j


# ------------------------------------------------------------------ fuzzy match


def _fuzzy(text: str, quote: str, prefix: str, suffix: str, hint: int | None, threshold: float) -> Span | None:
    """Diff-match-patch style: align the quote against a few bounded regions
    of the text (around seed hits, and around the stored offset) and accept
    the best span only when it is about as long as the quote and its
    similarity reaches `threshold`."""
    n = len(quote)
    if not text or n < MIN_FUZZY_LEN:
        return None
    if n > MAX_FUZZY_LEN:
        return _head_tail(text, quote, prefix, suffix, hint)
    slack = max(8, min(40, n // 5))
    aligned: list[int] = []
    seed_len = 8 if n < 40 else 12
    step = max(1, (n - seed_len) // 11)
    for off in range(0, n - seed_len + 1, step):
        seed = quote[off:off + seed_len]
        if len(set(seed)) < 3:
            continue
        pos, hits = text.find(seed), 0
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
    regions = [(max(0, c[0] - slack), min(len(text), c[-1] + n + slack)) for c in clusters[:6]]
    if hint is not None:
        w = max(100, n)
        regions.append((max(0, hint - w), min(len(text), hint + n + w)))
    found: list[tuple[float, float, float, int, int, int]] = []  # score, ratio, ctx, dist, a, b
    seen: set[Span] = set()
    for lo, hi in regions:
        if hi - lo < 3:
            continue
        span = _best_span(quote, text, lo, hi, slack)
        if span is None:
            continue
        span = _snap(text, *span)
        if span in seen:
            continue
        seen.add(span)
        a, b = span
        if not (0.85 * n <= b - a <= 1.15 * n + 4):
            continue
        ratio = SequenceMatcher(None, quote, text[a:b], autojunk=False).ratio()
        if ratio < threshold:
            continue
        ctx = _context_score(text, a, b, prefix, suffix) / max(1, len(prefix) + len(suffix))
        dist = abs(a - hint) if hint is not None else 0
        found.append((ratio + 0.15 * ctx, ratio, ctx, dist, a, b))
    if not found:
        return None
    found.sort(key=lambda f: (-f[0], f[3]))
    best = found[0]
    rivals = [f for f in found[1:] if (f[4] >= best[5] or f[5] <= best[4]) and f[1] >= best[1] - 0.07]
    if rivals:
        # Several places look about equally like the quote (siblings such as
        # "Theorem 1." / "Theorem 2."): only context or the stored offset may decide.
        decided = all(best[2] >= r[2] + 0.1 for r in rivals) or (hint is not None and all(best[3] < r[3] / 2 for r in rivals))
        if not decided:
            return None
    return best[4], best[5]


def _best_span(quote: str, text: str, lo: int, hi: int, slack: int) -> Span | None:
    """The densest run of matching blocks of `quote` inside `text[lo:hi]`
    (absolute offsets). Isolated short blocks are ignored and weak edge blocks
    across a large gap are trimmed so neighbouring text is not absorbed."""
    region = text[lo:hi]
    blocks = [b for b in SequenceMatcher(None, quote, region, autojunk=False).get_matching_blocks() if b.size >= 4]
    if not blocks:
        return None
    runs: list[list[Any]] = []
    for block in blocks:
        if runs and block.b - (runs[-1][-1].b + runs[-1][-1].size) <= slack:
            runs[-1].append(block)
        else:
            runs.append([block])
    run = max(runs, key=lambda r: sum(b.size for b in r))
    while len(run) > 2:
        if run[0].size < 6 and run[1].b - (run[0].b + run[0].size) > 8:
            run = run[1:]
        elif run[-1].size < 6 and run[-1].b - (run[-2].b + run[-2].size) > 8:
            run = run[:-1]
        else:
            break
    return lo + run[0].b, lo + run[-1].b + run[-1].size


def _snap(text: str, a: int, b: int) -> Span:
    """Move the edges outward to word boundaries (at most 12 characters)."""
    for _ in range(12):
        if a > 0 and text[a - 1].isalnum() and text[a].isalnum():
            a -= 1
        else:
            break
    for _ in range(12):
        if b < len(text) and text[b].isalnum() and text[b - 1].isalnum():
            b += 1
        else:
            break
    return a, b


def _head_tail(text: str, quote: str, prefix: str, suffix: str, hint: int | None) -> Span | None:
    """A long quote is anchored by its first and last `HEAD_TAIL` characters:
    both must occur, in order, at a distance within 5 % of the quote's length."""
    n = len(quote)
    head, tail = quote[:HEAD_TAIL], quote[-HEAD_TAIL:]
    heads, t1 = _find_all(text, head)
    tails, t2 = _find_all(text, tail)
    if t1 or t2 or not heads or not tails:
        return None
    pairs: list[Span] = []
    for h in heads:
        for t in tails:
            length = t + len(tail) - h
            if abs(length - n) <= max(40, n // 20):
                pairs.append((h, t + len(tail)))
    if not pairs:
        return None
    if len(pairs) == 1:
        return pairs[0]
    scored = sorted((-_context_score(text, a, b, prefix, suffix), abs(a - hint) if hint is not None else 0, a, b) for a, b in pairs)
    if scored[0][:2] == scored[1][:2] or (scored[0][0] == 0 and hint is None):
        return None
    return scored[0][2], scored[0][3]
