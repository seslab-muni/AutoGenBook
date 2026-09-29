"""Golden paper run (#155): the English paper benchmark spec with its KB and
one verified web reference, run against recorded LLM replies and compared
with committed outputs, at concurrency 1 and 4."""

from __future__ import annotations

from pathlib import Path

import pytest

from fake_llm import FakeLLM
from golden import UPDATE, assert_matches, responses_path, snapshot, write_expected
from helpers import engine_env, make_work_dir, run_cli
from test_contract_paper import EDVAC_DOI, TAVILY

NAME = "paper_en"


@pytest.mark.parametrize("concurrency", [1, 4])
def test_golden_paper_run(tmp_path: Path, concurrency: int) -> None:
    work = make_work_dir(tmp_path, bench="en_paper", name="golden_run")
    web = {"tavily_results": TAVILY, "resolvable_urls": {f"https://doi.org/{EDVAC_DOI}"}}
    if UPDATE and concurrency == 1:
        fake = FakeLLM(record_to=responses_path(NAME), **web)
    else:
        fake = FakeLLM(recorded=responses_path(NAME), **web)
    argv = ["--mode", "paper", "--paper-input", str(work / "paper_input.txt"), "-o", str(work / "out"), "--kb-dir", str(work / "kb"),
            "--use-txt", "--enable-web-rag", "--no-tex", "--no-pdf", "--concurrency", str(concurrency)]
    run = run_cli(argv, fake=fake, env=engine_env(tmp_path, TAVILY_API_KEY="tvly-fake"))
    fake.flush_recording()
    assert run.exit_code == 0, run.text
    files = snapshot(run.out_dir, work)
    if UPDATE and concurrency == 1:
        write_expected(NAME, files)
    assert_matches(NAME, files)
