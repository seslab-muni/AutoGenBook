"""Contract 3.3: stdout protocol (prefixes, line buffering).

One test per contract item of docs/ENGINE_REWRITE.md section 3. Skipped until
the phase that implements it (#151).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from api.infrastructure.cli.stdout_parser import PREFIX_TABLE, parse_line
from helpers import copy_legacy_work_dir, requires_pandoc, run_cli


def _export_lines(tmp_path: Path, *flags: str) -> list[str]:
    work = copy_legacy_work_dir(tmp_path)
    run = run_cli(["--mode", "book", "-i", str(work / "book_input.txt"), "-o", str(work / "out"), "--use-txt", "--resume", *flags], tmp_path=tmp_path)
    assert run.exit_code == 0, run.text
    return run.lines


def test_lines_use_contract_prefixes(tmp_path: Path) -> None:
    """Progress lines classify through the API's own `stdout_parser.parse_line`."""
    from fake_llm import FakeLLM
    from helpers import api_run, make_work_dir

    run = api_run(make_work_dir(tmp_path), FakeLLM(), outline="generate")
    assert run.exit_code == 0
    for line in run.lines:
        stage, level, _message = parse_line(line)
        assert stage != "log", f"unprefixed line: {line!r}"
        assert any(line.startswith(prefix) for prefix in PREFIX_TABLE)


def test_full_run_emits_expected_stages(tmp_path: Path) -> None:
    """A full run prints [KB] [JSON] [SUBDIVIDE] [GEN] [MD] [TOKENS] [COST]."""
    import re

    from fake_llm import FakeLLM
    from helpers import api_run, make_work_dir

    run = api_run(make_work_dir(tmp_path), FakeLLM(), outline="generate")
    stages = {parse_line(line)[0] for line in run.lines}
    assert {"kb", "json", "subdivide", "generate", "markdown", "tokens", "cost"} <= stages
    starting = [l for l in run.lines if re.match(r"\[GEN\] \d+/\d+ Starting section '.+'$", l)]
    generated = [l for l in run.lines if re.match(r"\[GEN\] \d+/\d+ Generated section '.+'$", l)]
    assert starting and len(starting) == len(generated)
    assert run.lines[-2].startswith("[TOKENS]") and run.lines[-1].startswith("[COST]")


@requires_pandoc
def test_export_run_emits_latex_and_pdf_stages(tmp_path: Path) -> None:
    """An export run prints [RESUME] [MD] [LATEX] (and [PDF])."""
    lines = _export_lines(tmp_path, "--export-tex", "--no-pdf")
    stages = {parse_line(line)[0] for line in lines}
    assert {"resume", "markdown", "latex", "tokens", "cost"} <= stages
    for line in lines:
        stage, level, _message = parse_line(line)
        assert stage != "log" or line.startswith("ERROR") is False, line


def test_output_is_line_buffered_utf8(tmp_path: Path) -> None:
    """Lines arrive one by one while the run is going (PYTHONUNBUFFERED is not required)."""
    import os
    import subprocess
    import sys
    import time

    from fake_llm import FakeLLM
    from helpers import REPO_ROOT, api_argv, engine_env, make_work_dir

    work = make_work_dir(tmp_path)
    fake = FakeLLM(latency_s=0.05)
    with fake.serve() as base_url:
        argv, env = api_argv(work, outline="generate")
        env = {**env, **engine_env(tmp_path), "AUTOGENBOOK_LLM_BASE_URL": base_url, "PATH": os.environ.get("PATH", "")}
        env.pop("PYTHONUNBUFFERED", None)
        env["LANG"] = "C"  # not a UTF-8 locale: the engine must still write UTF-8
        proc = subprocess.Popen([sys.executable] + argv[1:], cwd=REPO_ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        first = proc.stdout.readline()
        first_seen = time.monotonic()
        rest = proc.stdout.read()
        proc.wait(timeout=300)
        finished = time.monotonic()
    assert proc.returncode == 0, rest.decode("utf-8", "replace")
    assert first.startswith(b"[KB]")
    assert finished - first_seen > 0.2  # the first line was delivered long before the end
    (rest + first).decode("utf-8")  # strict UTF-8
