"""Pure functions over outline nodes: tree/flat conversion and position math.

None of this touches the database - `api.application.outline.OutlineService`
is the layer that loads/saves via `OutlineRepository` and calls into here for
the actual tree/position logic. Keeping it pure makes it straightforward to
unit test the "1", "1-1", "1.2" positional-key math in isolation.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field, replace
from typing import Sequence

from api.domain.models import OutlineNode


@dataclass
class OutlineTree:
    """`OutlineNode` (with `level`/`sectionNumber`/`cliKey` populated) plus its
    already-positioned children, nested."""

    node: OutlineNode
    children: list["OutlineTree"] = field(default_factory=list)


def _siblings_by_parent(
    flat: Sequence[OutlineNode],
) -> dict[uuid.UUID | None, list[OutlineNode]]:
    by_parent: dict[uuid.UUID | None, list[OutlineNode]] = {}
    for node in flat:
        by_parent.setdefault(node.parent_id, []).append(node)
    for siblings in by_parent.values():
        siblings.sort(key=lambda n: n.order_index)
    return by_parent


def assign_positions(flat: Sequence[OutlineNode]) -> list[OutlineNode]:
    """Return copies of `flat` with `level`, `section_number` and `cli_key`
    (re)computed from the `parent_id`/`order_index` structure - 1-based,
    dot-joined for `section_number` ("1.2.1"), dash-joined for `cli_key`
    ("1-2-1"), matching the CLI's `structure_graph.json` key scheme.

    Output preserves the input order; inputs are never mutated.
    """
    by_parent = _siblings_by_parent(flat)
    positioned: dict[uuid.UUID, OutlineNode] = {}

    def walk(parent_id: uuid.UUID | None, path: list[int]) -> None:
        for position, node in enumerate(by_parent.get(parent_id, []), start=1):
            node_path = path + [position]
            positioned[node.id] = replace(
                node,
                level=len(node_path),
                section_number=".".join(str(n) for n in node_path),
                cli_key="-".join(str(n) for n in node_path),
            )
            walk(node.id, node_path)

    walk(None, [])
    return [positioned[node.id] for node in flat]


def build_tree(flat: Sequence[OutlineNode]) -> list[OutlineTree]:
    """Nest a flat, positioned node list into root-level `OutlineTree`s."""
    positioned = assign_positions(flat)
    by_parent = _siblings_by_parent(positioned)

    def build(parent_id: uuid.UUID | None) -> list[OutlineTree]:
        return [
            OutlineTree(node=node, children=build(node.id))
            for node in by_parent.get(parent_id, [])
        ]

    return build(None)


def flatten(tree: Sequence[OutlineTree]) -> list[OutlineNode]:
    """Inverse of `build_tree`: pre-order flatten nested `OutlineTree`s back
    into a flat node list (already positioned, since `OutlineTree` nodes are)."""
    result: list[OutlineNode] = []

    def walk(nodes: Sequence[OutlineTree]) -> None:
        for entry in nodes:
            result.append(entry.node)
            walk(entry.children)

    walk(tree)
    return result


def depth_of(node_id: uuid.UUID, flat: Sequence[OutlineNode]) -> int:
    """1-based depth of `node_id` in `flat` (a root node has depth 1)."""
    by_id = {node.id: node for node in flat}
    depth = 0
    current: OutlineNode | None = by_id.get(node_id)
    while current is not None:
        depth += 1
        current = by_id.get(current.parent_id) if current.parent_id is not None else None
    return depth


def subtree_ids(node_id: uuid.UUID, flat: Sequence[OutlineNode]) -> set[uuid.UUID]:
    """`node_id` plus the ids of every descendant, per `flat`'s parent links."""
    children_by_parent: dict[uuid.UUID, list[uuid.UUID]] = {}
    for node in flat:
        if node.parent_id is not None:
            children_by_parent.setdefault(node.parent_id, []).append(node.id)

    result = {node_id}
    stack = [node_id]
    while stack:
        current = stack.pop()
        for child_id in children_by_parent.get(current, []):
            if child_id not in result:
                result.add(child_id)
                stack.append(child_id)
    return result
