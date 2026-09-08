from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.core.errors import NotFound
from api.domain.models import User
from api.infrastructure.db.models import UserRecord


def _as_aware_utc(value: datetime) -> datetime:
    # SQLite drops tzinfo on round-trip (unlike Postgres); re-attach it, same
    # as every other repository in this package.
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _to_domain(record: UserRecord) -> User:
    return User(
        id=record.id,
        email=record.email,
        display_name=record.display_name,
        password_hash=record.password_hash,
        is_active=record.is_active,
        password_changed_at=_as_aware_utc(record.password_changed_at),
        created_at=_as_aware_utc(record.created_at),
        updated_at=_as_aware_utc(record.updated_at),
    )


class SqlAlchemyUserRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get_by_email(self, email: str) -> User | None:
        record = await self._session.scalar(
            select(UserRecord).where(UserRecord.email == email.strip().lower())
        )
        return _to_domain(record) if record is not None else None

    async def get_by_id(self, user_id: uuid.UUID) -> User | None:
        record = await self._session.get(UserRecord, user_id)
        return _to_domain(record) if record is not None else None

    async def add(self, user: User) -> User:
        record = UserRecord(
            id=user.id,
            email=user.email.strip().lower(),
            display_name=user.display_name,
            password_hash=user.password_hash,
            is_active=user.is_active,
            password_changed_at=user.password_changed_at,
            created_at=user.created_at,
            updated_at=user.updated_at,
        )
        self._session.add(record)
        await self._session.commit()
        await self._session.refresh(record)
        return _to_domain(record)

    async def update_password(self, user_id: uuid.UUID, password_hash: str) -> User:
        record = await self._session.get(UserRecord, user_id)
        if record is None:
            raise NotFound(f"user {user_id} does not exist")
        now = datetime.now(timezone.utc)
        record.password_hash = password_hash
        # Bumping this invalidates every token issued before now - see
        # `AuthService.verify_token`'s `pca` check.
        record.password_changed_at = now
        record.updated_at = now
        await self._session.commit()
        await self._session.refresh(record)
        return _to_domain(record)

    async def set_active(self, user_id: uuid.UUID, is_active: bool) -> User:
        record = await self._session.get(UserRecord, user_id)
        if record is None:
            raise NotFound(f"user {user_id} does not exist")
        record.is_active = is_active
        record.updated_at = datetime.now(timezone.utc)
        await self._session.commit()
        await self._session.refresh(record)
        return _to_domain(record)

    async def list(self) -> list[User]:
        result = await self._session.execute(select(UserRecord).order_by(UserRecord.email))
        return [_to_domain(record) for record in result.scalars().all()]
