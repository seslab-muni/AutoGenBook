"""The local knowledge base and the hybrid retriever over it.

`KnowledgeBase.build` (CPU-bound; the pipeline runs it in a thread):
extraction (parallel, cached) -> chunking -> lemmatised BM25 index, persisted
per KB fingerprint (relative paths + sizes + mtimes + settings) under
`out/.kb_cache/`. Dense vectors are computed separately and lazily
(`HybridRetriever.prepare_dense`), so building a KB never needs the network.

`HybridRetriever.search(queries, k, kb_sources)`: per query BM25 top-30 and
dense top-30 (both restricted to the node's scope before the cut), fused by
reciprocal rank fusion; several queries are fused the same way; the fused
top candidates are reranked, diversified one-per-source first, cut to `k`,
and turned into items with small-to-big excerpts.
"""

from __future__ import annotations

import asyncio

import hashlib
import json
import pickle
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Sequence

import numpy as np

from engine.retrieval.chunking import chunk_document
from engine.retrieval.context import expand_excerpt
from engine.retrieval.dense import DenseIndex, EmbeddingBackend, VectorCache, embed_documents
from engine.retrieval.extract import EXTRACTOR_VERSION, ExtractOptions, Extractor, extract_all, list_kb_files
from engine.retrieval.fusion import diversify, rrf
from engine.retrieval.ids import page_key
from engine.retrieval.lexical import LexicalIndex, detect_lang
from engine.retrieval.rerank import Reranker, RerankUnavailable
from engine.retrieval.scope import make_source_filter
from engine.retrieval.types import Chunk, RetrievalItem
from engine.util.fs import atomic_write_bytes, atomic_write_text

INDEX_VERSION = 2  # 2: acronym and surface-form guards in lemma_tokens


def _excerpt(raw: str, max_words: int = 12, max_chars: int = 120) -> str:
    cleaned = re.sub(r"\s+", " ", (raw or "").strip())
    if not cleaned:
        return ""
    excerpt = " ".join(cleaned.split()[:max_words])
    return excerpt[:max_chars].rstrip()


