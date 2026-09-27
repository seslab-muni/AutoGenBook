"""Reciprocal rank fusion and source diversification."""

from __future__ import annotations

from typing import Callable, Hashable, Sequence, TypeVar

T = TypeVar("T", bound=Hashable)


def rrf(rankings: Sequence[Sequence[T]], *, k: int = 60) -> list[tuple[T, float]]:
    """Fuse ranked lists: score(d) = sum 1 / (k + rank). Ties keep first-seen order."""
    scores: dict[T, float] = {}
    order: dict[T, int] = {}
    for ranking in rankings:
        for rank, doc in enumerate(ranking, start=1):
            scores[doc] = scores.get(doc, 0.0) + 1.0 / (k + rank)
            order.setdefault(doc, len(order))
    return sorted(scores.items(), key=lambda kv: (-kv[1], order[kv[0]]))


def diversify(items: Sequence[T], key: Callable[[T], str], k: int) -> list[T]:
    """One item per source first (in rank order), then fill up to `k`."""
    if k <= 0:
        return []
    chosen: list[T] = []
    seen: set[str] = set()
    for item in items:
        source = key(item)
        if source in seen:
            continue
        chosen.append(item)
        seen.add(source)
        if len(chosen) >= k:
            return chosen
    for item in items:
        if item not in chosen:
            chosen.append(item)
            if len(chosen) >= k:
                break
    return chosen
