"""Walk a finished run's `out/` directory, classify every file the CLI
produced, and upload it to object storage as a `File` (`kind=artifact`)
indexed by a `RunArtifact` row - issue #10.

Only `work_dir/out/` is walked, never `work_dir` itself: `work_dir/kb/` is a
copy of the run's downloaded sources (not an output) and `work_dir/
book_input.txt` / `book_structure.json` are inputs the API itself wrote, not
something the CLI produced. Within `out/`, `.kb_cache/` (BM25 pickles) and
`*.bak` backups (`autogenbook/graph/doc_graph.py:save_graph_json`) are
skipped - neither is a useful downloadable artifact.

Re-running `upload_artifacts` for the same run is idempotent: it deletes
whatever it previously uploaded for that run first, so a run whose work
directory changed between two calls (there's no such case today, but retry
safety is cheap) never accumulates duplicate rows or orphaned blobs.
"""

from __future__ import annotations

import hashlib
import io
import logging
import mimetypes
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import BinaryIO

from starlette.concurrency import run_in_threadpool

from api.domain.models import ArtifactKind, File, FileKind, RunArtifact
from api.domain.ports import FileRepository, FileStorage, RunArtifactRepository

logger = logging.getLogger(__name__)

_SKIP_DIR_PREFIXES = (".kb_cache",)
_SKIP_SUFFIXES = (".bak",)
_HASH_CHUNK_SIZE = 1024 * 1024

_AUTHOR_LINE_RE = re.compile(r"^\*\*Author:\*\*.*$", re.MULTILINE)


def _classify(relative_path: PurePosixPath) -> ArtifactKind:
    parts = relative_path.parts
    suffix = relative_path.suffix.lower()

    if parts[0] == "sections" and suffix == ".md":
        return ArtifactKind.section
    if parts[0] == "section_reviews" and suffix == ".json":
        return ArtifactKind.section_review
    if parts[0] == "logs":
        return ArtifactKind.log
    if len(parts) == 1:
        if relative_path.name == "structure_graph.json":
            return ArtifactKind.structure_graph
        if relative_path.name == "book_structure.json":
            return ArtifactKind.book_structure
        if relative_path.name == "kb_sources.json":
            return ArtifactKind.kb_sources
        if relative_path.name == "run_meta.json":
            return ArtifactKind.run_meta
        if relative_path.name == "llm_usage.jsonl":
            return ArtifactKind.llm_usage
        if relative_path.name == "audit_report.json":
            return ArtifactKind.audit_report
        if suffix == ".bib":
            return ArtifactKind.bib
        if suffix == ".md":
            return ArtifactKind.markdown
        if suffix == ".tex":
            return ArtifactKind.tex
        if suffix == ".pdf":
            return ArtifactKind.pdf
    return ArtifactKind.other


def _should_skip(relative_path: PurePosixPath) -> bool:
    if relative_path.parts[0] in _SKIP_DIR_PREFIXES:
        return True
    if relative_path.suffix.lower() in _SKIP_SUFFIXES:
        return True
    return False


def collect_artifact_paths(out_dir: Path) -> list[tuple[PurePosixPath, ArtifactKind]]:
    """`(relative_path, kind)` for every artifact file under `out_dir`,
    sorted for deterministic output. Pure filesystem walk - no I/O beyond
    listing, kept separate from `upload_artifacts` so classification can be
    unit tested without a database or storage backend."""
    if not out_dir.is_dir():
        return []
    collected: list[tuple[PurePosixPath, ArtifactKind]] = []
    for path in out_dir.rglob("*"):
        if not path.is_file():
            continue
        relative = PurePosixPath(path.relative_to(out_dir).as_posix())
        if _should_skip(relative):
            continue
        collected.append((relative, _classify(relative)))
    collected.sort(key=lambda item: str(item[0]))
    return collected


def _rewrite_author_line(content: str, authors: list[str]) -> str:
    if not authors or not _AUTHOR_LINE_RE.search(content):
        return content
    return _AUTHOR_LINE_RE.sub(f"**Author:** {', '.join(authors)}", content, count=1)


