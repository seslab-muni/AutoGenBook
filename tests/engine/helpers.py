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


# ------------------------------------------------------- API-shaped runs
BENCH = REPO_ROOT / "input" / "bench"
RUN_ENGINE = REPO_ROOT / "run_engine.py"


def make_work_dir(tmp_path: Path, *, bench: str = "en_book", name: str = "run", with_kb: bool = True) -> Path:
    """A run work dir laid out like `GenerationService` does: book_input.txt,
    kb/<source_id>/<file>."""
    work = tmp_path / name
    work.mkdir(parents=True)
    _shutil.copyfile(BENCH / bench / "book_input.txt", work / "book_input.txt")
    if with_kb:
        _shutil.copytree(BENCH / bench / "kb", work / "kb")
    return work


def project_structure(*, locked_file: str | None = None, lock_nodes: bool = False) -> dict:
    """A `book_structure.json` as `api/application/book_spec.py:StructureBuilder`
    renders it (outline mode "project")."""
    def leaf(title: str, summary: str, pages: float, **extra) -> dict:
        node = {"title": title, "summary": f"{summary}\n\nWriting instructions: Math level: intuitive. Equation density: 2/5.",
                "n_pages": pages, "needsSubdivision": False}
        if lock_nodes:
            node["structure_locked"] = True
        node.update(extra)
        return node

    chapter1 = {"title": "Mechanical calculation", "summary": "From Pascal to Babbage.\n\nWriting instructions: Math level: intuitive. Equation density: 2/5.",
                "n_pages": 2.0, "needsSubdivision": True, "childs": [
                    leaf("Pascal and Leibniz", "Early calculating machines and carrying.", 1.0, kb_scope="selected", kb_sources=["mechanical-computing"]),
                    leaf("The Difference Engine", "Finite differences and Babbage's first engine.", 1.0),
                ]}
    locked_extra = {"content_locked": True, "structure_locked": True, "content_file": locked_file} if locked_file else {}
    chapter2 = {"title": "Electronic computers", "summary": "ENIAC and the stored program.\n\nWriting instructions: Math level: intuitive. Equation density: 2/5.",
                "n_pages": 2.0, "needsSubdivision": True, "kb_scope": "all", "childs": [
                    leaf("ENIAC", "The first general electronic computer and its plugboards.", 1.0, **locked_extra),
                    leaf("The stored program", "The EDVAC report and the Manchester Baby.", 1.0),
                ]}
    if lock_nodes:
        chapter1["structure_locked"] = chapter2["structure_locked"] = True
    return {
        "title": "How Computers Came to Be",
        "summary": "A short history of computing.",
        "n_pages": 4.0,
        "target_readers": "undergraduate students",
        "equation_frequency_level": 2,
        "do_consider_outline": True,
        "do_consider_previous_sections": True,
        "additional_requirements": "",
        "max_depth": 3,
        "max_output_pages": 1.5,
        "childs": [chapter1, chapter2],
    }


def api_argv(work_dir: Path, **options) -> tuple[list[str], dict[str, str]]:
    from api.domain.models import RunOptions
    from api.infrastructure.cli import book_command

    options.setdefault("outline", "generate")
    settings = ApiSettingsStub(RUN_ENGINE, work_dir.parent / "_extract_cache")
    argv, env, _cwd = book_command.build_command(work_dir, RunOptions(**options), settings, author="Ada Lovelace")
    return argv, env


def api_run(work_dir: Path, fake, *, extra: list[str] | None = None, **options) -> CliRun:
    """Run the engine in-process with exactly the argv/env the API builds."""
    argv, env = api_argv(work_dir, **options)
    env = {**env, **engine_env(work_dir.parent)}
    return run_cli(argv[2:] + list(extra or []), fake=fake, env=env)


def write_project(work_dir: Path, structure: dict, locked: dict[str, str] | None = None) -> None:
    out = work_dir / "out"
    out.mkdir(parents=True, exist_ok=True)
    (out / "book_structure.json").write_text(json.dumps(structure, ensure_ascii=False, indent=2), encoding="utf-8")
    for rel, text in (locked or {}).items():
        target = out / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
