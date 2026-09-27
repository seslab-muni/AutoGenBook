"""Contract 3.5: run kinds and resume semantics.

One test per contract item of docs/ENGINE_REWRITE.md section 3. Skipped until
the phase that implements it (#153).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from fake_llm import FakeLLM
from helpers import copy_legacy_work_dir, run_cli


def test_full_run() -> None:
    """Fresh work dir, no --resume: every leaf generated."""
    pytest.skip("pending: implemented in phase #153")


def test_retry_skips_existing_sections() -> None:
    """--resume skips leaves whose section file exists and whose input hash matches."""
    pytest.skip("pending: implemented in phase #153")


def test_regenerate_one_node() -> None:
    """API deletes sections/<key>.md, clears content_file_path, appends Writing instructions: exactly that leaf is regenerated, with the instructions."""
    pytest.skip("pending: implemented in phase #153")


def test_export_generates_nothing(tmp_path: Path) -> None:
    """--resume --export-tex: zero LLM calls, only assembly."""
    work = copy_legacy_work_dir(tmp_path)
    sections_before = {p.name: p.read_bytes() for p in (work / "out" / "sections").iterdir()}
    fake = FakeLLM()
    run = run_cli(
        ["--mode", "book", "-i", str(work / "book_input.txt"), "-o", str(work / "out"), "--use-txt", "--resume", "--export-tex", "--no-pdf"],
        fake=fake, tmp_path=tmp_path,
    )
    assert run.exit_code == 0, run.text
    assert fake.calls == [] and run.usage_lines() == []
    assert {p.name: p.read_bytes() for p in (work / "out" / "sections").iterdir()} == sections_before
    assert run.run_meta()["run_kind"] == "export"
    assert not any(line.startswith("[GEN]") and "Starting section" in line for line in run.lines)


def test_resume_refused_when_input_hash_differs() -> None:
    """A changed book_input.txt refuses resume and rebuilds the outline."""
    pytest.skip("pending: implemented in phase #153")


def test_content_locked_leaf_is_copied_verbatim() -> None:
    """content_locked + content_file: bytes copied, no LLM call for that leaf."""
    pytest.skip("pending: implemented in phase #153")
