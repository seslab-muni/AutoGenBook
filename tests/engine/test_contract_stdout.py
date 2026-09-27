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


def test_lines_use_contract_prefixes() -> None:
    """Progress lines classify through the API's own `stdout_parser.parse_line`."""
    pytest.skip("pending: implemented in phase #151")


def test_full_run_emits_expected_stages() -> None:
    """A full run prints [KB] [JSON] [SUBDIVIDE] [GEN] [MD] [TOKENS] [COST]."""
    pytest.skip("pending: implemented in phase #151")


@requires_pandoc
def test_export_run_emits_latex_and_pdf_stages(tmp_path: Path) -> None:
    """An export run prints [RESUME] [MD] [LATEX] (and [PDF])."""
    lines = _export_lines(tmp_path, "--export-tex", "--no-pdf")
    stages = {parse_line(line)[0] for line in lines}
    assert {"resume", "markdown", "latex", "tokens", "cost"} <= stages
    for line in lines:
        stage, level, _message = parse_line(line)
        assert stage != "log" or line.startswith("ERROR") is False, line


def test_output_is_line_buffered_utf8() -> None:
    """Lines arrive one by one while the run is going (PYTHONUNBUFFERED is not required)."""
    pytest.skip("pending: implemented in phase #151")
