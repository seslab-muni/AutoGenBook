from __future__ import annotations

import uuid
from datetime import datetime, timezone

from api.domain.models import MathLevel, NodeStatus, OutlineNode
from api.domain.outline import assign_positions, build_tree, depth_of, flatten, subtree_ids

_NOW = datetime.now(timezone.utc)


def _node(
    node_id: uuid.UUID,
    parent_id: uuid.UUID | None,
    order_index: int,
    title: str = "Untitled",
) -> OutlineNode:
    return OutlineNode(
        id=node_id,
        project_id=uuid.uuid4(),
        parent_id=parent_id,
        order_index=order_index,
        title=title,
        summary="",
        status=NodeStatus.NOT_STARTED,
        target_pages=1,
        word_budget=350,
        actual_words=0,
        equation_density_level=3,
        math_level=MathLevel.RIGOROUS,
        sub_prompt=None,
        content_markdown="",
        content_latex="",
        rag_citations=[],
        reviewer_score=None,
        reviewer_notes=None,
        structure_locked=True,
        created_at=_NOW,
        updated_at=_NOW,
    )


def _book_outline() -> tuple[dict[str, uuid.UUID], list[OutlineNode]]:
    """Chapter 1 (with two sections), Chapter 2 - the acceptance-criteria shape."""
    ids = {
        "ch1": uuid.uuid4(),
        "ch1_s1": uuid.uuid4(),
        "ch1_s2": uuid.uuid4(),
        "ch2": uuid.uuid4(),
    }
    flat = [
        _node(ids["ch1"], None, 0, "Chapter 1"),
        _node(ids["ch1_s1"], ids["ch1"], 0, "Section 1.1"),
        _node(ids["ch1_s2"], ids["ch1"], 1, "Section 1.2"),
        _node(ids["ch2"], None, 1, "Chapter 2"),
    ]
    return ids, flat


def test_assign_positions_computes_level_section_number_and_cli_key() -> None:
    ids, flat = _book_outline()

    positioned = {n.id: n for n in assign_positions(flat)}

    assert positioned[ids["ch1"]].level == 1
    assert positioned[ids["ch1"]].section_number == "1"
    assert positioned[ids["ch1"]].cli_key == "1"

    assert positioned[ids["ch1_s1"]].level == 2
    assert positioned[ids["ch1_s1"]].section_number == "1.1"
    assert positioned[ids["ch1_s1"]].cli_key == "1-1"

    assert positioned[ids["ch1_s2"]].level == 2
    assert positioned[ids["ch1_s2"]].section_number == "1.2"
    assert positioned[ids["ch1_s2"]].cli_key == "1-2"

    assert positioned[ids["ch2"]].level == 1
    assert positioned[ids["ch2"]].section_number == "2"
    assert positioned[ids["ch2"]].cli_key == "2"


def test_assign_positions_preserves_input_order_and_does_not_mutate() -> None:
    ids, flat = _book_outline()
    original_ids = [n.id for n in flat]

    positioned = assign_positions(flat)

    assert [n.id for n in positioned] == original_ids
    # Inputs untouched (level/section_number default to unset on fresh nodes).
    assert all(n.level == 0 for n in flat)


def test_build_tree_and_flatten_round_trip() -> None:
    ids, flat = _book_outline()

    tree = build_tree(flat)

    assert [entry.node.id for entry in tree] == [ids["ch1"], ids["ch2"]]
    chapter1 = tree[0]
    assert [child.node.id for child in chapter1.children] == [ids["ch1_s1"], ids["ch1_s2"]]
    assert chapter1.node.section_number == "1"
    assert chapter1.children[0].node.section_number == "1.1"
    assert tree[1].children == []

    flattened = flatten(tree)
    assert {n.id for n in flattened} == {n.id for n in flat}
    # flatten is pre-order: chapter, its children, then next chapter.
    assert [n.id for n in flattened] == [
        ids["ch1"],
        ids["ch1_s1"],
        ids["ch1_s2"],
        ids["ch2"],
    ]


def test_depth_of_root_and_nested_nodes() -> None:
    ids, flat = _book_outline()

    assert depth_of(ids["ch1"], flat) == 1
    assert depth_of(ids["ch1_s1"], flat) == 2
    assert depth_of(ids["ch2"], flat) == 1


def test_subtree_ids_includes_self_and_descendants_only() -> None:
    ids, flat = _book_outline()

    assert subtree_ids(ids["ch1"], flat) == {ids["ch1"], ids["ch1_s1"], ids["ch1_s2"]}
    assert subtree_ids(ids["ch1_s1"], flat) == {ids["ch1_s1"]}
    assert subtree_ids(ids["ch2"], flat) == {ids["ch2"]}


def test_subtree_ids_multi_level() -> None:
    root = uuid.uuid4()
    child = uuid.uuid4()
    grandchild = uuid.uuid4()
    other = uuid.uuid4()
    flat = [
        _node(root, None, 0),
        _node(child, root, 0),
        _node(grandchild, child, 0),
        _node(other, None, 1),
    ]

    assert subtree_ids(root, flat) == {root, child, grandchild}
    assert depth_of(grandchild, flat) == 3
