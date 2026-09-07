from __future__ import annotations

import uuid
from datetime import datetime

from api.domain.models import FileKind
from api.presentation.schemas.common import BaseSchema


class File(BaseSchema):
    id: uuid.UUID
    filename: str
    content_type: str
    size_bytes: int
    sha256: str
    kind: FileKind
    kb_eligible: bool
    created_at: datetime
