"""Golden presentation run (#156): the English presentation benchmark spec
with its KB, run against recorded LLM replies (TTS answered live by the fake
endpoint) and compared with committed outputs, at concurrency 1 and 4. The
run exports every format: deck Markdown, PPTX, Beamer .tex/.pdf (when pandoc/
LuaLaTeX are installed), narration and MP3 audio with subtitles; binary
outputs are checked for presence, text outputs byte for byte."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from fake_llm import FakeLLM
from golden import UPDATE, assert_matches, responses_path, snapshot, write_expected
from helpers import engine_env, make_work_dir, run_cli

NAME = "presentation_en"
STEM = "From_Calculating_Machines_to_Stored_Programs"


@pytest.mark.parametrize("concurrency", [1, 4])
def test_golden_presentation_run(tmp_path: Path, concurrency: int) -> None:
    work = make_work_dir(tmp_path, bench="en_presentation", name="golden_run")
    if UPDATE and concurrency == 1:
        fake = FakeLLM(record_to=responses_path(NAME))
    else:
        fake = FakeLLM(recorded=responses_path(NAME))
    beamer = bool(shutil.which("pandoc"))
    pdf = beamer and bool(shutil.which("lualatex"))
    argv = ["--mode", "presentation", "-i", str(work / "presentation_input.txt"), "-o", str(work / "out"),
            "--kb-dir", str(work / "kb"), "--use-txt", "--presentation-pptx", "--presentation-tts",
            "--concurrency", str(concurrency)]
    if beamer:
        argv += ["--presentation-tex"] + ([] if pdf else ["--no-pdf"])
    run = run_cli(argv, fake=fake, env=engine_env(tmp_path))
    fake.flush_recording()
    assert run.exit_code == 0, run.text
    out = run.out_dir
    assert (out / f"{STEM}.pptx").stat().st_size > 0
    assert len(list((out / "audio").glob("slide_*.mp3"))) == 7 and (out / f"{STEM}_audio.mp3").stat().st_size > 0
    if beamer:
        assert (out / f"{STEM}.tex").exists()
    if pdf:
        assert (out / f"{STEM}.pdf").stat().st_size > 0
    files = snapshot(out, work)
    if UPDATE and concurrency == 1:
        write_expected(NAME, files)
    assert_matches(NAME, files)
