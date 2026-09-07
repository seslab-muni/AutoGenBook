from __future__ import annotations

import enum
import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, CHAR, BigInteger, DateTime, Enum as SqlEnum, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from api.core.db import Base


class FileKind(str, enum.Enum):
    upload = "upload"
    artifact = "artifact"


class File(Base):
    __tablename__ = "files"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    storage_key: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    filename: Mapped[str] = mapped_column(String, nullable=False)
    content_type: Mapped[str] = mapped_column(String, nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sha256: Mapped[str] = mapped_column(CHAR(64), nullable=False, index=True)
    kind: Mapped[FileKind] = mapped_column(
        SqlEnum(FileKind, name="file_kind", native_enum=True), nullable=False
    )
    kb_eligible: Mapped[bool] = mapped_column(Boolean, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
