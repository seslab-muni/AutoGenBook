from __future__ import annotations

import uuid
from collections.abc import Sequence

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from api.domain.models import RunArtifact
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
        self, run_id: uuid.UUID, limit: int, offset: int
    ) -> tuple[list[RunArtifact], int]:
        total = await self._session.scalar(
            select(func.count())
            .select_from(RunArtifactRecord)
            .where(RunArtifactRecord.run_id == run_id)
        )
        result = await self._session.execute(
            select(RunArtifactRecord)
            .where(RunArtifactRecord.run_id == run_id)
            .order_by(RunArtifactRecord.relative_path)
            .limit(limit)
            .offset(offset)
        )
        return [_to_domain(record) for record in result.scalars().all()], total or 0

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
