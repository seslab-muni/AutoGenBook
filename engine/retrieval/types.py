"""Retrieval data types and the `Retriever` protocol."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, Sequence


@dataclass
class Block:
    """One structural unit of an extracted document."""

    kind: str  # heading | paragraph | table | code | list
    text: str
    level: int = 0  # heading level (1 = top)
    page: int | None = None
    slide: int | None = None

    def to_json(self) -> dict:
        return {"kind": self.kind, "text": self.text, "level": self.level, "page": self.page, "slide": self.slide}

    @classmethod
    def from_json(cls, data: dict) -> "Block":
        return cls(
            kind=str(data["kind"]), text=str(data["text"]), level=int(data.get("level") or 0),
            page=data.get("page"), slide=data.get("slide"),
        )


@dataclass
class ExtractedDoc:
    path: str
    rel_path: str
    blocks: list[Block]
    lang: str = "en"
    warnings: list[str] = field(default_factory=list)


@dataclass
class Chunk:
    source_path: str  # absolute path, like the old KB (kb_sources.json relies on its parent dir)
    rel_path: str
    source_id: str
    loc: str
    rid: str
    cite_key: str
    text: str
    heading_path: list[str]
    page: int | None
    slide: int | None
    section: int  # index of the enclosing section within its document
    position: int  # order within its document
    doc: int  # index of the document within the KB
    lang: str = "en"
    kind: str = "text"  # text | table | code | slide

    @property
    def index_text(self) -> str:
        path = " › ".join(p for p in self.heading_path if p)
        return f"{path}\n{self.text}" if path else self.text


@dataclass
class RetrievalItem:
    rid: str
    kind: str  # kb | web
    source: str
    loc: str
    score: float
    cite_key: str
    text: str  # the excerpt handed to agents
    url: str | None = None
    title: str | None = None
    chunk_id: int | None = None  # index into KnowledgeBase.chunks
    source_path: str = ""
    authors: list[str] = field(default_factory=list)
    year: str | None = None
    doi: str | None = None
    verified: bool | None = None

    def excerpt(self, limit: int) -> str:
        return self.text[:limit]


class Retriever(Protocol):
    name: str

    async def search(
        self, queries: Sequence[str], *, k: int, kb_sources: Sequence[str] | None = None
    ) -> list[RetrievalItem]: ...

    async def aclose(self) -> None: ...
