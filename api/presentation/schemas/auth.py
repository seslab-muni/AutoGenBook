from __future__ import annotations

import uuid

from pydantic import ConfigDict

from api.domain.models import User as UserDomain
from api.presentation.schemas.common import BaseSchema, NonBlankStr


class LoginRequest(BaseSchema):
    model_config = ConfigDict(extra="forbid")

    email: NonBlankStr
    password: NonBlankStr


class UserOut(BaseSchema):
    id: uuid.UUID
    email: str
    display_name: str


def user_to_schema(user: UserDomain) -> UserOut:
    return UserOut(id=user.id, email=user.email, display_name=user.display_name)
