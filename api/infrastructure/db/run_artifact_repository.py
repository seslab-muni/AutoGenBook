from __future__ import annotations

import uuid
from collections.abc import Sequence

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from api.domain.models import ArtifactKind, RunArtifact
from api.infrastructure.db.models import RunArtifactRecord


def _to_domain(record: RunArtifactRecord) -> RunArtifact:
    return RunArtifact(
        id=record.id,
        run_id=record.run_id,
        file_id=record.file_id,
        kind=record.kind,
        relative_path=record.relative_path,
    )


class SqlAlchemyRunArtifactRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(self, artifact: RunArtifact) -> RunArtifact:
        record = RunArtifactRecord(
            id=artifact.id,
            run_id=artifact.run_id,
            file_id=artifact.file_id,
            kind=artifact.kind,
            relative_path=artifact.relative_path,
        )
        self._session.add(record)
        await self._session.commit()
        await self._session.refresh(record)
        return _to_domain(record)

    async def list(
        self, run_id: uuid.UUID, limit: int, offset: int, kind: ArtifactKind | None = None
    ) -> tuple[list[RunArtifact], int]:
        conditions = [RunArtifactRecord.run_id == run_id]
        if kind is not None:
            conditions.append(RunArtifactRecord.kind == kind)
        total = await self._session.scalar(
            select(func.count()).select_from(RunArtifactRecord).where(*conditions)
        )
        result = await self._session.execute(
            select(RunArtifactRecord)
            .where(*conditions)
            .order_by(RunArtifactRecord.relative_path)
            .limit(limit)
            .offset(offset)
        )
        return [_to_domain(record) for record in result.scalars().all()], total or 0

    async def count_by_kind(self, run_id: uuid.UUID) -> dict[ArtifactKind, int]:
        result = await self._session.execute(
            select(RunArtifactRecord.kind, func.count())
            .where(RunArtifactRecord.run_id == run_id)
            .group_by(RunArtifactRecord.kind)
        )
        return {kind: count for kind, count in result.all()}

    async def delete_by_run(self, run_id: uuid.UUID) -> None:
        await self._session.execute(
            delete(RunArtifactRecord).where(RunArtifactRecord.run_id == run_id)
        )
        await self._session.commit()

    async def delete_many(self, artifact_ids: Sequence[uuid.UUID]) -> None:
        if not artifact_ids:
            return
        await self._session.execute(
            delete(RunArtifactRecord).where(RunArtifactRecord.id.in_(artifact_ids))
        )
        await self._session.commit()

    async def get_many_by_paths(
        self, run_id: uuid.UUID, relative_paths: Sequence[str]
    ) -> list[RunArtifact]:
        if not relative_paths:
            return []
        result = await self._session.execute(
            select(RunArtifactRecord).where(
                RunArtifactRecord.run_id == run_id,
                RunArtifactRecord.relative_path.in_(relative_paths),
            )
        )
        return [_to_domain(record) for record in result.scalars().all()]
