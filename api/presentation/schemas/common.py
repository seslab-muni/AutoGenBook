from __future__ import annotations

from typing import Generic, TypeVar

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

T = TypeVar("T")


class BaseSchema(BaseModel):
    """Base for API request/response models: camelCase on the wire, snake_case in Python."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        from_attributes=True,
    )


class PageParams(BaseModel):
    limit: int = Field(default=50, ge=1, le=200)
    offset: int = Field(default=0, ge=0)


class Page(BaseSchema, Generic[T]):
    items: list[T]
    total: int
    limit: int
    offset: int
