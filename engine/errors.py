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
