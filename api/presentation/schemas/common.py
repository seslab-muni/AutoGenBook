from __future__ import annotations

from typing import Annotated, Generic, TypeVar

from pydantic import AfterValidator, BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

T = TypeVar("T")


class BaseSchema(BaseModel):
    """Base for API request/response models: camelCase on the wire, snake_case in Python."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        from_attributes=True,
    )


def _require_non_blank(value: str) -> str:
    if not value.strip():
        raise ValueError("must not be empty or blank")
    return value


# A required-in-spirit string field (`title`, `topic`, an author's name, ...)
# that must carry actual content - `min_length=1` alone still lets `" "`
# through, so a whitespace-only value is additionally rejected by the
# `AfterValidator` (issue #61: `title=""`/`authors=[""]` used to be accepted
# silently instead of a 422).
NonBlankStr = Annotated[str, Field(min_length=1), AfterValidator(_require_non_blank)]


class PageParams(BaseModel):
    limit: int = Field(default=50, ge=1, le=200)
    offset: int = Field(default=0, ge=0)


class Page(BaseSchema, Generic[T]):
    items: list[T]
    total: int
    limit: int
    offset: int
