"""Helpers shared by the engine tests (importable as `helpers` from any test
module in this directory)."""

from __future__ import annotations

import importlib.util
import shutil

import pytest


def _have(binary: str) -> bool:
    return shutil.which(binary) is not None


def _have_module(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


requires_pandoc = pytest.mark.skipif(not _have("pandoc"), reason="pandoc not installed")
requires_lualatex = pytest.mark.skipif(
    not (_have("pandoc") and _have("lualatex")), reason="pandoc/lualatex not installed"
)
requires_tesseract = pytest.mark.skipif(
    not (_have("tesseract") and _have_module("pytesseract")), reason="tesseract not installed"
)
requires_libreoffice = pytest.mark.skipif(
    not (_have("libreoffice") or _have("soffice")), reason="libreoffice not installed"
)




# ------------------------------------------------------------ engine runners
import io  # noqa: E402
import json  # noqa: E402
import shutil as _shutil  # noqa: E402
import sys  # noqa: E402
from dataclasses import dataclass  # noqa: E402
from pathlib import Path  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
FAKE_BASE_URL = "http://fake.local/v1"


def engine_env(tmp_path: Path, **extra: str) -> dict[str, str]:
    """A controlled environment for in-process runs (never the developer's)."""
    env = {
        "AUTOGENBOOK_LLM_BASE_URL": FAKE_BASE_URL,
        "AUTOGENBOOK_LLM_API_KEY": "fake-key",
        "AUTOGENBOOK_LLM_MODEL": "fake-model",
        "AUTOGENBOOK_LLM_MINI_MODEL": "fake-mini",
        "AUTOGENBOOK_KB_EXTRACT_CACHE_DIR": str(tmp_path / "_extract_cache"),
        "AUTOGENBOOK_NONINTERACTIVE": "1",
        "HOME": str(tmp_path / "_home"),
    }
    env.update(extra)
    return env


@dataclass
class CliRun:
    exit_code: int
    lines: list[str]
    out_dir: Path

    @property
    def text(self) -> str:
        return "\n".join(self.lines)

    def run_meta(self) -> dict:
        return json.loads((self.out_dir / "run_meta.json").read_text(encoding="utf-8"))

    def usage_lines(self) -> list[dict]:
        path = self.out_dir / "llm_usage.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def graph(self) -> dict:
        return json.loads((self.out_dir / "structure_graph.json").read_text(encoding="utf-8"))


def run_cli(argv: list[str], *, fake=None, env: dict[str, str] | None = None, tmp_path: Path | None = None) -> CliRun:
    from engine.cli import main

    buffer = io.StringIO()
    out_dir = Path(argv[argv.index("-o") + 1]) if "-o" in argv else Path("out")
    code = main(
        argv,
        transport=fake.transport() if fake is not None else None,
        stdout=buffer,
        env=env if env is not None else engine_env(tmp_path or out_dir.parent),
    )
    return CliRun(code, buffer.getvalue().splitlines(), out_dir)


def copy_legacy_work_dir(tmp_path: Path) -> Path:
    """A copy of the repo's old-engine sample run (`output/book`)."""
    work = tmp_path / "legacy"
    _shutil.copytree(REPO_ROOT / "output" / "book", work / "out")
    _shutil.copyfile(REPO_ROOT / "input" / "book" / "book_input.txt", work / "book_input.txt")
    return work


class ApiSettingsStub:
    """The attributes `api/infrastructure/cli/book_command.build_command` reads."""

    def __init__(self, entrypoint: Path, cache: Path) -> None:
        self.cli_python = sys.executable
        self.cli_entrypoint = str(entrypoint)
        self.repo_root = str(REPO_ROOT)
        self.kb_extract_cache_dir = str(cache)
