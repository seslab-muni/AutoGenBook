from __future__ import annotations

import uuid
from dataclasses import replace as dataclass_replace
from datetime import datetime, timezone
from typing import Any, Sequence

from api.core.errors import Conflict, NotFound, ValidationFailed
from api.domain.models import MathLevel, NodeStatus, OutlineNode, Project
from api.domain.outline import (
    OutlineTree,
    assign_positions,
    build_tree,
    depth_of,
    subtree_ids,
)
from api.domain.ports import OutlineRepository, ProjectRepository, RunRepository

# Matches the CLI's default page->word ratio used to seed `word_budget`
# (`autogenbook` sizes sections in words but the wizard/UI think in pages).
WORDS_PER_PAGE = 350


def _word_count(markdown: str) -> int:
    return len(markdown.split())


def _subtree_height(node_id: uuid.UUID, flat: Sequence[OutlineNode]) -> int:
    """Number of levels spanned by `node_id`'s subtree (1 for a leaf)."""
    ids = subtree_ids(node_id, flat)
    own_depth = depth_of(node_id, flat)
    return max(depth_of(node_id_, flat) for node_id_ in ids) - own_depth + 1


class OutlineService:
    def __init__(
        self,
        outline_repository: OutlineRepository,
        project_repository: ProjectRepository,
        run_repository: RunRepository,
    ) -> None:
        self._outline_repository = outline_repository
        self._project_repository = project_repository
        self._run_repository = run_repository

    async def _get_project(self, project_id: uuid.UUID) -> Project:
        project = await self._project_repository.get(project_id)
        if project is None:
            raise NotFound(f"project {project_id} does not exist")
        return project

    async def _reject_if_run_active(self, project_id: uuid.UUID) -> None:
        """A `full`/`regenerate_section` run reads the outline once, up
        front, into its work directory (`GenerationService._prepare_work_dir`
        / `_prepare_regenerate`) and matches its own results back onto outline
        rows by *recomputed* `cli_key` once it finishes (`graph_import.py`).
        A structural edit landing in between (insert/delete/move, which
        shifts every sibling's recomputed key) makes that recompute-at-import
        match the wrong rows - see issue #74: a probe reproduced generated
        content and titles landing on the wrong node, silently discarding a
        real section. Block the write instead of racing it."""
        if await self._run_repository.get_active_for_project(project_id) is not None:
            raise Conflict(
                f"project {project_id} has an active run; the outline's structure "
                "can't be changed until it finishes or is cancelled"
            )

    async def _get_node(
        self, project_id: uuid.UUID, node_id: uuid.UUID, flat: Sequence[OutlineNode]
    ) -> OutlineNode:
        for node in flat:
            if node.id == node_id and node.project_id == project_id:
                return node
        raise NotFound(f"outline node {node_id} does not exist")

    async def list(
        self, project_id: uuid.UUID, *, format: str = "flat"
    ) -> tuple[list[OutlineNode] | list[OutlineTree], int]:
        await self._get_project(project_id)
        flat = await self._outline_repository.list(project_id)
        positioned = assign_positions(flat)
        if format == "tree":
            return build_tree(flat), len(positioned)
        return positioned, len(positioned)

    async def get(self, project_id: uuid.UUID, node_id: uuid.UUID) -> OutlineNode:
        await self._get_project(project_id)
        flat = await self._outline_repository.list(project_id)
        node = await self._get_node(project_id, node_id, flat)
        positioned = {n.id: n for n in assign_positions(flat)}
        return positioned[node.id]

    async def create(
        self,
        project_id: uuid.UUID,
        *,
        parent_id: uuid.UUID | None,
        title: str,
        order_index: int | None = None,
        summary: str = "",
        target_pages: float | None = None,
        sub_prompt: str | None = None,
        math_level: MathLevel = MathLevel.RIGOROUS,
        equation_density_level: int | None = None,
    ) -> OutlineNode:
        project = await self._get_project(project_id)
        await self._reject_if_run_active(project_id)
        flat = await self._outline_repository.list(project_id)
        by_id = {n.id: n for n in flat}

        if parent_id is not None:
            parent = by_id.get(parent_id)
            if parent is None or parent.project_id != project_id:
                raise NotFound(f"parent node {parent_id} does not exist")
            depth = depth_of(parent_id, flat) + 1
        else:
            depth = 1
        if depth > project.max_outline_levels:
            raise ValidationFailed(
                f"depth {depth} would exceed project.maxOutlineLevels="
                f"{project.max_outline_levels}"
            )

        siblings = [n for n in flat if n.parent_id == parent_id]
        if order_index is None:
            order_index = max((n.order_index for n in siblings), default=-1) + 1

        resolved_target_pages = target_pages if target_pages is not None else 1
        resolved_equation_density = (
            equation_density_level
            if equation_density_level is not None
            else project.equation_frequency_level
        )

        now = datetime.now(timezone.utc)
        node = OutlineNode(
            id=uuid.uuid4(),
            project_id=project_id,
            parent_id=parent_id,
            order_index=order_index,
            title=title,
            summary=summary,
            status=NodeStatus.NOT_STARTED,
            target_pages=resolved_target_pages,
            word_budget=int(WORDS_PER_PAGE * resolved_target_pages),
            actual_words=0,
            equation_density_level=resolved_equation_density,
            math_level=math_level,
            sub_prompt=sub_prompt,
            content_markdown="",
            content_latex="",
            rag_citations=[],
            reviewer_score=None,
            reviewer_notes=None,
            structure_locked=True,
            created_at=now,
            updated_at=now,
        )
        created = await self._outline_repository.add(node)
        positioned = {n.id: n for n in assign_positions(flat + [created])}
        return positioned[created.id]

    async def update(
        self, project_id: uuid.UUID, node_id: uuid.UUID, changes: dict[str, Any]
    ) -> OutlineNode:
        project = await self._get_project(project_id)
        flat = await self._outline_repository.list(project_id)
        node = await self._get_node(project_id, node_id, flat)

        changes = dict(changes)
        if "content_markdown" in changes:
            changes["actual_words"] = _word_count(changes["content_markdown"] or "")

        old_parent_id = node.parent_id
        parent_changed = "parent_id" in changes and changes["parent_id"] != old_parent_id
        new_parent_id = changes.pop("parent_id", old_parent_id)
        requested_order_index = changes.pop("order_index", None)
        touches_position = parent_changed or requested_order_index is not None

        if touches_position:
            await self._reject_if_run_active(project_id)

        if parent_changed:
            if new_parent_id is not None:
                new_parent = next(
                    (n for n in flat if n.id == new_parent_id and n.project_id == project_id),
                    None,
                )
                if new_parent is None:
                    raise NotFound(f"parent node {new_parent_id} does not exist")
                if new_parent_id in subtree_ids(node_id, flat):
                    raise ValidationFailed("cannot move a node into its own subtree")
            target_depth = (depth_of(new_parent_id, flat) if new_parent_id else 0) + 1
            height = _subtree_height(node_id, flat)
            if target_depth + height - 1 > project.max_outline_levels:
                raise ValidationFailed(
                    f"moving node {node_id} would exceed project.maxOutlineLevels="
                    f"{project.max_outline_levels}"
                )

        updated = dataclass_replace(
            node, **changes, updated_at=datetime.now(timezone.utc)
        )
        await self._outline_repository.update(updated)

        if touches_position:
            if parent_changed:
                old_siblings = [
                    n.id for n in flat if n.parent_id == old_parent_id and n.id != node_id
                ]
                if old_siblings:
                    await self._outline_repository.reorder(
                        project_id, old_parent_id, old_siblings
                    )
            new_siblings = [
                n.id for n in flat if n.parent_id == new_parent_id and n.id != node_id
            ]
            if requested_order_index is None:
                new_order = new_siblings + [node_id]
            else:
                index = max(0, min(requested_order_index, len(new_siblings)))
                new_order = new_siblings[:index] + [node_id] + new_siblings[index:]
            await self._outline_repository.reorder(project_id, new_parent_id, new_order)

        refreshed = await self._outline_repository.list(project_id)
        positioned = {n.id: n for n in assign_positions(refreshed)}
        return positioned[node_id]

    async def delete(self, project_id: uuid.UUID, node_id: uuid.UUID) -> None:
        """Soft-delete `node_id` and its whole subtree - `OutlineRepository.
        delete_subtree` sets `deleted_at` rather than issuing a SQL `DELETE`,
        so the rows still exist afterwards. The descendant set is recomputed
        by the repository itself at delete time (not from this `flat`
        snapshot) so a child inserted after this read still gets swept up -
        see `SqlAlchemyOutlineRepository.delete_subtree` (issue #75)."""
        await self._get_project(project_id)
        await self._reject_if_run_active(project_id)
        flat = await self._outline_repository.list(project_id)
        await self._get_node(project_id, node_id, flat)
        await self._outline_repository.delete_subtree(project_id, node_id)

    async def replace(
        self, project_id: uuid.UUID, tree: list[dict[str, Any]]
    ) -> list[OutlineNode]:
        project = await self._get_project(project_id)
        await self._reject_if_run_active(project_id)
        now = datetime.now(timezone.utc)
        flat_nodes: list[OutlineNode] = []

        def walk(
            entries: list[dict[str, Any]], parent_id: uuid.UUID | None, depth: int
        ) -> None:
            if entries and depth > project.max_outline_levels:
                raise ValidationFailed(
                    f"outline depth {depth} would exceed project.maxOutlineLevels="
                    f"{project.max_outline_levels}"
                )
            for index, entry in enumerate(entries):
                target_pages = entry.get("target_pages")
                if target_pages is None:
                    target_pages = 1
                equation_density = entry.get("equation_density_level")
                if equation_density is None:
                    equation_density = project.equation_frequency_level
                node = OutlineNode(
                    id=uuid.uuid4(),
                    project_id=project_id,
                    parent_id=parent_id,
                    order_index=index,
                    title=entry["title"],
                    summary=entry.get("summary") or "",
                    status=NodeStatus.NOT_STARTED,
                    target_pages=target_pages,
                    word_budget=int(WORDS_PER_PAGE * target_pages),
                    actual_words=0,
                    equation_density_level=equation_density,
                    math_level=entry.get("math_level") or MathLevel.RIGOROUS,
                    sub_prompt=entry.get("sub_prompt"),
                    content_markdown="",
                    content_latex="",
                    rag_citations=[],
                    reviewer_score=None,
                    reviewer_notes=None,
                    structure_locked=True,
                    created_at=now,
                    updated_at=now,
                )
                flat_nodes.append(node)
                walk(entry.get("children") or [], node.id, depth + 1)

        walk(tree, None, 1)
        saved = await self._outline_repository.replace_all(project_id, flat_nodes)
        return assign_positions(saved)

    async def duplicate_from(
        self, source_project_id: uuid.UUID, target_project_id: uuid.UUID
    ) -> list[OutlineNode]:
        """Deep-copy every outline node of `source_project_id` onto
        `target_project_id` with freshly minted ids, preserving structure -
        used by `ProjectService.duplicate` (issue #4)."""
        flat = await self._outline_repository.list(source_project_id)
        if not flat:
            return []

        id_map: dict[uuid.UUID, uuid.UUID] = {}
        now = datetime.now(timezone.utc)
        copies: list[OutlineNode] = []
        for node in sorted(flat, key=lambda n: depth_of(n.id, flat)):
            new_id = uuid.uuid4()
            id_map[node.id] = new_id
            copies.append(
                dataclass_replace(
                    node,
                    id=new_id,
                    project_id=target_project_id,
                    parent_id=id_map.get(node.parent_id) if node.parent_id else None,
                    cli_key=None,
                    created_at=now,
                    updated_at=now,
                )
            )
        return await self._outline_repository.replace_all(target_project_id, copies)

    async def count(self, project_id: uuid.UUID) -> int:
        return await self._outline_repository.count(project_id)