@dataclass
class KnowledgeBase:
    root: Path
    chunks: list[Chunk]
    lexical: LexicalIndex | None
    fingerprint: str
    files: int = 0
    warnings: list[str] = field(default_factory=list)
    extract_cache_hits: int = 0
    loaded_from_cache: bool = False
    lexical_mode: str = "lemma"

    # ----------------------------------------------------------------- build
    @staticmethod
    def fingerprint_of(kb_dir: Path, files: list[Path], tag: str) -> str:
        digest = hashlib.sha256()
        for path in files:
            stat = path.stat()
            digest.update(path.relative_to(kb_dir).as_posix().encode("utf-8", errors="ignore"))
            digest.update(str(stat.st_size).encode())
            digest.update(str(stat.st_mtime_ns).encode())
        digest.update(tag.encode("utf-8"))
        return digest.hexdigest()

    @classmethod
    def build(
        cls,
        kb_dir: Path,
        *,
        cache_dir: Path | None,
        extract_options: ExtractOptions,
        chunk_tokens: int = 400,
        lexical_mode: str = "lemma",
        force_rebuild: bool = False,
        log: Callable[[str], None] = lambda _m: None,
        max_workers: int = 8,
    ) -> "KnowledgeBase":
        kb_dir = kb_dir.expanduser().resolve()
        if not kb_dir.is_dir():
            raise FileNotFoundError(f"KB directory does not exist: {kb_dir}")
        files = list_kb_files(kb_dir)
        tag = (
            f"index={INDEX_VERSION}:{EXTRACTOR_VERSION}:tokens={chunk_tokens}:lex={lexical_mode}:"
            f"ocr={int(extract_options.ocr)}:lang={extract_options.ocr_lang}"
        )
        fingerprint = cls.fingerprint_of(kb_dir, files, tag)
        meta_path = data_path = None
        if cache_dir is not None:
            key = hashlib.sha256(str(kb_dir).encode("utf-8")).hexdigest()[:16]
            meta_path = cache_dir / f"engine_kb_{key}.meta.json"
            data_path = cache_dir / f"engine_kb_{key}.pkl"
            if not force_rebuild and meta_path.exists() and data_path.exists():
                try:
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                    if meta.get("fingerprint") == fingerprint:
                        with data_path.open("rb") as handle:
                            kb = pickle.load(handle)
                        if isinstance(kb, cls) and kb.fingerprint == fingerprint:
                            kb.loaded_from_cache = True
                            kb.root = kb_dir
                            return kb
                except Exception:  # noqa: BLE001 - a broken cache is a rebuild, never a failure
                    log("index cache unreadable; rebuilding")

        extractor = Extractor(extract_options)
        warnings: list[str] = []

        def on_error(path: Path, exc: Exception) -> None:
            warnings.append(f"could not read {path.name} ({exc}); skipped")

        docs = extract_all(files, kb_dir, extractor, max_workers=max_workers, on_error=on_error)
        chunks: list[Chunk] = []
        for index, doc in enumerate(docs):
            sample = " ".join(b.text for b in doc.blocks[:40])
            doc.lang = detect_lang(sample)
            doc_chunks = chunk_document(doc, index, kb_dir, budget=chunk_tokens)
            if not doc_chunks:
                hint = " (a scanned PDF without a text layer? set AUTOGENBOOK_KB_OCR=1)" if doc.path.lower().endswith(".pdf") else ""
                warnings.append(f"{Path(doc.path).name} contained no extractable text{hint}")
            chunks.extend(doc_chunks)
            warnings.extend(f"{Path(doc.path).name}: {w}" for w in doc.warnings)
        lexical = LexicalIndex([c.index_text for c in chunks], [c.lang for c in chunks], mode=lexical_mode) if chunks else None
        kb = cls(
            root=kb_dir, chunks=chunks, lexical=lexical, fingerprint=fingerprint, files=len(files),
            warnings=warnings, extract_cache_hits=extractor.cache_hits, lexical_mode=lexical_mode,
        )
        if cache_dir is not None and meta_path is not None and data_path is not None:
            try:
                cache_dir.mkdir(parents=True, exist_ok=True)
                atomic_write_bytes(data_path, pickle.dumps(kb, protocol=pickle.HIGHEST_PROTOCOL))
                atomic_write_text(meta_path, json.dumps({"dir": str(kb_dir), "fingerprint": fingerprint}, indent=2))
            except (OSError, pickle.PicklingError):
                pass
        return kb

    # -------------------------------------------------------------- outputs
    def kb_sources_json(self) -> dict[str, Any]:
        """`kb_sources.json` (contract 3.4), same shape as the old engine's
        `build_kb_index` plus each chunk's heading path."""
        cite_keys: dict[str, dict[str, str]] = {}
        rids: dict[str, dict[str, str]] = {}
        page_keys: dict[str, list[dict[str, Any]]] = {}
        chunks: list[dict[str, Any]] = []
        for chunk in self.chunks:
            excerpt = _excerpt(chunk.text)
            entry = {
                "source_path": chunk.source_path,
                "loc": chunk.loc,
                "rid": chunk.rid,
                "cite_key": chunk.cite_key,
                "excerpt": excerpt,
                "heading_path": chunk.heading_path,
            }
            chunks.append(entry)
            summary = {"source_path": chunk.source_path, "loc": chunk.loc, "excerpt": excerpt}
            cite_keys[chunk.cite_key] = summary
            rids[chunk.rid] = summary
            page_keys.setdefault(page_key(chunk.source_path, chunk.loc), []).append(
                {k: entry[k] for k in ("source_path", "loc", "rid", "cite_key", "excerpt")}
            )
        return {"cite_keys": cite_keys, "rids": rids, "page_keys": page_keys, "chunks": chunks}

    def mask_for(self, kb_sources: Sequence[str] | None) -> np.ndarray | None:
        if kb_sources is None:
            return None
        accept = make_source_filter(self.root, kb_sources)
        return np.array([accept(c.rel_path) for c in self.chunks], dtype=bool)


