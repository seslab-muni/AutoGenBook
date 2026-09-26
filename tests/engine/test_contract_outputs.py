"""Contract 3.1/3.4: output formats markdown / latex / pdf.

One test per contract item of docs/ENGINE_REWRITE.md section 3. Skipped until
the phase that implements it (#151).
"""

from __future__ import annotations

import pytest


def test_markdown_format() -> None:
    """--no-tex --no-pdf: final .md with an **Author:** line, no .tex/.pdf."""
    pytest.skip("pending: implemented in phase #151")


def test_latex_format() -> None:
    """--export-tex --no-pdf: .md and .tex."""
    pytest.skip("pending: implemented in phase #151")


def test_pdf_format() -> None:
    """--export-tex: .md, .tex and .pdf."""
    pytest.skip("pending: implemented in phase #151")


def test_audit_strict_exits_4() -> None:
    """--audit-book --audit-book-mode strict with an unknown citation exits 4 and writes audit_report.json."""
    pytest.skip("pending: implemented in phase #151")
