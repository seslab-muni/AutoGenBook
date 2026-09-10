"""Tests for `default_credentials_warning` (issue #83): warn at startup if
the deployment still has the baked-in default S3/MinIO secret *and* looks
reachable beyond localhost, so exposing the stack to a network with unchanged
credentials doesn't fail silently.
"""

from __future__ import annotations

import pytest

from api.core.settings import (
    DEFAULT_S3_SECRET_KEY,
    FALLBACK_LLM_MODEL,
    Settings,
    default_credentials_warning,
    default_llm_model,
    resolved_llm_api_key,
    resolved_llm_base_url,
)


def _settings(**overrides) -> Settings:
    defaults: dict = dict(s3_secret_key=DEFAULT_S3_SECRET_KEY, web_bind_host="127.0.0.1")
    defaults.update(overrides)
    return Settings(**defaults)


def test_no_warning_when_secret_is_default_but_bound_to_loopback() -> None:
    assert default_credentials_warning(_settings(web_bind_host="127.0.0.1")) is None
    assert default_credentials_warning(_settings(web_bind_host="localhost")) is None
    assert default_credentials_warning(_settings(web_bind_host="::1")) is None


def test_no_warning_when_secret_is_not_default_even_if_exposed() -> None:
    settings = _settings(s3_secret_key="a-real-secret", web_bind_host="0.0.0.0")
    assert default_credentials_warning(settings) is None


def test_warning_when_default_secret_and_exposed_beyond_loopback() -> None:
    settings = _settings(s3_secret_key=DEFAULT_S3_SECRET_KEY, web_bind_host="0.0.0.0")
    warning = default_credentials_warning(settings)
    assert warning is not None
    assert "S3_SECRET_KEY" in warning
    assert "0.0.0.0" in warning


@pytest.mark.parametrize("bind_host", ["0.0.0.0", "10.0.0.5", "example.com"])
def test_warning_for_various_non_loopback_hosts(bind_host: str) -> None:
    settings = _settings(web_bind_host=bind_host)
    assert default_credentials_warning(settings) is not None


def test_bind_host_comparison_is_case_and_whitespace_insensitive() -> None:
    assert default_credentials_warning(_settings(web_bind_host=" LOCALHOST ")) is None


# Issue #128: per-project/per-run LLM model selection - `default_llm_model` (a fresh project's
# initial `llmModel`) and the `GET /system/models` discovery endpoint's base URL/API key
# resolution, both layered `AUTOGENBOOK_LLM_*` over `OPENROUTER_*` the same way the CLI's own
# `openrouter_llm.py:OpenRouterLLM.__init__` does (without importing that module - the CLI is an
# unmodified fork).


def test_default_llm_model_falls_back_when_env_var_unset() -> None:
    assert default_llm_model(_settings(autogenbook_llm_model=None)) == FALLBACK_LLM_MODEL


def test_default_llm_model_uses_configured_env_var() -> None:
    settings = _settings(autogenbook_llm_model="anthropic/claude-3.5-sonnet")
    assert default_llm_model(settings) == "anthropic/claude-3.5-sonnet"


def test_default_llm_model_treats_blank_env_var_as_unset() -> None:
    assert default_llm_model(_settings(autogenbook_llm_model="   ")) == FALLBACK_LLM_MODEL


def test_resolved_llm_base_url_prefers_autogenbook_over_openrouter() -> None:
    settings = _settings(
        autogenbook_llm_base_url="http://lm-studio:1234/v1",
        openrouter_base_url="https://openrouter.ai/api/v1",
    )
    assert resolved_llm_base_url(settings) == "http://lm-studio:1234/v1"


def test_resolved_llm_base_url_falls_back_to_openrouter_base_url() -> None:
    settings = _settings(autogenbook_llm_base_url=None, openrouter_base_url="https://custom/v1")
    assert resolved_llm_base_url(settings) == "https://custom/v1"


def test_resolved_llm_base_url_default_is_openrouter() -> None:
    settings = _settings(autogenbook_llm_base_url=None)
    assert resolved_llm_base_url(settings) == "https://openrouter.ai/api/v1"


def test_resolved_llm_api_key_prefers_autogenbook_over_openrouter() -> None:
    settings = _settings(autogenbook_llm_api_key="agb-key", openrouter_api_key="or-key")
    assert resolved_llm_api_key(settings) == "agb-key"


def test_resolved_llm_api_key_falls_back_to_openrouter_api_key() -> None:
    settings = _settings(autogenbook_llm_api_key=None, openrouter_api_key="or-key")
    assert resolved_llm_api_key(settings) == "or-key"


def test_resolved_llm_api_key_none_when_neither_is_set() -> None:
    settings = _settings(autogenbook_llm_api_key=None, openrouter_api_key=None)
    assert resolved_llm_api_key(settings) is None
