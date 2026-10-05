"""Encryption at rest for per-user LLM API keys (per-user LLM key).

Fernet (AES-128-CBC + HMAC-SHA256, from the `cryptography` package) keyed by
`Settings.llm_key_encryption_key`. The ciphertext lives in
`users.llm_api_key_encrypted`; it is never returned by the API and never logged.
Rotating `LLM_KEY_ENCRYPTION_KEY` makes every stored key undecryptable on
purpose: `GenerationService` then fails the run with a clear error instead of
silently falling back to the shared deployment key, and each user re-enters
their key.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from cryptography.fernet import Fernet, InvalidToken

if TYPE_CHECKING:  # pragma: no cover - typing only
    from api.core.settings import Settings


class LlmKeyDecryptError(Exception):
    """A stored key could not be decrypted (wrong/rotated `LLM_KEY_ENCRYPTION_KEY`
    or a corrupted value). Deliberately carries no ciphertext or key material."""


def validate_fernet_key(key: str) -> None:
    """Raises `ValueError` (so pydantic reports it as a settings error) unless
    `key` is a well-formed Fernet key (32 url-safe-base64 bytes)."""
    try:
        Fernet(key.encode("utf-8"))
    except Exception as exc:  # noqa: BLE001 - cryptography raises ValueError/binascii.Error
        raise ValueError(
            "LLM_KEY_ENCRYPTION_KEY is not a valid Fernet key (32 random bytes, url-safe "
            "base64); generate one with `python -c \"import base64, os; "
            "print(base64.urlsafe_b64encode(os.urandom(32)).decode())\"`"
        ) from exc


class LlmKeyCipher:
    def __init__(self, key: str) -> None:
        self._fernet = Fernet(key.encode("utf-8"))

    @classmethod
    def from_settings(cls, settings: "Settings") -> "LlmKeyCipher | None":
        """`None` when the feature is disabled (no encryption key configured)."""
        if settings.llm_key_encryption_key is None:
            return None
        return cls(settings.llm_key_encryption_key)

    def encrypt(self, plain: str) -> str:
        return self._fernet.encrypt(plain.encode("utf-8")).decode("ascii")

    def decrypt(self, token: str) -> str:
        try:
            return self._fernet.decrypt(token.encode("ascii")).decode("utf-8")
        except (InvalidToken, UnicodeError) as exc:
            raise LlmKeyDecryptError("stored LLM API key could not be decrypted") from exc
