"""Golden book run (#153): the English benchmark spec with its two-file KB,
run against recorded LLM replies and compared with committed outputs. Catches
accidental prompt drift (a changed prompt has no recorded reply) and assembly
drift (changed files). The run must also be identical at concurrency 1 and 4.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from fake_llm import FakeLLM
from golden import UPDATE, assert_matches, responses_path, snapshot, write_expected
from helpers import api_run, make_work_dir

NAME = "book_en"


@pytest.mark.parametrize("concurrency", [1, 4])
def test_golden_book_run(tmp_path: Path, concurrency: int) -> None:
    work = make_work_dir(tmp_path, name="golden_run")
    if UPDATE and concurrency == 1:
        fake = FakeLLM(record_to=responses_path(NAME))
    else:
        fake = FakeLLM(recorded=responses_path(NAME))
    run = api_run(work, fake, outline="generate", output_format="markdown", extra=["--concurrency", str(concurrency)])
    fake.flush_recording()
    assert run.exit_code == 0, run.text
    files = snapshot(run.out_dir, work)
    if UPDATE and concurrency == 1:
        write_expected(NAME, files)
    assert_matches(NAME, files)
