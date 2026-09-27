"""Retrieval as the pipelines use it: KB build (+ `kb_sources.json`), lazy
dense index, rerankers with fallbacks, optional web search, context blocks."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from engine.config import RetrievalSettings
from engine.events import EventSink
from engine.retrieval.context import format_context
from engine.retrieval.dense import LocalEmbeddings, RemoteEmbeddings, VectorCache
from engine.retrieval.extract import ExtractOptions
from engine.retrieval.kb import HybridRetriever, KnowledgeBase, build_dense_index
from engine.retrieval.rerank import LLMListwiseReranker, RemoteReranker, Reranker
from engine.retrieval.types import RetrievalItem
from engine.retrieval.web import TavilyRetriever
from engine.util.fs import atomic_write_json


@dataclass
class RetrievedContext:
    items: list[RetrievalItem]
    text: str

    @property
    def kb_items(self) -> list[RetrievalItem]:
        return [i for i in self.items if i.kind == "kb"]


def _duration(seconds: float) -> str:
    return f"{seconds:.1f}s"


class RetrievalService:
    def __init__(self, settings: RetrievalSettings, sink: EventSink, llm_factory, *, out_dir: Path, http_factory) -> None:
        self.settings = settings
        self.sink = sink
        self._llm_factory = llm_factory
        self._http_factory = http_factory
        self.out_dir = out_dir
        self.kb: KnowledgeBase | None = None
        self.retriever: HybridRetriever | None = None
        self.web: TavilyRetriever | None = None
        self._dense_lock = asyncio.Lock()
        self._dense_ready = False

    # ----------------------------------------------------------------- build
    async def build_kb(self) -> KnowledgeBase | None:
        s = self.settings
        if s.kb_dir is None:
            self.sink.emit("kb", "--kb-dir not given; retrieval from a knowledge base is off.")
            return None
        t0 = time.perf_counter()
        self.sink.emit("kb", f"Building/loading the knowledge base from: {s.kb_dir}")
        options = ExtractOptions(ocr=s.ocr, ocr_lang=s.ocr_lang, cache_dir=s.extract_cache_dir, force=s.rebuild_kb)
        kb = await asyncio.to_thread(
            KnowledgeBase.build,
            s.kb_dir,
            cache_dir=self.out_dir / ".kb_cache",
            extract_options=options,
            chunk_tokens=s.chunk_tokens,
            force_rebuild=s.rebuild_kb,
            log=lambda m: self.sink.emit("kb", m),
        )
        for warning in kb.warnings:
            self.sink.emit("kb", warning, level="warning")
        if not kb.chunks:
            self.sink.emit("kb", f"No supported or extractable content in {s.kb_dir}; retrieval will be empty.", level="warning")
        atomic_write_json(self.out_dir / "kb_sources.json", kb.kb_sources_json())
        origin = "index cache" if kb.loaded_from_cache else f"{kb.files} file(s), {kb.extract_cache_hits} from the extraction cache"
        self.sink.emit("kb", f"Done. Chunks: {len(kb.chunks)} ({origin}) in {_duration(time.perf_counter() - t0)}")
        self.kb = kb
        self.retriever = HybridRetriever(
            kb, candidates=s.candidates, item_chars=s.item_chars, rerankers=self._rerankers(),
            warn=lambda m: self.sink.emit("kb", m, level="warning"),
        )
        if s.enable_web:
            self.web = TavilyRetriever(self._http_factory(), s.tavily_api_key, item_chars=s.item_chars)
            if not self.web.available:
                self.sink.emit("kb", "Web RAG enabled but TAVILY_API_KEY is not set; using the knowledge base only.", level="warning")
        return kb

    def enable_web_only(self) -> None:
        s = self.settings
        if s.enable_web and self.web is None:
            self.web = TavilyRetriever(self._http_factory(), s.tavily_api_key, item_chars=s.item_chars)
            if not self.web.available:
                self.sink.emit("kb", "Web RAG enabled but TAVILY_API_KEY is not set.", level="warning")

    def _rerankers(self) -> list[Reranker]:
        s = self.settings
        if s.rerank == "none":
            return []
        llm = self._llm_factory()
        chain: list[Reranker] = []
        if s.rerank == "remote":
            chain.append(RemoteReranker(llm, model=s.rerank_model, base_url=s.rerank_base_url, api_key=s.rerank_api_key))
        chain.append(LLMListwiseReranker(llm))
        return chain

    async def prepare_dense(self) -> None:
        """Embed the KB once (cached per document and model). `auto` tries the
        remote endpoint, then the local model, then gives up with a warning."""
        async with self._dense_lock:
            if self._dense_ready or self.kb is None or not self.kb.chunks or self.retriever is None:
                self._dense_ready = True
                return
            s = self.settings
            cache = VectorCache(s.extract_cache_dir or (self.out_dir / ".kb_cache"))
            attempts: list[str] = {"auto": ["remote", "local"], "remote": ["remote"], "local": ["local"], "none": []}[s.dense]
            for kind in attempts:
                if kind == "local" and not LocalEmbeddings.available():
                    continue
                backend = (
                    RemoteEmbeddings(self._llm_factory(), model=s.embed_model, base_url=s.embed_base_url, api_key=s.embed_api_key)
                    if kind == "remote"
                    else LocalEmbeddings()
                )
                t0 = time.perf_counter()
                try:
                    dense = await build_dense_index(self.kb, backend, cache)
                except Exception as exc:  # noqa: BLE001 - try the next backend
                    self.sink.emit("kb", f"Embeddings via {kind} ({backend.model}) unavailable: {str(exc)[:200]}", level="warning")
                    continue
                self.retriever.dense = dense
                self.sink.emit("kb", f"Dense index ready: {dense.matrix.shape[0]} vectors ({backend.model}) in {_duration(time.perf_counter() - t0)}")
                break
            else:
                if attempts:
                    self.sink.emit("kb", "No embedding backend available; retrieval is BM25 only.", level="warning")
            self._dense_ready = True

    # ---------------------------------------------------------------- search
    async def context(
        self,
        queries: Sequence[str],
        *,
        kb_sources: Sequence[str] | None = None,
        k: int | None = None,
        allow_web: bool = False,
        node_title: str | None = None,
        node_key: str | None = None,
        lexical_only: bool = False,
    ) -> RetrievedContext:
        """`lexical_only` (outline and subdivision overviews): BM25 without
        waiting for the KB's embeddings, so the structure phase runs while
        `kb.embed` is still working."""
        k = k or self.settings.top_k
        items: list[RetrievalItem] = []
        if self.retriever is not None:
            if not self._dense_ready and not lexical_only:
                await self.prepare_dense()
            items = await self.retriever.search(queries, k=k, kb_sources=kb_sources, use_dense=not lexical_only)
            if kb_sources is not None and not items and node_title is not None:
                count = len(kb_sources)
                self.sink.emit(
                    "generate",
                    f"Section '{node_title}': no knowledge-base passages matched in its {count} selected source{'s' if count != 1 else ''}; continuing without KB context.",
                    level="warning", node_key=node_key,
                )
        if allow_web and self.web is not None and self.web.available:
            items += await self.web.search(queries, k=self.settings.web_k)
        text = format_context(items, max_chars_total=self.settings.max_chars_total, item_chars=self.settings.item_chars)
        return RetrievedContext(items, text)
