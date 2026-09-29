"""Contract 3.1: invocation (argv, exit codes, non-interactivity).

The argv under test is produced by the API's own builder
(`api/infrastructure/cli/book_command.py:build_command`), so a flag the API
starts sending that the engine does not know fails here first.
"""

from __future__ import annotations

import itertools
import os
import subprocess
import sys
from pathlib import Path

import pytest

from api.domain.models import RunOptions
from api.infrastructure.cli import book_command
from engine.cli import build_parser
from engine.config import RunConfig
from helpers import REPO_ROOT, ApiSettingsStub, copy_legacy_work_dir, engine_env

RUN_ENGINE = REPO_ROOT / "run_engine.py"


def _api_argv(work_dir: Path, **options) -> tuple[list[str], dict[str, str], str]:
    settings = ApiSettingsStub(RUN_ENGINE, work_dir / "_cache")
    return book_command.build_command(work_dir, RunOptions(**options), settings, author="Ada")


def _option_matrix():
    for outline, fmt in itertools.product(("project", "generate"), ("markdown", "latex", "pdf")):
        for flags in (
            {},
            {"resume": True, "rebuild_kb": True},
            {"enable_web_rag": True, "fail_fast_schema": True, "legacy_tex": True},
            {"audit_book": True},
            {"audit_book": True, "audit_book_mode": "strict"},
            {"audit_book": True, "audit_book_mode": "off"},
        ):
            yield {"outline": outline, "output_format": fmt, **flags}


def test_accepts_every_argv_book_command_builds(tmp_path: Path) -> None:
    """Every argv `api/infrastructure/cli/book_command.py:build_command` can emit parses (outline x format x per-run flags)."""
    work = tmp_path / "run"
    (work / "kb" / "src1").mkdir(parents=True)
    parser = build_parser()
    count = 0
    for options in _option_matrix():
        argv, env, cwd = _api_argv(work, **options)
        assert argv[1] == str(RUN_ENGINE) and cwd == str(REPO_ROOT)
        args = parser.parse_args(argv[2:])  # SystemExit(2) would fail the test
        cfg = RunConfig.from_args(args, env)
        assert cfg.mode == "book" and cfg.kb_dir == (work / "kb").resolve()
        assert cfg.json_path == (work / "out" / "book_structure.json").resolve()
        assert cfg.resume == bool(options.get("resume"))
        fmt = options["output_format"]
        assert (cfg.tex_output, cfg.pdf_output) == {"markdown": (False, False), "latex": (True, False), "pdf": (True, True)}[fmt]
        assert cfg.author == "Ada"
        count += 1
    assert count == 36


def test_rejects_unknown_flags_with_exit_2(tmp_path: Path) -> None:
    """An unknown flag exits 2, like argparse in the old CLI and fake_cli.py."""
    proc = subprocess.run(
        [sys.executable, str(RUN_ENGINE), "--mode", "book", "-i", "x.txt", "-o", str(tmp_path), "--no-such-flag"],
        capture_output=True, text=True, cwd=REPO_ROOT, timeout=120,
    )
    assert proc.returncode == 2
    assert "unrecognized arguments: --no-such-flag" in proc.stderr
    assert subprocess.run(
        [sys.executable, str(RUN_ENGINE), "--mode", "scientist"], capture_output=True, cwd=REPO_ROOT, timeout=120
    ).returncode == 2


def test_legacy_tex_is_accepted_and_ignored(tmp_path: Path) -> None:
    """`--legacy-tex` is accepted and has no effect (Markdown-first only)."""
    parser = build_parser()
    base = ["--mode", "book", "-i", "x.txt", "-o", str(tmp_path), "--export-tex"]
    with_flag = RunConfig.from_args(parser.parse_args(base + ["--legacy-tex"]), {})
    without = RunConfig.from_args(parser.parse_args(base), {})
    assert {k: v for k, v in with_flag.describe().items()} == without.describe()


def test_missing_input_file_fails_non_zero(tmp_path: Path) -> None:
    """A missing `-i` file exits non-zero without a traceback."""
    proc = subprocess.run(
        [sys.executable, str(RUN_ENGINE), "--mode", "book", "-i", str(tmp_path / "nope.txt"), "-o", str(tmp_path / "out"), "--use-txt"],
        capture_output=True, text=True, cwd=REPO_ROOT, timeout=120, env={**engine_env(tmp_path), "PATH": os.environ.get("PATH", "")},
    )
    assert proc.returncode == 2
    assert "input file not found" in proc.stdout and "Traceback" not in proc.stdout + proc.stderr
    meta = (tmp_path / "out" / "run_meta.json").read_text(encoding="utf-8")
    assert "input file not found" in meta


@pytest.mark.parametrize("interactive_env", [{}, {"AUTOGENBOOK_NONINTERACTIVE": "1", "AUTOGENBOOK_ASSUME_YES": "1"}])
def test_never_reads_stdin(tmp_path: Path, interactive_env: dict[str, str]) -> None:
    """Runs with stdin closed and AUTOGENBOOK_NONINTERACTIVE/ASSUME_YES set or unset."""
    work = copy_legacy_work_dir(tmp_path)
    env = {k: v for k, v in engine_env(tmp_path).items() if not k.startswith("AUTOGENBOOK_NONINTERACTIVE")}
    env.update(interactive_env)
    env["PATH"] = os.environ.get("PATH", "")
    proc = subprocess.run(
        [sys.executable, str(RUN_ENGINE), "--mode", "book", "-i", str(work / "book_input.txt"), "-o", str(work / "out"),
         "--use-txt", "--resume", "--no-tex", "--no-pdf"],
        stdin=subprocess.DEVNULL, capture_output=True, text=True, cwd=REPO_ROOT, timeout=300, env=env,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
