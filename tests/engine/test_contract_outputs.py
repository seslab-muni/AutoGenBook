"""Contract 3.1/3.4: output formats markdown / latex / pdf.

Exercised on the assembly-only run kind over a copy of the repo's old-engine
sample run (`output/book`, legacy `.tex` sections, no kb_sources.json), which
also proves the engine can take over work dirs the old CLI produced.
"""

from __future__ import annotations

import json
from pathlib import Path

from fake_llm import FakeLLM
from helpers import copy_legacy_work_dir, requires_lualatex, requires_pandoc, run_cli

STEM = "METODICKÁ_PŘÍRUČKA__AI_VE_VÝUCE_VUT_"


def _export(tmp_path: Path, *flags: str):
    work = copy_legacy_work_dir(tmp_path)
    for stale in (work / "out").glob(f"{STEM}.*"):
        stale.unlink()
    fake = FakeLLM()
    run = run_cli(
        ["--mode", "book", "-i", str(work / "book_input.txt"), "-o", str(work / "out"), "--use-txt", "--resume", *flags],
        fake=fake, tmp_path=tmp_path,
    )
    assert fake.calls == []  # assembly only: no model request at all
    return run


def test_markdown_format(tmp_path: Path) -> None:
    """--no-tex --no-pdf: final .md with an **Author:** line, no .tex/.pdf."""
    run = _export(tmp_path, "--no-tex", "--no-pdf")
    assert run.exit_code == 0, run.text
    out = run.out_dir
    md = (out / f"{STEM}.md").read_text(encoding="utf-8")
    assert md.startswith('# METODICKÁ PŘÍRUČKA "AI VE VÝUCE VUT"\n\n**Author:** Petr Koňas, OpenAI-GPT-5-mini\n')
    assert "\\cite{" not in md  # resolved to numbered references
    assert "## Použitá literatura" in md
    assert not (out / f"{STEM}.tex").exists() and not (out / f"{STEM}.pdf").exists()


@requires_pandoc
def test_latex_format(tmp_path: Path) -> None:
    """--export-tex --no-pdf: .md and .tex."""
    run = _export(tmp_path, "--export-tex", "--no-pdf")
    assert run.exit_code == 0, run.text
    tex = (run.out_dir / f"{STEM}.tex").read_text(encoding="utf-8")
    assert "\\documentclass" in tex and "\\chapter" in tex and "\\cite{" not in tex
    assert (run.out_dir / f"{STEM}.md").exists() and not (run.out_dir / f"{STEM}.pdf").exists()
    assert any(line.startswith("[LATEX]") for line in run.lines)


@requires_lualatex
def test_pdf_format(tmp_path: Path) -> None:
    """--export-tex: .md, .tex and .pdf."""
    run = _export(tmp_path, "--export-tex")
    assert run.exit_code == 0, run.text
    pdf = run.out_dir / f"{STEM}.pdf"
    assert pdf.read_bytes().startswith(b"%PDF") and pdf.stat().st_size > 10_000
    assert any(line.startswith("[PDF]") for line in run.lines)
    # LuaLaTeX ran in a private dir: no .aux/.toc of ours in out/ (the stale
    # ones from the old engine were removed by _export).
    assert not (run.out_dir / f"{STEM}.aux").exists()


def test_audit_strict_exits_4(tmp_path: Path) -> None:
    """--audit-book --audit-book-mode strict with an unknown citation exits 4 and writes audit_report.json."""
    run = _export(tmp_path, "--export-tex", "--audit-book", "--audit-book-mode", "strict")
    assert run.exit_code == 4
    report = json.loads((run.out_dir / "audit_report.json").read_text(encoding="utf-8"))
    assert report["counts_by_severity"]["error"] > 0
    assert any(f["code"] == "UNKNOWN_CITE_KEY" for f in report["findings"])
    assert not (run.out_dir / f"{STEM}.pdf").exists()  # strict mode blocks the PDF
    assert "strict" in (run.run_meta()["error"] or "")
