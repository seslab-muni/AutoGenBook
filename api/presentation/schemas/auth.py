from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import ConfigDict

from api.domain.models import User as UserDomain
from api.presentation.schemas.common import BaseSchema, NonBlankStr


class LoginRequest(BaseSchema):
    model_config = ConfigDict(extra="forbid")

    email: NonBlankStr
    password: NonBlankStr


class SetLlmKeyRequest(BaseSchema):
    model_config = ConfigDict(extra="forbid")

    # A plain `str`, not `NonBlankStr`/`max_length`: the trim/blank/length checks live in
    # the route (`auth.set_llm_key`) because a pydantic validation error echoes the
    # offending `input` back in the 422 body (`api/core/errors.py`), which for this field
    # would be (a prefix of) the secret itself.
    api_key: str


class LlmKeyOut(BaseSchema):
    # What the API ever reveals about a stored key: its last four characters and when it
    # was set - never the key or its ciphertext.

    last4: str
    updated_at: datetime


class UserOut(BaseSchema):
    id: uuid.UUID
    email: str
    display_name: str
    # Per-user LLM key: whether this deployment can store keys at all (a
    # `LLM_KEY_ENCRYPTION_KEY` is set), the admission policy, and this user's own key.
    llm_key_configurable: bool = False
    llm_key_policy: Literal["optional", "required"] = "optional"
    llm_key: LlmKeyOut | None = None


def user_to_schema(
    user: UserDomain,
    *,
    llm_key_configurable: bool = False,
    llm_key_policy: Literal["optional", "required"] = "optional",
) -> UserOut:
    llm_key = None
    if (
        user.llm_api_key_encrypted is not None
        and user.llm_api_key_last4 is not None
        and user.llm_api_key_updated_at is not None
    ):
        llm_key = LlmKeyOut(
            last4=user.llm_api_key_last4, updated_at=user.llm_api_key_updated_at
        )
    return UserOut(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        llm_key_configurable=llm_key_configurable,
        llm_key_policy=llm_key_policy,
        llm_key=llm_key,
    )
