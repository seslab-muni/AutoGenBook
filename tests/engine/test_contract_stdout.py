"""Contract 3.3: stdout protocol (prefixes, line buffering).

One test per contract item of docs/ENGINE_REWRITE.md section 3. Skipped until
the phase that implements it (#151).
"""

from __future__ import annotations

import pytest


def test_lines_use_contract_prefixes() -> None:
    """Progress lines classify through the API's own `stdout_parser.parse_line`."""
    pytest.skip("pending: implemented in phase #151")


def test_full_run_emits_expected_stages() -> None:
    """A full run prints [KB] [JSON] [SUBDIVIDE] [GEN] [MD] [TOKENS] [COST]."""
    pytest.skip("pending: implemented in phase #151")


def test_export_run_emits_latex_and_pdf_stages() -> None:
    """An export run prints [RESUME] [MD] [LATEX] (and [PDF])."""
    pytest.skip("pending: implemented in phase #151")


def test_output_is_line_buffered_utf8() -> None:
    """Lines arrive one by one while the run is going (PYTHONUNBUFFERED is not required)."""
    pytest.skip("pending: implemented in phase #151")
