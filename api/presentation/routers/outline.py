from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, Response, status

from api.application.outline import OutlineService
from api.domain.models import OutlineNode as OutlineNodeDomain
from api.domain.outline import OutlineTree
from api.presentation.deps import get_outline_service
from api.presentation.schemas.common import Page
from api.presentation.schemas.outline import (
    OutlineNode,
    OutlineNodeCreate,
    OutlineNodeTree,
    OutlineNodeUpdate,
    OutlineTreeReplaceNode,
)

router = APIRouter(prefix="/projects/{project_id}/outline", tags=["outline"])

# Outline trees are read/edited as a whole by the UI (unlike files/projects,
# there's no natural "page" of a document's own outline); default the window
# large enough that a realistic book/paper outline never gets truncated
# while still bounding worst-case payload size.
_DEFAULT_LIST_LIMIT = 1000


def to_schema(node: OutlineNodeDomain) -> OutlineNode:
    return OutlineNode(
        id=node.id,
        parent_id=node.parent_id,
        order_index=node.order_index,
        cli_key=node.cli_key,
        title=node.title,
        summary=node.summary,
        level=node.level,
        section_number=node.section_number,
        status=node.status,
        target_pages=node.target_pages,
        word_budget=node.word_budget,
        actual_words=node.actual_words,
        equation_density_level=node.equation_density_level,
        math_level=node.math_level,
        sub_prompt=node.sub_prompt,
        content_markdown=node.content_markdown,
        content_latex=node.content_latex,
        rag_citations=node.rag_citations,
        reviewer_score=node.reviewer_score,
        reviewer_notes=node.reviewer_notes,
        structure_locked=node.structure_locked,
        created_at=node.created_at,
        updated_at=node.updated_at,
    )


def tree_to_schema(tree: OutlineTree) -> OutlineNodeTree:
    base = to_schema(tree.node)
    return OutlineNodeTree(
        **base.model_dump(),
        children=[tree_to_schema(child) for child in tree.children],
    )


@router.get("", response_model=None)
async def list_outline_nodes(
    project_id: uuid.UUID,
    format: str = Query(default="flat", pattern="^(flat|tree)$"),
    limit: int = Query(default=_DEFAULT_LIST_LIMIT, ge=1, le=5000),
    offset: int = Query(default=0, ge=0),
    service: OutlineService = Depends(get_outline_service),
) -> Page[OutlineNode] | Page[OutlineNodeTree]:
    items, total = await service.list(project_id, format=format)
    windowed = items[offset : offset + limit]
    if format == "tree":
        tree_items = [tree_to_schema(entry) for entry in windowed]
        return Page[OutlineNodeTree](items=tree_items, total=total, limit=limit, offset=offset)
    flat_items = [to_schema(entry) for entry in windowed]
    return Page[OutlineNode](items=flat_items, total=total, limit=limit, offset=offset)


@router.put("", response_model=Page[OutlineNode])
async def replace_outline(
    project_id: uuid.UUID,
    body: list[OutlineTreeReplaceNode],
    service: OutlineService = Depends(get_outline_service),
) -> Page[OutlineNode]:
    tree = [entry.model_dump() for entry in body]
    nodes = await service.replace(project_id, tree)
    items = [to_schema(node) for node in nodes]
    return Page[OutlineNode](items=items, total=len(items), limit=len(items), offset=0)


@router.post("", response_model=OutlineNode, status_code=status.HTTP_201_CREATED)
async def create_outline_node(
    project_id: uuid.UUID,
    body: OutlineNodeCreate,
    service: OutlineService = Depends(get_outline_service),
) -> OutlineNode:
    node = await service.create(
        project_id,
        parent_id=body.parent_id,
        title=body.title,
        order_index=body.order_index,
        summary=body.summary,
        target_pages=body.target_pages,
        sub_prompt=body.sub_prompt,
        math_level=body.math_level,
        equation_density_level=body.equation_density_level,
    )
    return to_schema(node)


@router.get("/{node_id}", response_model=OutlineNode)
async def get_outline_node(
    project_id: uuid.UUID,
    node_id: uuid.UUID,
    service: OutlineService = Depends(get_outline_service),
) -> OutlineNode:
    node = await service.get(project_id, node_id)
    return to_schema(node)


@router.patch("/{node_id}", response_model=OutlineNode)
async def update_outline_node(
    project_id: uuid.UUID,
    node_id: uuid.UUID,
    body: OutlineNodeUpdate,
    service: OutlineService = Depends(get_outline_service),
) -> OutlineNode:
    changes = body.model_dump(exclude_unset=True)
    node = await service.update(project_id, node_id, changes)
    return to_schema(node)


@router.delete("/{node_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_outline_node(
    project_id: uuid.UUID,
    node_id: uuid.UUID,
    service: OutlineService = Depends(get_outline_service),
) -> Response:
    await service.delete(project_id, node_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
