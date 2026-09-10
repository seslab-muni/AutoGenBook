from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Sequence
from typing import Any, BinaryIO, Protocol

from datetime import datetime

from api.domain.models import (
    ArtifactKind,
    File,
    FileKind,
    LlmModelInfo,
    OutlineNode,
    Project,
    Run,
    RunArtifact,
    RunEvent,
    RunStatus,
    Source,
    User,
)


class ProjectRepository(Protocol):
    async def get(self, project_id: uuid.UUID) -> Project | None: ...

    async def list_with_counts(
        self, limit: int, offset: int
    ) -> tuple[list[tuple[Project, int, int]], int]: ...

    async def add(self, project: Project) -> Project: ...

    async def update(
        self, project: Project, *, fields: Sequence[str] | None = None
    ) -> Project: ...

    async def delete(self, project_id: uuid.UUID) -> None: ...


class UserRepository(Protocol):
    async def get_by_email(self, email: str) -> User | None: ...

    async def get_by_id(self, user_id: uuid.UUID) -> User | None: ...

    async def add(self, user: User) -> User: ...

    async def update_password(self, user_id: uuid.UUID, password_hash: str) -> User: ...

    async def set_active(self, user_id: uuid.UUID, is_active: bool) -> User: ...

    async def list(self) -> list[User]: ...


class FileStorage(Protocol):
    async def put(
        self,
        key: str,
        stream: BinaryIO,
        content_type: str,
        size_hint: int | None = None,
    ) -> None: ...

    async def open(self, key: str) -> AsyncIterator[bytes]: ...

    async def delete(self, key: str) -> None: ...

    async def exists(self, key: str) -> bool: ...

    async def healthcheck(self) -> None: ...


class FileRepository(Protocol):
    async def add(self, file: File) -> None: ...

    async def get(self, file_id: uuid.UUID) -> File | None: ...

    async def get_many(self, file_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, File]: ...

    async def list(
        self, limit: int, offset: int, *, kind: FileKind | None = None
    ) -> tuple[Sequence[File], int]: ...

    async def delete(self, file: File) -> None: ...

    async def is_referenced(self, file_id: uuid.UUID) -> bool: ...


class SourceRepository(Protocol):
    async def add(self, source: Source) -> Source: ...

    async def get(self, project_id: uuid.UUID, source_id: uuid.UUID) -> Source | None: ...

    async def get_by_project_and_file(
        self, project_id: uuid.UUID, file_id: uuid.UUID
    ) -> Source | None: ...

    async def list(
        self, project_id: uuid.UUID, limit: int, offset: int
    ) -> tuple[list[Source], int]: ...

    async def list_all(self, project_id: uuid.UUID) -> list[Source]: ...

    async def update(self, source: Source) -> Source: ...
    # No hard `delete`: `DELETE /projects/{id}/sources/{sourceId}` is a soft
    # delete (`deleted_at` set via `update`), so a removed row stays around
    # for audit purposes and to keep the file's `is_referenced` check honest
    # about what's still attached. Project deletion still hard-deletes every
    # row (soft-deleted or not) via the ORM cascade on `ProjectRecord`.


class OutlineRepository(Protocol):
    async def list(self, project_id: uuid.UUID) -> list[OutlineNode]: ...

    async def get(self, node_id: uuid.UUID) -> OutlineNode | None: ...

    async def add(self, node: OutlineNode) -> OutlineNode: ...

    async def update(
        self, node: OutlineNode, *, fields: Sequence[str] | None = None
    ) -> OutlineNode: ...

    async def delete_subtree(self, project_id: uuid.UUID, root_id: uuid.UUID) -> None: ...

    async def replace_all(
        self, project_id: uuid.UUID, nodes: Sequence[OutlineNode]
    ) -> list[OutlineNode]: ...

    async def reorder(
        self,
        project_id: uuid.UUID,
        parent_id: uuid.UUID | None,
        ordered_ids: Sequence[uuid.UUID],
    ) -> None: ...

    async def count(self, project_id: uuid.UUID) -> int: ...


