"""Pydantic outputs of the agents (their class names are the schema names
sent to the provider)."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, field_validator

_SEVERITY_ALIASES = {
    "critical": "critical", "blocker": "critical", "fatal": "critical",
    "major": "major", "high": "major", "serious": "major", "error": "major",
    "minor": "minor", "low": "minor", "medium": "minor", "moderate": "minor", "warning": "minor",
    "info": "minor", "suggestion": "minor", "nit": "minor",
}


def normalize_severity(value: Any) -> str:
    return _SEVERITY_ALIASES.get(str(value or "").strip().lower(), "minor")


# ------------------------------------------------------------------ structure
class OutlineSection(BaseModel):
    title: str
    summary: str = ""
    n_pages: float = 1.0


class OutlineChapter(BaseModel):
    title: str
    summary: str = ""
    n_pages: float = 1.0
    sections: list[OutlineSection] = Field(default_factory=list)


class BookOutline(BaseModel):
    title: str
    summary: str = ""
    target_readers: str = ""
    additional_requirements: str = ""
    equation_frequency_level: int = 3
    chapters: list[OutlineChapter] = Field(default_factory=list)
    redundancy_notes: list[str] = Field(default_factory=list, description="Overlaps found and removed while planning")


class BookMetadata(BaseModel):
    title: str
    summary: str = ""
    target_readers: str = ""
    additional_requirements: str = ""
    equation_frequency_level: int = 3


class SubsectionPlan(BaseModel):
    title: str
    summary: str = ""
    n_pages: float = 0.5


class SubdivisionPlan(BaseModel):
    sections: list[SubsectionPlan] = Field(default_factory=list)


class GlossaryTerm(BaseModel):
    term: str
    definition: str = ""
    note: str = ""


class NotationEntry(BaseModel):
    symbol: str
    meaning: str = ""


class Glossary(BaseModel):
    terms: list[GlossaryTerm] = Field(default_factory=list)
    notation: list[NotationEntry] = Field(default_factory=list)
    audience: str = ""
    tone: str = ""
    conventions: list[str] = Field(default_factory=list)


# -------------------------------------------------------------------- writing
class SectionDraft(BaseModel):
    body_markdown: str
    summary: str = Field("", description="Two or three sentences on what the section covers")
    key_terms: list[str] = Field(default_factory=list)
    citations_used: list[str] = Field(default_factory=list)


class ReviewIssue(BaseModel):
    type: str = "other"
    severity: str = "minor"
    description: str = ""
    required_fix: str = ""

    @field_validator("severity", mode="before")
    @classmethod
    def _severity(cls, value: Any) -> str:
        return normalize_severity(value)


class SectionReview(BaseModel):
    ok_to_keep: bool = True
    issues: list[ReviewIssue] = Field(default_factory=list)
    suggested_edits: list[str] = Field(default_factory=list)
    retrieval_queries: list[str] = Field(default_factory=list, description="Up to three searches that would find missing evidence")

    @property
    def needs_revision(self) -> bool:
        return (not self.ok_to_keep) or any(i.severity in {"major", "critical"} for i in self.issues)


class SectionRevision(BaseModel):
    body_markdown: str
    summary: str = ""
    changes_made: list[str] = Field(default_factory=list)


class LengthAdjustment(BaseModel):
    body_markdown: str


class ConsistencyFinding(BaseModel):
    type: str = "other"
    severity: str = "minor"
    node_keys: list[str] = Field(default_factory=list)
    description: str = ""
    required_fix: str = ""

    @field_validator("severity", mode="before")
    @classmethod
    def _severity(cls, value: Any) -> str:
        return normalize_severity(value)


class ConsistencyPatch(BaseModel):
    node_key: str
    instructions: str = ""


class ConsistencyReport(BaseModel):
    findings: list[ConsistencyFinding] = Field(default_factory=list)
    patches: list[ConsistencyPatch] = Field(default_factory=list)


# ---------------------------------------------------------------------- paper
class PaperSectionPlan(BaseModel):
    title: str
    role: str = Field("other", description="introduction | related_work | method | results | discussion | conclusion | other")
    summary: str = ""
    n_pages: float = 1.0


class PaperOutline(BaseModel):
    title: str
    abstract_draft: str = ""
    keywords: list[str] = Field(default_factory=list)
    contributions: list[str] = Field(default_factory=list)
    sections: list[PaperSectionPlan] = Field(default_factory=list)


class RelatedWorkEntry(BaseModel):
    cite_key: str
    relation: str = Field("background", description="supports | extends | contrasts | method | data | background")
    summary: str = ""


class RelatedWorkPlan(BaseModel):
    entries: list[RelatedWorkEntry] = Field(default_factory=list)
    positioning_statement: str = ""
    gaps: list[str] = Field(default_factory=list)


class PaperAbstract(BaseModel):
    abstract: str
    keywords: list[str] = Field(default_factory=list)


class BibEntry(BaseModel):
    entry_type: str = Field("misc", description="article | book | inproceedings | report | thesis | online | misc")
    title: str = ""
    authors: list[str] = Field(default_factory=list)
    year: str = ""
    venue: str = ""
    publisher: str = ""
    url: str = ""
    doi: str = ""


# --------------------------------------------------------------- presentation
class SlidePlan(BaseModel):
    title: str
    summary: str = ""
    n_slides: float = Field(1.0, description="Number of slides this entry needs (1 for a single slide)")


class PresentationOutline(BaseModel):
    title: str
    summary: str = ""
    audience: str = ""
    duration_minutes: float = 15.0
    style_guidance: str = ""
    slides: list[SlidePlan] = Field(default_factory=list)


class SlideDraft(BaseModel):
    body_markdown: str = Field(..., description="The slide body in Markdown: bullets, no heading")
    summary: str = Field("", description="One sentence on what the slide says")
    citations_used: list[str] = Field(default_factory=list)


class SlideNarration(BaseModel):
    narration: str = Field(..., description="What the presenter says for this slide")
