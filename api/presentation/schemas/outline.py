from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import ConfigDict, Field

from api.domain.models import MathLevel, NodeStatus
from api.presentation.schemas.common import BaseSchema


class OutlineNode(BaseSchema):
    """Flat shape - one row, addressed by `parentId` + `orderIndex`.

    `level`, `sectionNumber` and `cliKey` are always derived from the current
    tree shape (`api.domain.outline.assign_positions`) - never persisted
    client-supplied values.
    """

    id: uuid.UUID
    parent_id: uuid.UUID | None
    order_index: int
    cli_key: str | None = None
    title: str
    summary: str
    level: int
    section_number: str
    status: NodeStatus
    target_pages: float
    word_budget: int
    actual_words: int
    equation_density_level: int = Field(ge=1, le=5)
    math_level: MathLevel
    sub_prompt: str | None = None
    content_markdown: str
    content_latex: str
    rag_citations: list[dict] = Field(default_factory=list)
    reviewer_score: float | None = None
    reviewer_notes: str | None = None
    structure_locked: bool
    created_at: datetime
    updated_at: datetime


class OutlineNodeTree(OutlineNode):
    """`OutlineNode` with nested `children` instead of `parentId`/`orderIndex`."""

    children: list["OutlineNodeTree"] = Field(default_factory=list)


class OutlineNodeCreate(BaseSchema):
    model_config = ConfigDict(extra="forbid")

    parent_id: uuid.UUID | None = None
    title: str
    order_index: int | None = None
    summary: str = ""
    target_pages: float | None = None
    sub_prompt: str | None = None
    math_level: MathLevel = MathLevel.RIGOROUS
    equation_density_level: int | None = Field(default=None, ge=1, le=5)


class OutlineNodeUpdate(BaseSchema):
    """Partial update of mutable fields. `level`, `sectionNumber`, `cliKey`
    and `actualWords` are server-derived - sending any of them (or any other
    unknown key) is rejected with 422."""

    model_config = ConfigDict(extra="forbid")

    parent_id: uuid.UUID | None = None
    order_index: int | None = None
    title: str | None = None
    summary: str | None = None
    status: NodeStatus | None = None
    target_pages: float | None = None
    word_budget: int | None = None
    equation_density_level: int | None = Field(default=None, ge=1, le=5)
    math_level: MathLevel | None = None
    sub_prompt: str | None = None
    content_markdown: str | None = None
    content_latex: str | None = None
    reviewer_score: float | None = None
    reviewer_notes: str | None = None


class OutlineTreeReplaceNode(BaseSchema):
    """One node of a full outline replacement, nested, without ids (ids are
    assigned on write)."""

    model_config = ConfigDict(extra="forbid")

    title: str
    summary: str = ""
    target_pages: float | None = None
    sub_prompt: str | None = None
    math_level: MathLevel = MathLevel.RIGOROUS
    equation_density_level: int | None = Field(default=None, ge=1, le=5)
    children: list["OutlineTreeReplaceNode"] = Field(default_factory=list)


OutlineTreeReplace = list[OutlineTreeReplaceNode]