class HybridRetriever:
    name = "hybrid"

    def __init__(
        self,
        kb: KnowledgeBase,
        *,
        dense: DenseIndex | None = None,
        rerankers: Sequence[Reranker] = (),
        candidates: int = 30,
        item_chars: int = 1500,
        use_lexical: bool = True,
        warn: Callable[[str], None] = lambda _m: None,
        strict_rerank: bool = False,
    ) -> None:
        """`strict_rerank` (benchmarks): a reranker error is raised instead of
        falling back, so a reranked row never silently reports fused order."""
        self.kb = kb
        self.strict_rerank = strict_rerank
        self.dense = dense
        self.rerankers = list(rerankers)
        self.candidates = candidates
        self.item_chars = item_chars
        self.use_lexical = use_lexical
        self.warn = warn
        self._masks: dict[tuple[str, ...], np.ndarray] = {}

    def _mask(self, kb_sources: Sequence[str] | None) -> np.ndarray | None:
        if kb_sources is None:
            return None
        key = tuple(sorted(kb_sources))
        if key not in self._masks:
            mask = self.kb.mask_for(list(key))
            self._masks[key] = mask if mask is not None else np.ones(len(self.kb.chunks), dtype=bool)
        return self._masks[key]

    async def _ranked(self, query: str, mask: np.ndarray | None, *, use_dense: bool = True) -> list[int]:
        rankings: list[list[int]] = []
        if self.use_lexical and self.kb.lexical is not None:
            lang = detect_lang(query)
            rankings.append([i for i, _s in self.kb.lexical.search(query, lang=lang, top=self.candidates, mask=mask)])
        if self.dense is not None and use_dense:
            try:
                rankings.append([i for i, _s in await self.dense.search(query, top=self.candidates, mask=mask)])
            except Exception as exc:  # noqa: BLE001 - dense is an enhancement; lexical still answers
                self.warn(f"dense retrieval failed ({exc}); continuing with BM25 only")
                self.dense = None
        if len(rankings) == 1:
            return rankings[0]
        return [i for i, _score in rrf(rankings)]

    async def search(
        self, queries: Sequence[str], *, k: int = 6, kb_sources: Sequence[str] | None = None, diversify_sources: bool = True,
        use_dense: bool = True,
    ) -> list[RetrievalItem]:
        queries = [q for q in (q.strip() for q in queries) if q]
        if not self.kb.chunks or not queries or k <= 0:
            return []
        mask = self._mask(kb_sources)
        if mask is not None and not mask.any():
            return []
        per_query = [await self._ranked(q, mask, use_dense=use_dense) for q in queries]
        fused = per_query[0] if len(per_query) == 1 else [i for i, _s in rrf(per_query)]
        fused = fused[: self.candidates]
        if not fused:
            return []
        scores: list[float] = [1.0 / (60 + r) for r in range(1, len(fused) + 1)]
        for reranker in self.rerankers:
            try:
                scores = await reranker.rerank(queries[0], [self.kb.chunks[i].index_text[:2000] for i in fused])
                order = sorted(range(len(fused)), key=lambda j: -scores[j])
                fused = [fused[j] for j in order]
                scores = [scores[j] for j in order]
                break
            except asyncio.CancelledError:
                raise
            except RerankUnavailable as exc:
                if self.strict_rerank:
                    raise
                self.warn(f"reranker '{reranker.name}' unavailable ({exc}); trying the next fallback")
                continue
            except Exception as exc:  # noqa: BLE001 - reranking failures keep the fused order
                if self.strict_rerank:
                    raise
                self.warn(f"reranking failed ({exc}); using the fused order for this query")
                break
        ranked = list(zip(fused, scores))
        if diversify_sources:
            ranked = diversify(ranked, lambda pair: self.kb.chunks[pair[0]].source_id, k)
        else:
            ranked = ranked[:k]
        return [self._item(i, score, queries[0]) for i, score in ranked]

    def _item(self, index: int, score: float, query: str) -> RetrievalItem:
        chunk = self.kb.chunks[index]
        return RetrievalItem(
            rid=chunk.rid,
            kind="kb",
            source=Path(chunk.source_path).name,
            loc=chunk.loc,
            score=float(score),
            cite_key=chunk.cite_key,
            text=expand_excerpt(self.kb.chunks, index, query, self.item_chars),
            title=Path(chunk.source_path).name,
            chunk_id=index,
            source_path=chunk.source_path,
        )

    async def aclose(self) -> None:
        return None


async def build_dense_index(kb: KnowledgeBase, backend: EmbeddingBackend, cache: VectorCache) -> DenseIndex:
    per_doc: dict[int, list[str]] = {}
    for chunk in kb.chunks:
        per_doc.setdefault(chunk.doc, []).append(chunk.index_text)
    matrix = await embed_documents(backend, [per_doc[d] for d in sorted(per_doc)], cache)
    return DenseIndex(matrix, backend)
