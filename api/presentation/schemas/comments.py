from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from pydantic import AfterValidator, ConfigDict, Field, model_validator

from api.application.comment_anchors import CONTEXT_LEN
from api.domain.models import CommentKind, CommentStatus
from api.presentation.schemas.common import BaseSchema, _require_non_blank


MAX_BODY_LEN = 20_000
MAX_QUOTE_LEN = 20_000


def _no_nul(value: str) -> str:
    # Postgres text columns reject NUL (a 500 at insert); refuse it up front.
    if "\x00" in value:
        raise ValueError("must not contain NUL characters")
    return value


BodyStr = Annotated[
    str,
    Field(min_length=1, max_length=MAX_BODY_LEN),
    AfterValidator(_require_non_blank),
    AfterValidator(_no_nul),
]


class CommentAnchorIn(BaseSchema):
    """Request anchor: a W3C text-quote selector over the node's
    `contentMarkdown`. `start`/`end` are Unicode code-point offsets (not UTF-16
    units), `end` exclusive; both null = unknown/orphaned. The server
    re-resolves it (`api.application.comment_anchors.resolve_anchor`) and
    refreshes `prefix`/`suffix` from the content."""

    model_config = ConfigDict(extra="forbid")

    quote: Annotated[str, Field(min_length=1, max_length=MAX_QUOTE_LEN), AfterValidator(_no_nul)]
    prefix: Annotated[str, Field(max_length=CONTEXT_LEN), AfterValidator(_no_nul)] = ""
    suffix: Annotated[str, Field(max_length=CONTEXT_LEN), AfterValidator(_no_nul)] = ""
    start: int | None = Field(default=None, ge=0)
    end: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _offsets_consistent(self) -> "CommentAnchorIn":
        if (self.start is None) != (self.end is None):
            raise ValueError("start and end must both be set or both be null")
        if self.start is not None and self.end is not None:
            if self.end <= self.start:
                raise ValueError("end must be greater than start")
            if self.end - self.start != len(self.quote):
                raise ValueError("end - start must equal the quote's length in code points")
        return self


def _lenient_str(value: object) -> str:
    return value if isinstance(value, str) else ""


def _lenient_offset(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


class CommentAnchorOut(BaseSchema):
    """Response anchor. Deliberately unable to fail: stored anchors (e.g. from
    a fuzzy re-anchor, which rewrites `quote` to the text actually matched, or
    the reviewer import) always serialise. None of the request rules apply;
    a missing/wrong-typed `quote`/`prefix`/`suffix` becomes `""` and bad or
    partial `start`/`end` degrade to null (orphaned)."""

    model_config = ConfigDict(extra="ignore")

    quote: str = ""
    prefix: str = ""
    suffix: str = ""
    start: int | None = None
    end: int | None = None

    @model_validator(mode="before")
    @classmethod
    def _sanitise(cls, data: object) -> object:
        if not isinstance(data, dict):
            return {}
        start, end = _lenient_offset(data.get("start")), _lenient_offset(data.get("end"))
        if start is None or end is None or end < start:
            start = end = None
        return {
            "quote": _lenient_str(data.get("quote")),
            "prefix": _lenient_str(data.get("prefix")),
            "suffix": _lenient_str(data.get("suffix")),
            "start": start,
            "end": end,
        }


class Comment(BaseSchema):
    id: uuid.UUID
    project_id: uuid.UUID
    node_id: uuid.UUID
    kind: CommentKind
    author_id: uuid.UUID | None
    author_name: str | None = None
    anchor: CommentAnchorOut | None
    status: CommentStatus
    thread_id: uuid.UUID
    parent_id: uuid.UUID | None
    body_markdown: str
    payload: dict
    created_at: datetime
    updated_at: datetime
    # Set only when the body was edited.
    edited_at: datetime | None = None


class CommentCreate(BaseSchema):
    model_config = ConfigDict(extra="forbid")

    body_markdown: BodyStr
    anchor: CommentAnchorIn | None = None
    parent_id: uuid.UUID | None = None


class CommentUpdate(BaseSchema):
    model_config = ConfigDict(extra="forbid")

    body_markdown: BodyStr


class CommentResolve(BaseSchema):
    model_config = ConfigDict(extra="forbid")

    resolved: bool = True
