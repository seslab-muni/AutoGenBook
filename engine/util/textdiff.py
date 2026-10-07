"""Word-level text diff as hunks over code-point offsets (pure stdlib).

`diff_hunks(old, new)` returns the edits that turn `old` into `new`, each as
`Hunk(start, end, removed, added)` with `start`/`end` offsets into `old`
(Unicode code points, `end` exclusive) and `old[start:end] == removed`.
Applying the hunks back to front reproduces `new` exactly (`apply_hunks`).

The diff is hierarchical so it stays fast on large sections: common prefix and
suffix are trimmed, then lines are matched, inside changed line blocks
sentences, and only inside changed sentence blocks words (a token is a word or
a punctuation mark with the whitespace that follows it). A block that is too
expensive for `difflib` (many repeated tokens) is aligned on the tokens that
occur exactly once on both sides (patience diff); a gap that still cannot be
matched, or any work left when the time budget is spent, degrades to one coarse
hunk - never to a wrong answer. `diff_hunks_detailed` also reports how many
blocks degraded. Two edits separated by at most one short word are merged, up
to `MAX_MERGED_CHARS`, so a suggestion reads as "quick brown fox -> slow red
dog" rather than a scatter of single-word edits.
"""

from __future__ import annotations

import re
import time
from bisect import bisect_left
from collections import Counter
from dataclasses import asdict, dataclass
from difflib import SequenceMatcher
from typing import Any, Callable, Sequence

_TOKEN_RE = re.compile(r"(?:\w+|[^\w\s])\s*|\s+")
_BARE_TOKEN_RE = re.compile(r"\s+|\w+|[^\w\s]")
_LINE_SPLIT = re.compile(r"\n")
_SENTENCE_SPLIT = re.compile(r"[.!?]+[ \t]+|\n")
MERGE_GAP_CHARS = 12
MAX_MERGED_CHARS = 400  # a merged hunk stays readable: removed + added
MAX_PAIRS = 150_000  # candidate token pairs difflib may scan in one block
DEFAULT_BUDGET_S = 2.5


@dataclass(frozen=True)
class Hunk:
    start: int
    end: int
    removed: str
    added: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class DiffCancelled(Exception):
    """`should_stop` returned True."""


def _split(text: str, pattern: re.Pattern[str]) -> list[str]:
    units: list[str] = []
    pos = 0
    for m in pattern.finditer(text):
        units.append(text[pos:m.end()])
        pos = m.end()
    if pos < len(text):
        units.append(text[pos:])
    return units


_LEVELS: tuple[Callable[[str], list[str]], ...] = (
    lambda t: _split(t, _LINE_SPLIT),
    lambda t: _split(t, _SENTENCE_SPLIT),
    lambda t: _TOKEN_RE.findall(t),
)


def _trim(a: Sequence[str], b: Sequence[str]) -> tuple[int, int]:
    """Lengths of the common head and tail (in units), not overlapping."""
    head = 0
    limit = min(len(a), len(b))
    while head < limit and a[head] == b[head]:
        head += 1
    tail = 0
    while tail < limit - head and a[len(a) - 1 - tail] == b[len(b) - 1 - tail]:
        tail += 1
    return head, tail


def _starts(units: Sequence[str]) -> list[int]:
    out = [0]
    for u in units:
        out.append(out[-1] + len(u))
    return out


def _pairs(a: Sequence[str], b: Sequence[str]) -> int:
    """How many (i, j) pairs of equal units difflib would have to scan."""
    count_a, count_b = Counter(a), Counter(b)
    return sum(n * count_b[u] for u, n in count_a.items() if u in count_b)


class _Differ:
    def __init__(self, budget_s: float, should_stop: Callable[[], bool] | None) -> None:
        self.deadline = time.perf_counter() + budget_s
        self.should_stop = should_stop
        self.hunks: list[Hunk] = []
        self.coarse = 0

    def check(self) -> None:
        if self.should_stop is not None and self.should_stop():
            raise DiffCancelled()

    def out_of_time(self) -> bool:
        return time.perf_counter() > self.deadline

    def run(self, old: str, new: str, base: int, level: int = 0) -> None:
        """Diff `old` against `new` (old starts at offset `base`)."""
        self.check()
        if old == new:
            return
        if level >= len(_LEVELS):
            self.hunks.append(Hunk(base, base + len(old), old, new))
            return
        a, b = _LEVELS[level](old), _LEVELS[level](new)
        head, tail = _trim(a, b)
        mid_a, mid_b = a[head:len(a) - tail], b[head:len(b) - tail]
        offset = base + sum(len(u) for u in a[:head])
        old_mid, new_mid = "".join(mid_a), "".join(mid_b)
        if not old_mid and not new_mid:
            return
        if not mid_a or not mid_b:  # a pure insertion or deletion
            self.hunks.append(Hunk(offset, offset + len(old_mid), old_mid, new_mid))
            return
        if self.out_of_time():
            self.coarse += 1
            self.hunks.append(Hunk(offset, offset + len(old_mid), old_mid, new_mid))
            return
        starts_a = _starts(mid_a)
        for tag, i1, i2, j1, j2 in self.opcodes(mid_a, mid_b):
            if tag == "equal":
                continue
            seg_old, seg_new = "".join(mid_a[i1:i2]), "".join(mid_b[j1:j2])
            if tag in ("insert", "delete"):
                self.hunks.append(Hunk(offset + starts_a[i1], offset + starts_a[i2], seg_old, seg_new))
                continue
            units_old, units_new = mid_a[i1:i2], mid_b[j1:j2]
            pos = offset + starts_a[i1]
            if len(units_old) == len(units_new) > 1:
                # edits in place (every line differs a little): pair the units
                for x, y in zip(units_old, units_new):
                    self.run(x, y, pos, level + 1)
                    pos += len(x)
            else:
                self.run(seg_old, seg_new, pos, level + 1)

    def opcodes(self, a: Sequence[str], b: Sequence[str], i0: int = 0, j0: int = 0) -> list[tuple[str, int, int, int, int]]:
        """`SequenceMatcher` opcodes, or - when the block has too many repeated
        tokens for it - a patience diff: units occurring exactly once on both
        sides anchor the alignment (longest increasing subsequence) and each
        gap is diffed on its own. A gap with no anchors is one coarse `replace`."""
        self.check()
        if not a or not b:
            return [("insert" if not a else "delete", i0, i0 + len(a), j0, j0 + len(b))] if (a or b) else []
        if self.out_of_time():
            self.coarse += 1
            return [("replace", i0, i0 + len(a), j0, j0 + len(b))]
        if _pairs(a, b) <= MAX_PAIRS:
            return [(t, i0 + i1, i0 + i2, j0 + j1, j0 + j2) for t, i1, i2, j1, j2 in SequenceMatcher(None, a, b, autojunk=False).get_opcodes()]
        count_a = Counter(a)
        count_b = Counter(b)
        pos_b = {u: j for j, u in enumerate(b)}
        pairs = [(i, pos_b[u]) for i, u in enumerate(a) if count_a[u] == 1 and count_b.get(u) == 1 and len(u.strip()) >= 3]
        tails: list[int] = []
        tail_idx: list[int] = []
        prev: list[int] = [-1] * len(pairs)
        for k, (_i, j) in enumerate(pairs):
            at = bisect_left(tails, j)
            if at == len(tails):
                tails.append(j)
                tail_idx.append(k)
            else:
                tails[at] = j
                tail_idx[at] = k
            prev[k] = tail_idx[at - 1] if at else -1
        chain: list[tuple[int, int]] = []
        k = tail_idx[-1] if tail_idx else -1
        while k != -1:
            chain.append(pairs[k])
            k = prev[k]
        chain.reverse()
        if not chain:
            self.coarse += 1
            return [("replace", i0, i0 + len(a), j0, j0 + len(b))]
        out: list[tuple[str, int, int, int, int]] = []
        pi = pj = 0
        for i, j in chain + [(len(a), len(b))]:
            if i > pi or j > pj:
                ga, gb = a[pi:i], b[pj:j]
                if ga != gb:
                    out += [o for o in self.opcodes(ga, gb, i0 + pi, j0 + pj) if o[0] != "equal"]
            pi, pj = i + 1, j + 1
        return out


def _bare(text: str) -> list[str]:
    return _BARE_TOKEN_RE.findall(text)


def _tighten(h: Hunk) -> Hunk:
    """Trim whole tokens that a hunk's removed and added text share at either
    end (a word that only gained a trailing newline is not part of the change)."""
    if not h.removed or not h.added:
        return h
    a, b = _bare(h.removed), _bare(h.added)
    head, tail = _trim(a, b)
    if not head and not tail:
        return h
    lead = sum(len(t) for t in a[:head])
    trail = sum(len(t) for t in a[len(a) - tail:]) if tail else 0
    return Hunk(h.start + lead, h.end - trail, h.removed[lead:len(h.removed) - trail], h.added[lead:len(h.added) - trail])


def _merge(old: str, hunks: list[Hunk]) -> list[Hunk]:
    merged: list[Hunk] = []
    for h in hunks:
        if merged:
            prev = merged[-1]
            gap = old[prev.end:h.start]
            words = [t for t in _bare(gap) if not t.isspace()]
            size = len(prev.removed) + len(prev.added) + len(gap) * 2 + len(h.removed) + len(h.added)
            if len(words) <= 1 and len(gap) <= MERGE_GAP_CHARS and size <= MAX_MERGED_CHARS:
                merged[-1] = Hunk(prev.start, h.end, old[prev.start:h.end], prev.added + gap + h.added)
                continue
        merged.append(h)
    return merged


def diff_hunks_detailed(
    old: str,
    new: str,
    *,
    base: int = 0,
    budget_s: float = DEFAULT_BUDGET_S,
    should_stop: Callable[[], bool] | None = None,
) -> tuple[list[Hunk], int]:
    """`diff_hunks` plus the number of blocks that degraded to a whole-block
    hunk (time budget spent, or too repetitive to align)."""
    if old == new:
        return [], 0
    differ = _Differ(budget_s, should_stop)
    differ.run(old, new, 0)
    hunks = _merge(old, [_tighten(h) for h in sorted(differ.hunks, key=lambda h: h.start)])
    return [Hunk(base + h.start, base + h.end, h.removed, h.added) for h in hunks], differ.coarse


def diff_hunks(
    old: str,
    new: str,
    *,
    base: int = 0,
    budget_s: float = DEFAULT_BUDGET_S,
    should_stop: Callable[[], bool] | None = None,
) -> list[Hunk]:
    """Hunks turning `old` into `new`; `base` is added to every offset (the
    start of `old` inside a larger text). `should_stop` is polled between
    blocks; when it returns True `DiffCancelled` is raised."""
    return diff_hunks_detailed(old, new, base=base, budget_s=budget_s, should_stop=should_stop)[0]


def apply_hunks(text: str, hunks: Sequence[Hunk], *, base: int = 0) -> str:
    """`text` with the hunks (offsets relative to `base`) applied."""
    out = text
    for hunk in sorted(hunks, key=lambda h: h.start, reverse=True):
        start, end = hunk.start - base, hunk.end - base
        if out[start:end] != hunk.removed:
            raise ValueError("hunk does not match the text it is applied to")
        out = out[:start] + hunk.added + out[end:]
    return out
