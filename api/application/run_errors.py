"""Turn the CLI's raw failure text into a message a user can act on.

The CLI (an unmodified fork - see CLAUDE.md) writes `str(exc)` of whatever
killed the run into `run_meta.json`'s `error`. For an LLM call that is the
OpenAI client's own repr, e.g.

    Error code: 403 - {'error': {'message': 'litellm.PermissionDeniedError:
    Model is blocked', 'type': None, 'param': None, 'code': '403'}}

which says nothing about *which* model was refused or what to do about it,
and used to be shown verbatim in the run's `error` field and the failure
toast. `describe_cli_failure` recognises those LLM endpoint errors and
rewrites them as "Generation with model X failed: <reason>. <hint>" while
keeping the original text in `detail` for the run detail page. Anything
that does not look like an LLM endpoint error passes through unchanged, so
the CLI's own deliberate messages (missing input file, schema failures,
...) keep their wording.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

__all__ = ["RunFailure", "describe_cli_failure"]


@dataclass(frozen=True)
class RunFailure:
    """`message` is what `Run.error` (and therefore the failure toast) shows;
    `detail` is the original CLI/exception text when `message` was rewritten
    from it, `None` when `message` *is* the original text."""

    message: str
    detail: str | None = None


# The OpenAI python client formats every `APIStatusError` as
# "Error code: <status> - <body>"; that prefix is the most reliable marker of
# an LLM endpoint failure in the CLI's `str(exc)`.
_HTTP_STATUS_RE = re.compile(r"\bError code:\s*(\d{3})\b")
# Non-status failures of the same client (`APIConnectionError`/`APITimeoutError`).
_CONNECTION_MARKERS = (
    "connection error",
    "request timed out",
    "apiconnectionerror",
    "apitimeouterror",
    "remoteprotocolerror",
    "connecterror",
    "readtimeout",
)
# The endpoint's own message inside the body: `{'error': {'message': '...', ...}}`
# (a python-repr'd dict, so single quotes) or a JSON body (double quotes).
_ENDPOINT_MESSAGE_RE = re.compile(r"""["']message["']\s*:\s*(["'])(.*?)\1\s*[,}]""", re.DOTALL)
# LiteLLM/OpenRouter prefix the message with the exception class that raised
# it ("litellm.PermissionDeniedError: Model is blocked") - not useful to a user.
_EXCEPTION_PREFIX_RE = re.compile(r"^(?:[A-Za-z_][\w.]*\.)?[A-Z]\w*(?:Error|Exception):\s*")
_MAX_ENDPOINT_MESSAGE_CHARS = 200


def describe_cli_failure(raw_error: str | None, *, exit_code: int, llm_model: str) -> RunFailure:
    """Map a failed run's raw error (the CLI's `run_meta.json` `error`, or
    `None` when it wrote none) to what `Run.error`/`Run.error_detail` should
    hold. `llm_model` is the model this run was actually launched with
    (`RunOptions.llm_model`, already resolved to a concrete id)."""
    raw = (raw_error or "").strip()
    if not raw:
        return RunFailure(message=f"CLI exited with code {exit_code}")

    status = _http_status(raw)
    if status is None and not _is_connection_failure(raw):
        return RunFailure(message=raw)

    reason, hint = _explain(status, raw)
    return RunFailure(
        message=f'Generation with model "{llm_model}" failed: {reason}. {hint}.',
        detail=raw,
    )


def _http_status(raw: str) -> int | None:
    match = _HTTP_STATUS_RE.search(raw)
    return int(match.group(1)) if match else None


def _is_connection_failure(raw: str) -> bool:
    lowered = raw.lower()
    return any(marker in lowered for marker in _CONNECTION_MARKERS)


def _endpoint_message(raw: str) -> str | None:
    match = _ENDPOINT_MESSAGE_RE.search(raw)
    if not match:
        return None
    text = _EXCEPTION_PREFIX_RE.sub("", match.group(2).strip()).strip()
    if not text:
        return None
    if len(text) > _MAX_ENDPOINT_MESSAGE_CHARS:
        text = text[: _MAX_ENDPOINT_MESSAGE_CHARS - 1].rstrip() + "…"
    return text


def _with_endpoint_message(status: int, raw: str) -> str:
    detail = _endpoint_message(raw)
    return f"HTTP {status}: {detail}" if detail else f"HTTP {status}"


_PICK_ANOTHER_MODEL = "Pick a different model in the project settings or the run dialog and retry"


def _explain(status: int | None, raw: str) -> tuple[str, str]:
    """(reason, hint) - both without a trailing period."""
    if status is None:
        return (
            "the LLM endpoint could not be reached",
            "Retry in a few minutes; if it keeps failing, check the deployment's LLM endpoint URL",
        )
    where = _with_endpoint_message(status, raw)
    if status == 401:
        return (
            f"the LLM endpoint rejected the deployment's API key ({where})",
            "Check the deployment's LLM endpoint credentials",
        )
    if status == 402:
        return (
            f"the LLM endpoint reported insufficient credits ({where})",
            "Top up the endpoint's account or pick a cheaper model and retry",
        )
    if status == 403:
        return (f"the LLM endpoint refused this model ({where})", _PICK_ANOTHER_MODEL)
    if status == 404:
        return (f"the LLM endpoint does not offer this model ({where})", _PICK_ANOTHER_MODEL)
    if status == 429:
        return (
            f"the LLM endpoint rate-limited the run ({where})",
            "Retry in a few minutes or pick a different model",
        )
    if 400 <= status < 500:
        return (f"the LLM endpoint rejected the request ({where})", _PICK_ANOTHER_MODEL)
    if status >= 500:
        return (
            f"the LLM endpoint returned a server error ({where})",
            "Retry later or pick a different model",
        )
    return (f"the LLM endpoint returned an unexpected response ({where})", "Retry later")