def _hash_file_sync(path: Path) -> tuple[str, int]:
    """Stream-hash `path` without ever holding the whole file in memory -
    only the current chunk plus the running digest state (issue #55: a
    50 MB PDF used to be `read_bytes()`-ed and `hashlib.sha256(data)`-ed in
    one call, i.e. loaded into memory whole, on this same call's event
    loop, blocking every other worker slot's drain loop for however long
    that took)."""
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(_HASH_CHUNK_SIZE), b""):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def _read_and_rewrite_author_line_sync(path: Path, authors: list[str]) -> bytes:
    # The only artifact whose *content* is modified before upload (the
    # title-cased `<Title>.md`) - it's the book's own top-level Markdown,
    # never large enough to be worth streaming, so reading it whole here
    # (off the event loop) is fine; every other artifact below is streamed
    # straight from disk instead.
    data = path.read_bytes()
    return _rewrite_author_line(data.decode("utf-8", errors="replace"), authors).encode("utf-8")


async def upload_artifacts(
    out_dir: Path,
    run_id: uuid.UUID,
    file_repository: FileRepository,
    run_artifact_repository: RunArtifactRepository,
    storage: FileStorage,
    *,
    authors: list[str] | None = None,
) -> list[RunArtifact]:
    existing, _ = await run_artifact_repository.list(run_id, limit=10_000, offset=0)
    if existing:
        # `run_artifacts.file_id -> files.id` is `ON DELETE RESTRICT`, so the
        # rows that reference a file must go before the file itself - doing
        # this in the opposite order (as before) works on SQLite (which
        # never enforced the FK) but throws `ForeignKeyViolation` on
        # Postgres for every artifact after the first.
        await run_artifact_repository.delete_by_run(run_id)
    for artifact in existing:
        file = await file_repository.get(artifact.file_id)
        if file is not None:
            # DB row first, blob after: if the row delete ever fails, the
            # blob is still there and the row still resolves it, instead of
            # leaving a `files` row whose content already 404s.
            await file_repository.delete(file)
            await storage.delete(file.storage_key)

    created: list[RunArtifact] = []
    for relative_path, kind in collect_artifact_paths(out_dir):
        stream: BinaryIO | None = None
        try:
            absolute_path = out_dir / relative_path
            content_type, _ = mimetypes.guess_type(absolute_path.name)
            content_type = content_type or "application/octet-stream"

            if kind is ArtifactKind.markdown and authors:
                # `errors="replace"` (not strict `utf-8`): a single bad byte
                # in a CLI-generated Markdown file used to raise here, and
                # since this whole loop ran inside one `try` at the call
                # site, that skipped *every remaining* artifact for the run
                # (the title-cased `<Title>.md` sorts before `sections/`) -
                # now isolated to just this one file's `try` below too.
                data = await run_in_threadpool(
                    _read_and_rewrite_author_line_sync, absolute_path, authors
                )
                sha256_hex, size_bytes = hashlib.sha256(data).hexdigest(), len(data)
                stream = io.BytesIO(data)
            else:
                # Hashed by streaming through the file once, off the event
                # loop (issue #55), then uploaded straight from a second
                # handle on the same file via `storage.put`'s own
                # `upload_fileobj` - never buffered whole in memory (as a
                # `BytesIO` built from `read_bytes()` used to, twice over:
                # once as `data`, once again inside the `BytesIO`).
                sha256_hex, size_bytes = await run_in_threadpool(_hash_file_sync, absolute_path)
                stream = await run_in_threadpool(absolute_path.open, "rb")

            file = File(
                id=uuid.uuid4(),
                storage_key=f"runs/{run_id}/{relative_path}",
                filename=absolute_path.name,
                content_type=content_type,
                size_bytes=size_bytes,
                sha256=sha256_hex,
                kind=FileKind.artifact,
                kb_eligible=False,
                created_at=datetime.now(timezone.utc),
            )
            await storage.put(file.storage_key, stream, file.content_type)
            await file_repository.add(file)

            saved = await run_artifact_repository.add(
                RunArtifact(
                    id=uuid.uuid4(),
                    run_id=run_id,
                    file_id=file.id,
                    kind=kind,
                    relative_path=str(relative_path),
                )
            )
            created.append(saved)
        except Exception:
            logger.exception(
                "run %s: failed to upload artifact %s, skipping it", run_id, relative_path
            )
        finally:
            if stream is not None:
                stream.close()
    return created
