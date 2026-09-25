from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Sequence

from rag_kb import KnowledgeBase, make_source_filter

from .mcp_papers import MCPPaperRetriever
from .tavily import TavilyRetriever
from .kb_citations import kb_cite_key
from .types import RetrievalItem
from .sanitize import sanitize_context_text


@dataclass
class RetrievalManager:
    local_kb: Optional[KnowledgeBase] = None
    mcp_papers: Optional[MCPPaperRetriever] = None
    tavily: Optional[TavilyRetriever] = None
    enable_web: bool = False
    allow_tavily_fallback: bool = True
    default_k: int = 6
    max_chars_total: int = 6000
    # The `--kb-dir` the local KB was built from; `kb_sources` passed to
    # `retrieve` are resolved relative to it.
    kb_root: Optional[Path] = None

    @staticmethod
    def _source_key(item: RetrievalItem) -> str:
        if item.kind == "kb" and item.rid:
            parts = item.rid.split(":")
            if len(parts) >= 5 and parts[0] == "RID" and parts[1] == "kb":
                return f"kb:{parts[2]}"
        if item.source:
            return f"{item.kind}:{item.source}"
        return f"{item.kind}:{item.cite_key or item.rid}"

    @staticmethod
    def _diversify_by_source(items: Iterable[RetrievalItem], k: int) -> List[RetrievalItem]:
        items_list = list(items)
        if k <= 0 or not items_list:
            return []
        selected: List[RetrievalItem] = []
        seen = set()
        for item in items_list:
            key = RetrievalManager._source_key(item)
            if key in seen:
                continue
            selected.append(item)
            seen.add(key)
            if len(selected) >= k:
                return selected
        if len(selected) >= k:
            return selected[:k]
        for item in items_list:
            if item in selected:
                continue
            selected.append(item)
            if len(selected) >= k:
                break
        return selected

    def retrieve(
        self,
        query: str,
        k: Optional[int] = None,
        max_chars_total: Optional[int] = None,
        diversify_sources: bool = False,
        diversify_multiplier: int = 3,
        allow_web: Optional[bool] = None,
        kb_sources: Optional[Sequence[str]] = None,
    ) -> List[RetrievalItem]:
        """`kb_sources`: `None` searches the whole local KB; a sequence restricts
        it to those files/directories (relative to `kb_root`) - an empty one
        means no local KB results at all. Web retrieval is never restricted."""
        k = k or self.default_k
        items: List[RetrievalItem] = []
        use_web = self.enable_web if allow_web is None else (self.enable_web and bool(allow_web))

        source_filter = None
        if kb_sources is not None and self.local_kb is not None:
            if self.kb_root is None:
                raise ValueError("RetrievalManager.kb_root is required to restrict kb_sources")
            source_filter = make_source_filter(self.kb_root, kb_sources)

        if self.local_kb is not None:
            fetch_k = max(k, 1)
            if diversify_sources:
                fetch_k = max(k * max(diversify_multiplier, 1), k + 2)
            raw_items: List[RetrievalItem] = []
            for chunk, score in self.local_kb.retrieve(query, k=fetch_k, source_filter=source_filter):
                cite_key = chunk.cite_key or kb_cite_key(chunk.source_path, chunk.loc)
                raw_items.append(
                    RetrievalItem(
                        rid=chunk.rid,
                        kind="kb",
                        source=Path(chunk.source_path).name,
                        loc=chunk.loc,
                        score=score,
                        cite_key=cite_key,
                        text=chunk.text,
                        url=None,
                        title=Path(chunk.source_path).name,
                    )
                )
            if diversify_sources:
                items.extend(self._diversify_by_source(raw_items, k))
            else:
                items.extend(raw_items[:k])

        if use_web:
            mcp_items: List[RetrievalItem] = []
            if self.mcp_papers is not None and self.mcp_papers.is_available():
                mcp_items = self.mcp_papers.retrieve(query, k=k)
                items.extend(mcp_items)
            if not mcp_items and self.allow_tavily_fallback and self.tavily is not None:
                items.extend(self.tavily.retrieve(query, k=k))

        return items

    def format_context(self, items: List[RetrievalItem], max_chars_total: Optional[int] = None) -> str:
        remaining = max_chars_total if max_chars_total is not None else self.max_chars_total
        blocks: List[str] = []
        for idx, item in enumerate(items, start=1):
            excerpt = sanitize_context_text(item.text.strip())
            excerpt = excerpt[: min(len(excerpt), 1500)]
            header = (
                f"[{item.rid}] kind={item.kind} source=\"{item.source}\" "
                f"loc=\"{item.loc}\" score={item.score:.2f} cite_key=\"{item.cite_key}\""
            )
            if item.url:
                header += f" url=\"{item.url}\""
            if item.title:
                header += f" title=\"{item.title}\""
            block = f"{header}\n{excerpt}"
            if len(block) + 2 > remaining:
                break
            blocks.append(block)
            remaining -= len(block) + 2
        return "\n\n".join(blocks)

