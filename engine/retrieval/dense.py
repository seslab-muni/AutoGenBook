"""Dense retrieval: multilingual embeddings, cached, brute-force cosine in NumPy.

Backends:
- `RemoteEmbeddings`: the OpenAI-compatible `/v1/embeddings` endpoint
  (default e-INFRA `qwen3-embedding-4b`; base URL and key default to the LLM
  endpoint's). Model families get their documented query/document prefixes:
  Qwen3/instruct models an instruction on queries only, e5 `query:`/
  `passage:`, nomic `search_query:`/`search_document:`, mxbai a query prompt.
- `LocalEmbeddings`: `multilingual-e5-small` via sentence-transformers (the
  optional `local-embeddings` extra), used when no endpoint serves embeddings.

Vectors are cached per (document content, model) as `.npy` files next to the
extraction cache (or under `out/.kb_cache/` without one).
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
import uuid
from pathlib import Path
from typing import Protocol, Sequence

import numpy as np

QUERY_INSTRUCTION = "Given a question or a section brief, retrieve passages from reference documents that answer or support it"


def prefixes_for(model: str) -> tuple[str, str]:
    """(query prefix, document prefix) for an embedding model id."""
    name = model.lower()
    if "qwen" in name or ("e5" in name and "instruct" in name) or "gte-qwen" in name:
        return f"Instruct: {QUERY_INSTRUCTION}\nQuery: ", ""
    if "e5" in name:
        return "query: ", "passage: "
    if "nomic" in name:
        return "search_query: ", "search_document: "
    if "mxbai" in name:
        return "Represent this sentence for searching relevant passages: ", ""
    return "", ""


def normalize_rows(matrix: np.ndarray) -> np.ndarray:
    matrix = np.asarray(matrix, dtype=np.float32)
    if matrix.ndim == 1:
        matrix = matrix[None, :]
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return matrix / norms


class EmbeddingBackend(Protocol):
    model: str
    parallel: int  # how many embed() calls may be in flight at once

    async def embed(self, texts: Sequence[str], *, kind: str) -> np.ndarray: ...


class RemoteEmbeddings:
    def __init__(self, llm: "object", *, model: str, base_url: str, api_key: str | None, max_chars: int = 8000,
                 limited: bool = True, parallel: int = 1) -> None:
        self.llm = llm
        self.limited = limited
        self.parallel = parallel
        self._gate = asyncio.Semaphore(parallel) if parallel > 1 else None  # shared by concurrent embed() calls
        self.model = model
        self.base_url = base_url
        self.api_key = api_key
        self.max_chars = max_chars
        self.query_prefix, self.doc_prefix = prefixes_for(model)

    async def embed(self, texts: Sequence[str], *, kind: str) -> np.ndarray:
        prefix = self.query_prefix if kind == "query" else self.doc_prefix
        payload = [prefix + t[: self.max_chars] for t in texts]
        vectors = await self.llm.embed(  # type: ignore[attr-defined]
            payload, model=self.model, base_url=self.base_url, api_key=self.api_key,
            label="embed.query" if kind == "query" else "embed.documents",
            limited=self.limited, parallel=self.parallel, gate=self._gate,
        )
        return normalize_rows(np.asarray(vectors, dtype=np.float32))


class LocalEmbeddings:
    """`intfloat/multilingual-e5-small` on CPU (optional dependency)."""

    def __init__(self, model: str = "intfloat/multilingual-e5-small") -> None:
        self.model = model
        self.parallel = 1
        self._st = None
        self.query_prefix, self.doc_prefix = prefixes_for(model)

    @staticmethod
    def available() -> bool:
        import importlib.util

        return importlib.util.find_spec("sentence_transformers") is not None

    def _encoder(self):  # noqa: ANN202
        if self._st is None:
            from sentence_transformers import SentenceTransformer

            self._st = SentenceTransformer(self.model, device="cpu")
        return self._st

    async def embed(self, texts: Sequence[str], *, kind: str) -> np.ndarray:
        prefix = self.query_prefix if kind == "query" else self.doc_prefix
        payload = [prefix + t for t in texts]
        vectors = await asyncio.to_thread(lambda: self._encoder().encode(payload, batch_size=32, normalize_embeddings=True))
        return normalize_rows(np.asarray(vectors, dtype=np.float32))


def _slug(model: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "-", model).strip("-")[:60] or "model"


class VectorCache:
    def __init__(self, cache_dir: Path | None) -> None:
        self.cache_dir = cache_dir

    def path(self, model: str, texts: Sequence[str]) -> Path | None:
        if self.cache_dir is None:
            return None
        digest = hashlib.sha256()
        digest.update(model.encode("utf-8"))
        for text in texts:
            digest.update(b"\x1e")
            digest.update(text.encode("utf-8"))
        return self.cache_dir / f"embed_{_slug(model)}_{digest.hexdigest()[:40]}.npy"

    def load(self, model: str, texts: Sequence[str]) -> np.ndarray | None:
        path = self.path(model, texts)
        if path is None or not path.exists():
            return None
        try:
            matrix = np.load(path, allow_pickle=False)
        except (OSError, ValueError):
            return None
        if matrix.ndim != 2 or matrix.shape[0] != len(texts):
            return None
        return matrix.astype(np.float32)

    def store(self, model: str, texts: Sequence[str], matrix: np.ndarray) -> None:
        path = self.path(model, texts)
        if path is None:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(f"{path.stem}.tmp-{os.getpid()}-{uuid.uuid4().hex}.npy")
            np.save(tmp, matrix.astype(np.float32), allow_pickle=False)
            tmp.replace(path)
        except OSError:
            pass


class DenseIndex:
    def __init__(self, matrix: np.ndarray, backend: EmbeddingBackend) -> None:
        self.matrix = normalize_rows(matrix) if matrix.size else np.zeros((0, 1), dtype=np.float32)
        self.backend = backend

    @property
    def model(self) -> str:
        return self.backend.model

    async def search(self, query: str, *, top: int = 30, mask: np.ndarray | None = None) -> list[tuple[int, float]]:
        if self.matrix.shape[0] == 0:
            return []
        qvec = (await self.backend.embed([query], kind="query"))[0]
        scores = self.matrix @ qvec
        if mask is not None:
            scores = np.where(mask, scores, -np.inf)
        order = np.argsort(-scores, kind="stable")[:top]
        return [(int(i), float(scores[i])) for i in order if np.isfinite(scores[i])]


async def embed_documents(
    backend: EmbeddingBackend, docs: Sequence[Sequence[str]], cache: VectorCache
) -> np.ndarray:
    """Embed every document's chunk texts (document-level cache granularity,
    so an unchanged file is never re-embedded)."""
    parts: list[np.ndarray] = []
    parallel = max(1, int(getattr(backend, "parallel", 1)))
    if parallel == 1:
        for texts in docs:
            if not texts:
                continue
            cached = cache.load(backend.model, texts)
            if cached is None:
                cached = await backend.embed(list(texts), kind="document")
                cache.store(backend.model, texts, cached)
            parts.append(cached)
    else:
        slots: list[np.ndarray | None] = []
        missing: list[tuple[int, Sequence[str]]] = []
        for texts in docs:
            if not texts:
                continue
            cached = cache.load(backend.model, texts)
            if cached is None:
                missing.append((len(slots), texts))
            slots.append(cached)
        failed = False
        first_error: BaseException | None = None

        # No bound here: the backend's shared gate caps every request.
        async def one(index: int, texts: Sequence[str]) -> None:
            nonlocal failed, first_error
            if failed:
                return
            try:
                vectors = await backend.embed(list(texts), kind="document")
            except asyncio.CancelledError:
                raise
            except BaseException as exc:
                failed = True
                first_error = first_error or exc
                raise
            cache.store(backend.model, texts, vectors)
            slots[index] = vectors

        try:
            async with asyncio.TaskGroup() as group:
                for index, texts in missing:
                    group.create_task(one(index, texts))
        except BaseExceptionGroup:
            if first_error is not None:
                raise first_error from None
            raise
        parts = [part for part in slots if part is not None]
    if not parts:
        return np.zeros((0, 1), dtype=np.float32)
    return np.vstack(parts)
