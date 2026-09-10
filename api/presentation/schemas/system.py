from __future__ import annotations

from api.application.system import ModelListResult
from api.presentation.schemas.common import BaseSchema


class ModelInfo(BaseSchema):
    id: str
    name: str | None = None


class ModelList(BaseSchema):
    """`GET /api/v1/system/models`'s response. `warning` is set (and `items` empty) when the
    configured LLM endpoint's model list couldn't be fetched - degrades gracefully instead of a
    5xx (issue #128), so callers should still render a picker (falling back to free text) rather
    than treat this as a hard error."""

    items: list[ModelInfo]
    warning: str | None = None


def model_list_to_schema(result: ModelListResult) -> ModelList:
    return ModelList(
        items=[ModelInfo(id=model.id, name=model.name) for model in result.items],
        warning=result.warning,
    )
