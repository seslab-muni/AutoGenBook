"""`api.application.run_errors.describe_cli_failure`: the CLI's raw failure
text -> the user-facing `Run.error` (+ original text in `error_detail`)."""
from __future__ import annotations

import pytest

from api.application.run_errors import RunFailure, describe_cli_failure

BLOCKED = (
    "Error code: 403 - {'error': {'message': 'litellm.PermissionDeniedError: "
    "Model is blocked', 'type': None, 'param': None, 'code': '403'}}"
)


def test_blocked_model_403_names_the_model_and_the_endpoints_reason() -> None:
    failure = describe_cli_failure(BLOCKED, exit_code=1, llm_model="deepseek-v4-flash")
    assert failure == RunFailure(
        message=(
            'Generation with model "deepseek-v4-flash" failed: the LLM endpoint refused this '
            "model (HTTP 403: Model is blocked). Pick a different model in the project "
            "settings or the run dialog and retry."
        ),
        detail=BLOCKED,
    )


@pytest.mark.parametrize(
    ("raw", "reason", "hint"),
    [
        (
            "Error code: 401 - {'error': {'message': 'Invalid API key', 'code': 401}}",
            "rejected the deployment's API key (HTTP 401: Invalid API key)",
            "Check the deployment's LLM endpoint credentials.",
        ),
        (
            "Error code: 402 - {'error': {'message': 'Insufficient credits', 'code': 402}}",
            "reported insufficient credits (HTTP 402: Insufficient credits)",
            "Top up the endpoint's account or pick a cheaper model and retry.",
        ),
        (
            'Error code: 404 - {"error": {"message": "The model `foo/bar` does not exist", "type": "invalid_request_error"}}',
            "does not offer this model (HTTP 404: The model `foo/bar` does not exist)",
            "Pick a different model in the project settings or the run dialog and retry.",
        ),
        (
            "Error code: 429 - {'error': {'message': 'Rate limit exceeded: free-models-per-day', 'code': 429}}",
            "rate-limited the run (HTTP 429: Rate limit exceeded: free-models-per-day)",
            "Retry in a few minutes or pick a different model.",
        ),
        (
            "Error code: 400 - {'error': {'message': 'response_format is not supported', 'code': 400}}",
            "rejected the request (HTTP 400: response_format is not supported)",
            "Pick a different model in the project settings or the run dialog and retry.",
        ),
        (
            "Error code: 502 - {'error': {'message': 'upstream connect error', 'code': 502}}",
            "returned a server error (HTTP 502: upstream connect error)",
            "Retry later or pick a different model.",
        ),
        # No parsable body: the status alone.
        (
            "Error code: 503 - <html>Service Unavailable</html>",
            "returned a server error (HTTP 503)",
            "Retry later or pick a different model.",
        ),
    ],
)
def test_http_statuses_get_a_reason_and_a_hint(raw: str, reason: str, hint: str) -> None:
    failure = describe_cli_failure(raw, exit_code=1, llm_model="glm-5.3")
    assert failure.message == f'Generation with model "glm-5.3" failed: the LLM endpoint {reason}. {hint}'
    assert failure.detail == raw


@pytest.mark.parametrize("raw", ["Connection error.", "Request timed out.", "APIConnectionError: [Errno 111] Connection refused"])
def test_connection_failures_are_reported_as_unreachable_endpoint(raw: str) -> None:
    failure = describe_cli_failure(raw, exit_code=1, llm_model="glm-5.3")
    assert failure.message == (
        'Generation with model "glm-5.3" failed: the LLM endpoint could not be reached. '
        "Retry in a few minutes; if it keeps failing, check the deployment's LLM endpoint URL."
    )
    assert failure.detail == raw


def test_exception_class_prefix_is_stripped_from_the_endpoints_message() -> None:
    raw = "Error code: 403 - {'error': {'message': 'openai.PermissionDeniedError: Model is blocked'}}"
    assert "(HTTP 403: Model is blocked)" in describe_cli_failure(raw, exit_code=1, llm_model="m").message


def test_an_overlong_endpoint_message_is_truncated() -> None:
    raw = "Error code: 400 - {'error': {'message': '" + "x" * 500 + "'}}"
    message = describe_cli_failure(raw, exit_code=1, llm_model="m").message
    assert "x" * 199 + "…)" in message
    assert "x" * 200 not in message


def test_a_non_llm_error_passes_through_unchanged() -> None:
    raw = "Struktura knihy neobsahuje zadne kapitoly"
    assert describe_cli_failure(raw, exit_code=1, llm_model="m") == RunFailure(message=raw, detail=None)


def test_a_missing_error_falls_back_to_the_exit_code() -> None:
    assert describe_cli_failure(None, exit_code=-9, llm_model="m") == RunFailure(message="CLI exited with code -9")
    assert describe_cli_failure("   ", exit_code=2, llm_model="m") == RunFailure(message="CLI exited with code 2")
