from __future__ import annotations

from pydantic import BaseModel, Field

# Deliberately plain `BaseModel` subclasses, not `BaseSchema`: this mirrors
# the CLI's own `book_structure.json` shape verbatim
# (`api.application.book_spec.StructureBuilder.build`), snake_case keys and
# all - it's the CLI's `--use-json` input contract, not one of this API's own
# camelCase response bodies. Used only to document `GET /projects/{id}/spec`
# `?format=json`'s response in OpenAPI (issue #53); the route itself still
# builds and returns the dict directly via `StructureBuilder.build`.


class BookStructureNode(BaseModel):
    title: str
    summary: str
    n_pages: float
    needsSubdivision: bool
    childs: list["BookStructureNode"] = Field(default_factory=list)
    structure_locked: bool | None = None


class BookStructure(BaseModel):
    title: str
    summary: str
    n_pages: float
    target_readers: str
    equation_frequency_level: int
    do_consider_outline: bool
    do_consider_previous_sections: bool
    additional_requirements: str
    max_depth: int
    max_output_pages: float
    childs: list[BookStructureNode] = Field(default_factory=list)
