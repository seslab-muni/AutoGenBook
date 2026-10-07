"""Engine exception hierarchy and exit codes."""

from __future__ import annotations

EXIT_OK = 0
EXIT_FAILURE = 1
EXIT_USAGE = 2
EXIT_AUDIT = 4
EXIT_CANCELLED = 143


class EngineError(Exception):
    """A failure the engine reports cleanly (no traceback) with `exit_code`."""

    exit_code = EXIT_FAILURE


class InputError(EngineError):
    exit_code = EXIT_USAGE


class ConfigError(EngineError):
    exit_code = EXIT_USAGE


class SpecError(EngineError):
    pass


class PromptError(EngineError):
    """A prompt pack is inconsistent (unknown or missing placeholder)."""


class SchemaError(EngineError):
    """An agent's output could not be parsed/validated even after one repair."""

    def __init__(self, label: str, detail: str) -> None:
        super().__init__(f"{label}: model output does not match the expected schema ({detail})")
        self.label = label
        self.detail = detail


class AuditBlocked(EngineError):
    exit_code = EXIT_AUDIT


class GenerationFailed(EngineError):
    """One or more tasks failed; the others completed and were persisted."""


class ReviseError(EngineError):
    """`engine.revise` could not produce a usable revision. `usage` holds the
    LLM usage totals spent before the failure (empty when nothing was spent)."""

    def __init__(self, message: str, *, usage: dict | None = None) -> None:
        super().__init__(message)
        self.usage: dict = usage or {}


class AnchorOrphaned(ReviseError):
    """The anchor of a range revision no longer matches the section text."""

    def __init__(self, quote: str) -> None:
        shown = quote if len(quote) <= 80 else quote[:77] + "..."
        super().__init__(f"the selected range cannot be found in the section any more: {shown!r}")
        self.quote = quote


class ReviseConfigError(ReviseError):
    """The LLM settings cannot be used (for example a missing API key)."""


class ReviseAuthError(ReviseError):
    """The provider rejected the credentials (401/403)."""


class ReviseRateLimited(ReviseError):
    """The provider kept answering 429 after the client's retries."""


class ReviseTimeout(ReviseError):
    """The provider did not answer in time."""


class ReviseProviderError(ReviseError):
    """Any other provider or transport failure."""


class ReviseUnusableOutput(ReviseError):
    """The model's output did not match the schema, even after one repair."""
