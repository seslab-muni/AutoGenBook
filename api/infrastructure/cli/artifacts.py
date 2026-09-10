"""Walk a run's `out/` directory, classify every file the CLI produced, and
upload it to object storage as a `File` (`kind=artifact`) indexed by a
`RunArtifact` row - issue #10.

Only `work_dir/out/` is walked, never `work_dir` itself: `work_dir/kb/` is a
copy of the run's downloaded sources (not an output) and `work_dir/
book_input.txt` / `book_structure.json` are inputs the API itself wrote, not
something the CLI produced. Within `out/`, `.kb_cache/` (BM25 pickles) and
`*.bak` backups (`autogenbook/graph/doc_graph.py:save_graph_json`) are
skipped - neither is a useful downloadable artifact.

`upload_artifacts` is idempotent by *content*, not just by run (issue #129):
re-running it for the same run diffs the current `out/` directory against
what's already recorded (by relative path, sha256 + size) - a file that's
unchanged since the last call is left alone (its `File`/`RunArtifact` rows
and object-store blob untouched), a changed file replaces its old row/blob,
and a file no longer present on disk has its row/blob removed. This is what
lets `GenerationService` call it once at the very end of *every* run
(`_finalize`/`_fail`) after already having incrementally uploaded most
sections via `upload_section_artifacts` as the CLI produced them - the
terminal call only pays for what actually changed since the last section
event, instead of re-uploading (and generating a fresh downloadable link
for) the whole run's output every time.

`upload_section_artifacts` is the incremental counterpart (issue #129):
called from `GenerationService`'s drain loop the moment a `"section"` run
event arrives (`subprocess_runner._watch_structure_graph`'s per-node
`content_file_path` watch), it uploads just that one leaf's `sections/
<node_key>.md` and, if present, `section_reviews/<node_key>.json` - so the
run's artifact list already shows a finished section while the run is still
generating the next one, rather than only once the whole run reaches a
terminal state. It shares `upload_artifacts`'s same skip-if-unchanged logic,
so re-uploading the same section content (e.g. from a `--resume` run that
re-announces it) is a no-op.
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


async def _load_existing_by_path(
    run_id: uuid.UUID,
    run_artifact_repository: RunArtifactRepository,
    file_repository: FileRepository,
) -> dict[str, tuple[RunArtifact, File]]:
    """Every `RunArtifact` already recorded for `run_id`, keyed by its
    `relative_path`, paired with the `File` row it points at - the basis
    both `upload_artifacts` and `upload_section_artifacts` diff the current
    `out/` directory against to decide what's unchanged, changed, or new. A
    `RunArtifact` whose `file_id` no longer resolves (shouldn't happen -
    `_delete_artifact` below always removes both together - but cheap to
    guard) is simply omitted, so it's treated as "not existing" and
    re-uploaded fresh."""
    existing, _ = await run_artifact_repository.list(run_id, limit=10_000, offset=0)
    if not existing:
        return {}
    files_by_id = await file_repository.get_many([artifact.file_id for artifact in existing])
    return {
        artifact.relative_path: (artifact, files_by_id[artifact.file_id])
        for artifact in existing
        if artifact.file_id in files_by_id
    }


async def _delete_artifact(
    artifact: RunArtifact,
    file: File,
    file_repository: FileRepository,
    run_artifact_repository: RunArtifactRepository,
    storage: FileStorage,
) -> None:
    # `run_artifacts.file_id -> files.id` is `ON DELETE RESTRICT`, so the row
    # that references a file must go before the file itself - then the DB
    # row before the blob, so a row delete that fails never leaves a `files`
    # row whose content already 404s.
    await run_artifact_repository.delete_many([artifact.id])
    await file_repository.delete(file)
    await storage.delete(file.storage_key)


async def _upsert_artifact(
    out_dir: Path,
    relative_path: PurePosixPath,
    kind: ArtifactKind,
    run_id: uuid.UUID,
    existing_by_path: dict[str, tuple[RunArtifact, File]],
    file_repository: FileRepository,
    run_artifact_repository: RunArtifactRepository,
    storage: FileStorage,
    authors: list[str] | None,
) -> RunArtifact | None:
    """Upload `relative_path` if it's new or its content changed since the
    last call; return the (possibly pre-existing, unchanged) `RunArtifact`
    row for it, or `None` if uploading it failed (logged, never raised - one
    bad file must never abort every other artifact in the same batch)."""
    stream: BinaryIO | None = None
    try:
        absolute_path = out_dir / relative_path
        content_type, _ = mimetypes.guess_type(absolute_path.name)
        content_type = content_type or "application/octet-stream"

        data: bytes | None = None
        if kind is ArtifactKind.markdown and authors:
            # `errors="replace"` (not strict `utf-8`): a single bad byte in a
            # CLI-generated Markdown file used to raise here, and since this
            # whole loop ran inside one `try` at the call site, that used to
            # skip *every remaining* artifact for the run - now isolated to
            # just this one file's `try`.
            data = await run_in_threadpool(
                _read_and_rewrite_author_line_sync, absolute_path, authors
            )
            sha256_hex, size_bytes = hashlib.sha256(data).hexdigest(), len(data)
        else:
            # Hashed by streaming through the file once, off the event loop
            # (issue #55), then (if it needs uploading) streamed straight
            # from a second handle on the same file via `storage.put` -
            # never buffered whole in memory.
            sha256_hex, size_bytes = await run_in_threadpool(_hash_file_sync, absolute_path)

        existing = existing_by_path.get(str(relative_path))
        if existing is not None:
            existing_artifact, existing_file = existing
            if existing_file.sha256 == sha256_hex and existing_file.size_bytes == size_bytes:
                # Unchanged since the last upload (by content, not just by
                # name) - issue #129: nothing to re-upload, no new File row,
                # no new downloadable link. This is what makes a resumed
                # run's terminal `upload_artifacts` call cheap once most
                # sections were already uploaded incrementally as the CLI
                # produced them.
                return existing_artifact
            # Content changed - replace the stale row/blob before uploading
            # the new one below (same storage_key, so a new File row can't
            # coexist with the old one under the column's unique constraint).
            await _delete_artifact(
                existing_artifact, existing_file, file_repository, run_artifact_repository, storage
            )

        stream = io.BytesIO(data) if data is not None else await run_in_threadpool(
            absolute_path.open, "rb"
        )
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

        return await run_artifact_repository.add(
            RunArtifact(
                id=uuid.uuid4(),
                run_id=run_id,
                file_id=file.id,
                kind=kind,
                relative_path=str(relative_path),
            )
        )
    except Exception:
        logger.exception("run %s: failed to upload artifact %s, skipping it", run_id, relative_path)
        return None
    finally:
        if stream is not None:
            stream.close()


async def upload_artifacts(
    out_dir: Path,
    run_id: uuid.UUID,
    file_repository: FileRepository,
    run_artifact_repository: RunArtifactRepository,
    storage: FileStorage,
    *,
    authors: list[str] | None = None,
) -> list[RunArtifact]:
    if not out_dir.is_dir():
        return []

    existing_by_path = await _load_existing_by_path(run_id, run_artifact_repository, file_repository)
    collected = collect_artifact_paths(out_dir)
    collected_paths = {str(relative_path) for relative_path, _kind in collected}

    # Remove whatever was previously uploaded for this run but no longer
    # exists on disk (e.g. a `regenerate_section` rollback, or an artifact
    # the CLI simply stopped producing) - the one case `_upsert_artifact`'s
    # per-path diff can't catch on its own, since it never sees a path that
    # isn't in `collected`.
    for relative_path, (artifact, file) in existing_by_path.items():
        if relative_path not in collected_paths:
            await _delete_artifact(artifact, file, file_repository, run_artifact_repository, storage)

    result: list[RunArtifact] = []
    for relative_path, kind in collected:
        artifact = await _upsert_artifact(
            out_dir,
            relative_path,
            kind,
            run_id,
            existing_by_path,
            file_repository,
            run_artifact_repository,
            storage,
            authors,
        )
        if artifact is not None:
            result.append(artifact)
    return result


def _section_candidate_paths(node_key: str) -> list[tuple[PurePosixPath, ArtifactKind]]:
    return [
        (PurePosixPath("sections") / f"{node_key}.md", ArtifactKind.section),
        (PurePosixPath("section_reviews") / f"{node_key}.json", ArtifactKind.section_review),
    ]


async def upload_section_artifacts(
    out_dir: Path,
    run_id: uuid.UUID,
    node_key: str,
    file_repository: FileRepository,
    run_artifact_repository: RunArtifactRepository,
    storage: FileStorage,
) -> list[RunArtifact]:
    """Incrementally upload one leaf section's own artifacts - `sections/
    <node_key>.md` and, if the CLI has written one, `section_reviews/
    <node_key>.json` - the moment it's finished, rather than waiting for the
    whole run to reach a terminal state (issue #129). Authors are never
    rewritten here: that only ever applies to the run's single top-level
    `<Title>.md`, uploaded later by the terminal `upload_artifacts` call, not
    to per-section Markdown. Shares `upload_artifacts`'s skip-if-unchanged
    behavior, so calling this again for a section whose content hasn't
    changed (e.g. a `--resume` run re-announcing an already-uploaded
    section) is a no-op.
    """
    if not out_dir.is_dir():
        return []
    candidates = [
        (relative_path, kind)
        for relative_path, kind in _section_candidate_paths(node_key)
        if (out_dir / relative_path).is_file()
    ]
    if not candidates:
        return []

    existing_by_path = await _load_existing_by_path(run_id, run_artifact_repository, file_repository)
    result: list[RunArtifact] = []
    for relative_path, kind in candidates:
        artifact = await _upsert_artifact(
            out_dir,
            relative_path,
            kind,
            run_id,
            existing_by_path,
            file_repository,
            run_artifact_repository,
            storage,
            authors=None,
        )
        if artifact is not None:
            result.append(artifact)
    return result
