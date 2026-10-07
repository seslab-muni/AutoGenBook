from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import ConfigDict, Field, model_validator

from api.application.comment_anchors import CONTEXT_LEN
from api.domain.models import CommentKind, CommentStatus
from api.presentation.schemas.common import BaseSchema, NonBlankStr


class CommentAnchor(BaseSchema):
    """W3C text-quote selector over a section's `contentMarkdown`. `start`/`end`
    are Unicode code-point offsets (not UTF-16 units), `end` exclusive; both
    null = orphaned. The server re-resolves a created anchor (see
    `api.application.comment_anchors.resolve_anchor`) and refreshes
    `prefix`/`suffix` from the content."""

    model_config = ConfigDict(extra="forbid")

    quote: str = Field(min_length=1)
    prefix: str = Field(default="", max_length=CONTEXT_LEN)
    suffix: str = Field(default="", max_length=CONTEXT_LEN)
    start: int | None = Field(default=None, ge=0)
    end: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _offsets_consistent(self) -> "CommentAnchor":
        if (self.start is None) != (self.end is None):
            raise ValueError("start and end must both be set or both be null")
        if self.start is not None and self.end is not None:
            if self.end <= self.start:
                raise ValueError("end must be greater than start")
            if self.end - self.start != len(self.quote):
                raise ValueError("end - start must equal the quote's length in code points")
        return self


class Comment(BaseSchema):
    id: uuid.UUID
    project_id: uuid.UUID
    node_id: uuid.UUID
    kind: CommentKind
    author_id: uuid.UUID | None
    author_name: str | None = None
    anchor: CommentAnchor | None
    status: CommentStatus
    thread_id: uuid.UUID
    parent_id: uuid.UUID | None
    body_markdown: str
    payload: dict
    created_at: datetime
    updated_at: datetime


class CommentCreate(BaseSchema):
    model_config = ConfigDict(extra="forbid")

    body_markdown: NonBlankStr
    anchor: CommentAnchor | None = None
    parent_id: uuid.UUID | None = None


class CommentUpdate(BaseSchema):
    model_config = ConfigDict(extra="forbid")

    body_markdown: NonBlankStr


class CommentResolve(BaseSchema):
    model_config = ConfigDict(extra="forbid")

    resolved: bool = True
