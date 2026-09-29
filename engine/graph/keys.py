"""Node keys: `book` for the root, then dash-joined 1-based positions (`1`, `1-2`, ...)."""

from __future__ import annotations

from typing import Iterable

ROOT = "book"


def parse_key(key: str) -> tuple[int, ...]:
    if key == ROOT:
        return ()
    return tuple(int(part) for part in key.split("-") if part.isdigit())


def sort_keys(keys: Iterable[str]) -> list[str]:
    return sorted(keys, key=parse_key)


def depth_of(key: str) -> int:
    return 0 if key == ROOT else len(key.split("-"))


def child_key(parent: str, index: int) -> str:
    """Key of the `index`-th (1-based) child of `parent`."""
    return str(index) if parent == ROOT else f"{parent}-{index}"
