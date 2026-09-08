from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from api.core.errors import Unauthorized
from api.core.settings import Settings
from api.domain.models import User
from api.domain.ports import UserRepository

_JWT_ALGORITHM = "HS256"
# Deliberately identical for "no such account" and "wrong password" (issue
# #96) - a distinct message for either would let a caller enumerate which of
# the 4 lab emails are registered.
_GENERIC_LOGIN_ERROR = "Invalid email or password"

_password_hasher = PasswordHasher()
# A verify against a hash nobody's real password could have produced, run
# whenever the email doesn't exist at all, so `authenticate` takes roughly
# the same time either way - unknown email vs. known email/wrong password -
# instead of returning early and leaking which emails exist through timing.
_DUMMY_PASSWORD_HASH = _password_hasher.hash("autogenbook-dummy-verify-target")


class AuthService:
    def __init__(self, users: UserRepository, settings: Settings) -> None:
        self._users = users
        self._settings = settings

    @staticmethod
    def hash_password(password: str) -> str:
        return _password_hasher.hash(password)

    @staticmethod
    def verify_password(password_hash: str, password: str) -> bool:
        try:
            return _password_hasher.verify(password_hash, password)
        except (VerifyMismatchError, VerificationError, InvalidHashError):
            return False

    async def authenticate(self, email: str, password: str) -> User:
        user = await self._users.get_by_email(email)
        if user is None:
            self.verify_password(_DUMMY_PASSWORD_HASH, password)
            raise Unauthorized(_GENERIC_LOGIN_ERROR)
        if not self.verify_password(user.password_hash, password) or not user.is_active:
            raise Unauthorized(_GENERIC_LOGIN_ERROR)
        return user

    def issue_token(self, user: User) -> str:
        now = datetime.now(timezone.utc)
        payload = {
            "sub": str(user.id),
            "email": user.email,
            "name": user.display_name,
            "iat": now,
            "exp": now + timedelta(hours=self._settings.auth_token_ttl_h),
            # Password-changed-at epoch, snapshotted at issuance - see
            # `verify_token` below. Rotating a password (`set-password`)
            # bumps this on the user row, which invalidates every token
            # issued before that moment on its next request. Kept as a float
            # (sub-second precision), not truncated to whole seconds like
            # `iat`/`exp` - a login immediately followed by a password
            # rotation (well within realistic reach of an admin script or a
            # test) must still compare as "before", not tie on the same
            # truncated second.
            "pca": user.password_changed_at.timestamp(),
        }
        return jwt.encode(payload, self._settings.auth_jwt_secret, algorithm=_JWT_ALGORITHM)

    async def verify_token(self, token: str) -> User:
        try:
            payload = jwt.decode(
                token, self._settings.auth_jwt_secret, algorithms=[_JWT_ALGORITHM]
            )
        except jwt.PyJWTError as exc:
            raise Unauthorized("invalid or expired session") from exc
        try:
            user_id = uuid.UUID(str(payload.get("sub")))
        except (TypeError, ValueError) as exc:
            raise Unauthorized("invalid or expired session") from exc
        user = await self._users.get_by_id(user_id)
        if user is None or not user.is_active:
            raise Unauthorized("invalid or expired session")
        token_pca = payload.get("pca")
        if token_pca is None or float(token_pca) < user.password_changed_at.timestamp():
            # The password changed (directly, or via an admin `set-password`)
            # after this token was issued - the stateless revocation story
            # #96 needs: "rotate password" == "log everyone out".
            raise Unauthorized("invalid or expired session")
        return user
