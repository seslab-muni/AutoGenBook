from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import ConfigDict, Field

from api.domain.models import OutputFormat, TargetAudience
from api.presentation.schemas.common import BaseSchema
from api.presentation.schemas.outline import OutlineNodeTree, OutlineTreeReplace
from api.presentation.schemas.sources import Source, SourceCreate


class ProjectCreate(BaseSchema):
    title: str
    subtitle: str
    authors: list[str]
    topic: str
    target_audience: TargetAudience = TargetAudience.GRADUATE
    total_pages_budget: int = Field(default=350, ge=5, le=2000)
    equation_frequency_level: int = Field(default=4, ge=1, le=5)
    do_consider_outline: bool = True
    do_consider_previous_sections: bool = True
    output_format: OutputFormat = OutputFormat.MARKDOWN
    max_outline_levels: int = Field(default=3, ge=1, le=5)
    additional_requirements: str | None = None
    # Wizard step 2: attach already-uploaded files as sources atomically with
    # project creation (issue #5). Has its own endpoints for later changes.
    sources: list[SourceCreate] | None = None
    # Wizard-only: author the outline atomically with the project (issue #6).
    # Popped off by the router before `ProjectService.create` sees the rest
    # of the payload - `ProjectService` itself only knows project metadata.
    outline: OutlineTreeReplace | None = None


class ProjectUpdate(BaseSchema):
    # `sources`/`outline` have their own endpoints (issues #5/#6); reject
    # them (and any other unknown key) with 422 instead of silently ignoring.
    model_config = ConfigDict(extra="forbid")

    title: str | None = None
    subtitle: str | None = None
    authors: list[str] | None = None
    topic: str | None = None
    target_audience: TargetAudience | None = None
    total_pages_budget: int | None = Field(default=None, ge=5, le=2000)
    equation_frequency_level: int | None = Field(default=None, ge=1, le=5)
    do_consider_outline: bool | None = None
    do_consider_previous_sections: bool | None = None
    output_format: OutputFormat | None = None
    max_outline_levels: int | None = Field(default=None, ge=1, le=5)
    additional_requirements: str | None = None


class Project(BaseSchema):
    id: uuid.UUID
    title: str
    subtitle: str
    authors: list[str]
    topic: str
    target_audience: TargetAudience
    total_pages_budget: int
    equation_frequency_level: int
    do_consider_outline: bool
    do_consider_previous_sections: bool
    output_format: OutputFormat
    max_outline_levels: int
    additional_requirements: str | None = None
    sources: list[Source] = Field(default_factory=list)
    outline: list[OutlineNodeTree] = Field(default_factory=list)
    last_run_id: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime


class ProjectSummary(BaseSchema):
    id: uuid.UUID
    title: str
    subtitle: str
    authors: list[str]
    topic: str
    target_audience: TargetAudience
    total_pages_budget: int
    sources_count: int
    outline_node_count: int
    last_run_id: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime
