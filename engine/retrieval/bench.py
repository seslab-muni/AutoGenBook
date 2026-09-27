"""Retriever factory for `scripts/bench_retrieval.py` (not used by pipelines)."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Sequence

from engine.config import DEFAULT_EMBED_MODEL, DEFAULT_RERANK_MODEL, LLMSettings, RetrievalSettings
from engine.events import MemorySink
from engine.llm.client import LLMClient
from engine.llm.usage import UsageLedger
from engine.retrieval.dense import LocalEmbeddings, RemoteEmbeddings, VectorCache
from engine.retrieval.extract import ExtractOptions
from engine.retrieval.kb import HybridRetriever, KnowledgeBase, build_dense_index
from engine.retrieval.rerank import LLMListwiseReranker, RemoteReranker
from engine.retrieval.types import RetrievalItem


class BenchRetriever:
    def __init__(self, retriever: HybridRetriever, llm: LLMClient) -> None:
        self.retriever = retriever
        self.llm = llm

    async def search(self, queries: Sequence[str], *, k: int) -> list[RetrievalItem]:
        return await self.retriever.search(queries, k=k, diversify_sources=False)

    async def aclose(self) -> None:
        await self.llm.aclose()


async def build_bench_retriever(
    kb_dir: Path, work_dir: Path, *, mode: str, embed_model: str | None = None, transport: Any = None
) -> BenchRetriever:
    env = os.environ
    base_url = env.get("AUTOGENBOOK_LLM_BASE_URL") or env.get("OPENROUTER_BASE_URL") or "https://openrouter.ai/api/v1"
    api_key = env.get("OPENROUTER_API_KEY") or env.get("AUTOGENBOOK_LLM_API_KEY") or None
    model = env.get("AUTOGENBOOK_LLM_MODEL") or "openai/gpt-5-mini"
    settings = LLMSettings(base_url=base_url, api_key=api_key, model=model, mini_model=env.get("AUTOGENBOOK_LLM_MINI_MODEL") or model)
    llm = LLMClient(settings, ledger=UsageLedger(work_dir / "llm_usage.jsonl"), sink=MemorySink(), concurrency=4, transport=transport)
    lexical_mode = "plain" if mode == "bm25-plain" else "lemma"
    kb = KnowledgeBase.build(
        kb_dir, cache_dir=work_dir / "kb_cache", extract_options=ExtractOptions(cache_dir=work_dir / "extract_cache"),
        chunk_tokens=int(env.get("AUTOGENBOOK_CHUNK_TOKENS") or 400), lexical_mode=lexical_mode, force_rebuild=True,
    )
    dense = None
    if mode in {"dense", "hybrid", "hybrid-rerank", "hybrid-llmrerank"}:
        name = embed_model or env.get("AUTOGENBOOK_EMBED_MODEL") or DEFAULT_EMBED_MODEL
        backend = (
            LocalEmbeddings()
            if name == "local"
            else RemoteEmbeddings(
                llm, model=name, base_url=env.get("AUTOGENBOOK_EMBED_BASE_URL") or base_url,
                api_key=env.get("AUTOGENBOOK_EMBED_API_KEY") or api_key,
            )
        )
        dense = await build_dense_index(kb, backend, VectorCache(work_dir / "vectors"))
    rerankers: list[Any] = []
    if mode == "hybrid-rerank":
        rerankers = [
            RemoteReranker(
                llm, model=env.get("AUTOGENBOOK_RERANK_MODEL") or DEFAULT_RERANK_MODEL,
                base_url=env.get("AUTOGENBOOK_RERANK_BASE_URL") or base_url,
                api_key=env.get("AUTOGENBOOK_RERANK_API_KEY") or api_key,
            )
        ]
    elif mode == "hybrid-llmrerank":
        rerankers = [LLMListwiseReranker(llm)]
    # strict: a row labelled hybrid-rerank/-llmrerank really measured the reranker
    # (an unavailable or failing reranker is an error, not a silent fused order).
    retriever = HybridRetriever(
        kb, dense=dense, rerankers=rerankers, use_lexical=mode != "dense", candidates=RetrievalSettings().candidates,
        strict_rerank=bool(rerankers),
    )
    return BenchRetriever(retriever, llm)
