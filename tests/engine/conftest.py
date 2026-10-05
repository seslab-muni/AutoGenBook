"""Shared fixtures for the engine test suite (`pytest tests/engine`).

No test here touches the network: pipeline tests run against the in-process
fake LLM (`fake_llm.py`) through the engine's injectable HTTP transport.
Tests that need an external binary or optional package (pandoc, lualatex,
tesseract, libreoffice, a TTS model) use the `requires_*` markers below and
skip cleanly when it is missing.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from fake_llm import FakeLLM  # noqa: E402


BENCH_HELP = "also run the tests marked `bench` (benchmark harness checks and retrieval evals; off by default)"


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption("--bench", action="store_true", default=False, help=BENCH_HELP)


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers",
        "bench: benchmark harness and evaluation tests. Deselected unless `--bench` is given "
        "(`pytest tests/engine --bench -m bench` runs only them); CI runs them on demand "
        "from .github/workflows/bench.yml, not on every push.",
    )


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """`bench` tests are measurement, not regression checks: without `--bench` they are
    deselected so `pytest tests/engine` stays the quick, always-on suite."""
    if config.getoption("--bench"):
        return
    kept, dropped = [], []
    for item in items:
        (dropped if item.get_closest_marker("bench") else kept).append(item)
    if dropped:
        config.hook.pytest_deselected(items=dropped)
        items[:] = kept


@pytest.fixture
def repo_root() -> Path:
    return REPO_ROOT


@pytest.fixture
def fake_llm() -> FakeLLM:
    return FakeLLM()


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Keep a developer's real credentials/endpoints out of every test."""
    for name in (
        "OPENROUTER_API_KEY",
        "OPENROUTER_BASE_URL",
        "OPENAI_API_KEY",
        "AUTOGENBOOK_LLM_BASE_URL",
        "AUTOGENBOOK_LLM_API_KEY",
        "AUTOGENBOOK_LLM_MODEL",
        "AUTOGENBOOK_LLM_MINI_MODEL",
        "AUTOGENBOOK_FORCE_MINI_MODEL",
        "AUTOGENBOOK_LLM_REASONING_EFFORT",
        "AUTOGENBOOK_JUDGE_MODEL",
        "AUTOGENBOOK_CONCURRENCY",
        "AUTOGENBOOK_BOOK_AUTHOR",
        "AUTOGENBOOK_EMBED_MODEL",
        "AUTOGENBOOK_EMBED_BASE_URL",
        "AUTOGENBOOK_EMBED_API_KEY",
        "AUTOGENBOOK_DENSE",
        "AUTOGENBOOK_RERANK",
        "AUTOGENBOOK_RERANK_MODEL",
        "AUTOGENBOOK_RERANK_BASE_URL",
        "AUTOGENBOOK_KB_OCR",
        "AUTOGENBOOK_KB_OCR_LANG",
        "TAVILY_API_KEY",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "https_proxy",
        "http_proxy",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("AUTOGENBOOK_KB_EXTRACT_CACHE_DIR", str(tmp_path / "_extract_cache"))
