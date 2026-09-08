"""Tests for `default_credentials_warning` (issue #83): warn at startup if
the deployment still has the baked-in default S3/MinIO secret *and* looks
reachable beyond localhost, so exposing the stack to a network with unchanged
credentials doesn't fail silently.
"""

from __future__ import annotations

import pytest

from api.core.settings import DEFAULT_S3_SECRET_KEY, Settings, default_credentials_warning


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
