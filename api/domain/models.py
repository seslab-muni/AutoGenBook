from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from enum import Enum


class TargetAudience(str, Enum):
    UNDERGRADUATE = "undergraduate"
    GRADUATE = "graduate"
    PHD_RESEARCHER = "phd_researcher"
    INDUSTRY_PRACTITIONER = "industry_practitioner"


class OutputFormat(str, Enum):
    MARKDOWN = "markdown"
    LATEX = "latex"
    PDF = "pdf"


@dataclass
class Project:
    id: uuid.UUID
    owner_id: uuid.UUID | None
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
    additional_requirements: str | None
    last_run_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime


@dataclass
class ProjectSummary:
    id: uuid.UUID
    title: str
    subtitle: str
    authors: list[str]
    topic: str
    target_audience: TargetAudience
    total_pages_budget: int
    sources_count: int
    outline_node_count: int
    last_run_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
