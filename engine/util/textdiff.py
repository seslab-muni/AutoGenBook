"""Word-level text diff as hunks over code-point offsets (pure stdlib).

`diff_hunks(old, new)` returns the edits that turn `old` into `new`, each as
`Hunk(start, end, removed, added)` with `start`/`end` offsets into `old`
(Unicode code points, `end` exclusive) and `old[start:end] == removed`.
Applying the hunks back to front reproduces `new` exactly (`apply_hunks`).

Granularity is the word: tokens are words, single punctuation marks and
whitespace runs, and two edits separated by at most one short word are merged
into one hunk so a suggestion reads as "quick brown fox -> slow red dog"
rather than as a scatter of single-word edits.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from difflib import SequenceMatcher
from typing import Any, Sequence

_TOKEN_RE = re.compile(r"\s+|\w+|[^\w\s]")
MERGE_GAP_CHARS = 12


@dataclass(frozen=True)
class Hunk:
    start: int
    end: int
    removed: str
    added: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _offsets(tokens: Sequence[str]) -> list[int]:
    out = [0]
    for token in tokens:
        out.append(out[-1] + len(token))
    return out


def diff_hunks(old: str, new: str, *, base: int = 0) -> list[Hunk]:
    """Hunks turning `old` into `new`; `base` is added to every offset (the
    start of `old` inside a larger text)."""
    if old == new:
        return []
    a, b = _TOKEN_RE.findall(old), _TOKEN_RE.findall(new)
    ao, bo = _offsets(a), _offsets(b)
    ops = [op for op in SequenceMatcher(None, a, b, autojunk=False).get_opcodes() if op[0] != "equal"]
    merged: list[list[int]] = []  # [i1, i2, j1, j2]
    for _tag, i1, i2, j1, j2 in ops:
        if merged:
            gap = a[merged[-1][1]:i1]
            words = [t for t in gap if not t.isspace()]
            if len(words) <= 1 and sum(len(t) for t in gap) <= MERGE_GAP_CHARS:
                merged[-1][1], merged[-1][3] = i2, j2
                continue
        merged.append([i1, i2, j1, j2])
    return [
        Hunk(base + ao[i1], base + ao[i2], old[ao[i1]:ao[i2]], new[bo[j1]:bo[j2]])
        for i1, i2, j1, j2 in merged
    ]


def apply_hunks(text: str, hunks: Sequence[Hunk], *, base: int = 0) -> str:
    """`text` with the hunks (offsets relative to `base`) applied."""
    out = text
    for hunk in sorted(hunks, key=lambda h: h.start, reverse=True):
        start, end = hunk.start - base, hunk.end - base
        if out[start:end] != hunk.removed:
            raise ValueError("hunk does not match the text it is applied to")
        out = out[:start] + hunk.added + out[end:]
    return out
