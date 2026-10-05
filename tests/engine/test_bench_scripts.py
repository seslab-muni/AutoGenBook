"""The benchmark harness runs end to end without any key (issue #150)."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, REPO_ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def test_bench_engines_against_the_api_fake_cli(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("FAKE_CLI_STEP_SLEEP_S", "0")
    bench = _load("bench_engines")
    out = tmp_path / "bench"
    code = bench.main(["--engine", "fake", "--input", "input/bench/cs_book", "--out", str(out)])
    assert code == 0
    report = json.loads((out / "report.json").read_text(encoding="utf-8"))
    [run] = report["runs"]
    assert run["exit_code"] == 0
    assert run["quality"]["sections_present"] == run["quality"]["leaves"] == 2
    assert run["quality"]["citation_resolution_rate"] == 1.0
    assert (out / "report.md").read_text(encoding="utf-8").startswith("# Engine benchmark")


def test_quality_metrics_units(tmp_path) -> None:
    bench = _load("bench_engines")
    assert bench.effective_lines("a\n\n" + "x" * 181) == 1 + 3
    assert bench.wilson(0.5, 0) == (0.0, 1.0)
    lo, hi = bench.wilson(0.5, 40)
    assert lo < 0.5 < hi


def test_bench_retrieval_old_baseline_on_one_kb(tmp_path) -> None:
    bench = _load("bench_retrieval")
    code = bench.main(["--retriever", "old", "--kb", "input/bench/en_book", "--out", str(tmp_path)])
    assert code == 0
    report = json.loads((tmp_path / "report.json").read_text(encoding="utf-8"))
    rows = report["results"]
    assert report["errors"] == [] and {r["set_name"] for r in rows} == {"en", "cs"}
    assert all(0.0 <= r["recall"] <= 1.0 and r["n"] >= 30 for r in rows)


def test_relevance_normalisation() -> None:
    bench = _load("bench_retrieval")
    assert bench.is_relevant("the von Neumann archi-\ntecture was", "von neumann architecture")
    assert bench.is_relevant("Příliš ŽLUŤOUČKÝ kůň", "prilis zlutoucky")
    assert not bench.is_relevant("abc", "abd")


def test_bench_engines_paper_mode_argv(tmp_path) -> None:
    bench = _load("bench_engines")
    spec = bench.prepare_work_dir(REPO_ROOT / "input" / "bench" / "en_paper", tmp_path / "w")
    assert spec["mode"] == "paper" and (tmp_path / "w" / "paper_input.txt").is_file()
    book = ["py", "run_engine.py", "--mode", "book", "-i", str(tmp_path / "w" / "book_input.txt"), "-o", "out", "--use-txt", "--export-tex"]
    argv = bench._mode_argv(book, spec, tmp_path / "w", "latex")
    assert argv[2:6] == ["--mode", "paper", "-i", str(tmp_path / "w" / "paper_input.txt")]
    assert "--export-tex" not in argv and argv[-1] == "--no-pdf"
    assert bench._mode_argv(book, spec, tmp_path / "w", "markdown")[-2:] == ["--no-tex", "--no-pdf"]


def test_bench_engines_presentation_mode_argv(tmp_path) -> None:
    bench = _load("bench_engines")
    spec = bench.prepare_work_dir(REPO_ROOT / "input" / "bench" / "en_presentation", tmp_path / "w")
    book = ["py", "run_engine.py", "--mode", "book", "-i", str(tmp_path / "w" / "book_input.txt"), "-o", "out", "--use-txt", "--no-tex", "--no-pdf"]
    argv = bench._mode_argv(book, spec, tmp_path / "w", "markdown")
    assert argv[2:6] == ["--mode", "presentation", "-i", str(tmp_path / "w" / "presentation_input.txt")]
    assert argv[-1] == "--presentation-pptx" and "--no-pdf" not in argv
    assert bench._mode_argv(book, spec, tmp_path / "w", "pdf")[-2:] == ["--presentation-pptx", "--presentation-tex"]


def test_judge_model_precedence() -> None:
    import importlib.util

    spec = importlib.util.spec_from_file_location("bench_engines_judge", REPO_ROOT / "scripts" / "bench_engines.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    env = {"AUTOGENBOOK_JUDGE_MODEL": "kimi-k3", "AUTOGENBOOK_LLM_MINI_MODEL": "mini", "AUTOGENBOOK_LLM_MODEL": "main"}
    assert module.resolve_judge_model("flag-model", env) == "flag-model"
    assert module.resolve_judge_model(None, env) == "kimi-k3"
    assert module.resolve_judge_model(None, {**env, "AUTOGENBOOK_JUDGE_MODEL": " "}) == "mini"
    assert module.resolve_judge_model(None, {"AUTOGENBOOK_LLM_MODEL": "main"}) == "main"
    assert module.resolve_judge_model(None, {}) == "openai/gpt-5-mini"