class RunRepository(Protocol):
    async def get(self, run_id: uuid.UUID) -> Run | None: ...

    async def get_active_for_project(self, project_id: uuid.UUID) -> Run | None: ...

    # Issue #134: every queued-or-running run for `project_id`, oldest
    # first - the project's whole "lane". Unlike `get_active_for_project`
    # (still used by the outline structural-edit guard and project delete,
    # whose semantics are unchanged), this can return more than one run
    # once a project may hold several `queued` runs at once; it backs both
    # `queue_admission_blocker` (the caller passes its own about-to-create
    # run's `kind` plus this list) and `RunService.queue_position`.
    async def list_active_for_project(self, project_id: uuid.UUID) -> list[Run]: ...

    async def list(
        self,
        project_id: uuid.UUID,
        limit: int,
        offset: int,
        *,
        statuses: Sequence[RunStatus] | None = None,
    ) -> tuple[list[Run], int]: ...

    # 1-based position of `run` among its project's other `queued` runs,
    # ordered by `queued_at` - `None` for a run that isn't `queued` (a
    # `running` run has no "position", it's already executing; a terminal
    # run never had one to report).
    async def queue_position(self, run: Run) -> int | None: ...

    async def add(self, run: Run) -> Run: ...

    async def update(self, run: Run) -> Run: ...

    async def finalize(
        self, run: Run, *, expected_locked_by: str | None = None
    ) -> Run | None: ...

    async def request_cancel(self, run_id: uuid.UUID) -> Run | None: ...

    async def list_stale_work_dirs(self, cutoff: datetime) -> list[str]: ...

    async def list_all_work_dirs(self) -> list[str]: ...

    async def list_by_work_dir(self, work_dir: str) -> list[Run]: ...

    async def rollback(self) -> None: ...


class RunEventRepository(Protocol):
    async def append_batch(self, run_id: uuid.UUID, events: Sequence[RunEvent]) -> None: ...

    async def list(
        self, run_id: uuid.UUID, after_seq: int, limit: int
    ) -> tuple[list[RunEvent], int]: ...

    async def list_after(
        self, run_id: uuid.UUID, after_seq: int, limit: int
    ) -> list[RunEvent]: ...

    async def max_seq(self, run_id: uuid.UUID) -> int: ...


class RunArtifactRepository(Protocol):
    async def add(self, artifact: RunArtifact) -> RunArtifact: ...

    async def list(
        self, run_id: uuid.UUID, limit: int, offset: int, kind: ArtifactKind | None = None
    ) -> tuple[list[RunArtifact], int]:
        """`kind` (issue #129 review, fix 6) restricts the page to just that
        `ArtifactKind` - `GET /runs/{id}/artifacts?kind=...` uses this so a
        big book's `section_reviews/*` rows don't crowd `sections/*.md` out
        of the default 200-row page (the repository orders by
        `relative_path`, and `section_reviews` sorts before `sections`)."""
        ...

    async def count_by_kind(self, run_id: uuid.UUID) -> dict[ArtifactKind, int]:
        """Every `ArtifactKind` this run has at least one artifact for, with
        its count - backs `GET /runs/{id}/artifacts/summary`'s `countsByKind`
        so the frontend's "N of M sections generated" counter and per-kind
        paging don't need to fetch every artifact just to count them."""
        ...

    async def delete_by_run(self, run_id: uuid.UUID) -> None: ...

    async def delete_many(self, artifact_ids: Sequence[uuid.UUID]) -> None:
        """Delete specific `RunArtifact` rows by id - the incremental-upload path
        (issue #129) uses this to replace just the one artifact whose content
        changed, rather than `delete_by_run`'s "delete everything for this
        run" (which would also throw away every other already-uploaded,
        still-unchanged section)."""
        ...

    async def get_many_by_paths(
        self, run_id: uuid.UUID, relative_paths: Sequence[str]
    ) -> list[RunArtifact]:
        """Look up whichever of `relative_paths` already have a `RunArtifact`
        row for `run_id` - the incremental per-section upload path (issue
        #129) uses this instead of `list`'s full-run page (paired with a
        `FileRepository.get_many` over every row) just to check the 1-2 paths
        one finished section touches."""
        ...


class ModelCatalog(Protocol):
    """Issue #128: queries the configured OpenAI-compatible LLM endpoint for the
    models it offers. Behind a port so `SystemService` (and its tests) never talk to a real
    network endpoint directly - `api.infrastructure.llm.model_catalog.UrllibModelCatalog` is the
    only implementation, wrapped in `CachingModelCatalog` for the in-process ~5-minute cache."""

    async def list_models(self) -> list[LlmModelInfo]:
        """Raises on any network/HTTP/parse failure - `SystemService.list_models` is the one
        place that catches it and degrades to an empty list plus a warning instead of a 5xx."""
        ...


class RunQueue(Protocol):
    async def claim(self, worker_id: str) -> Run | None: ...

    async def heartbeat(self, run_id: uuid.UUID, worker_id: str | None = None) -> bool: ...

    async def release(
        self,
        run_id: uuid.UUID,
        worker_id: str | None = None,
        *,
        options: dict[str, Any] | None = None,
    ) -> bool: ...

    async def requeue_stale(self, older_than_s: float) -> int: ...
