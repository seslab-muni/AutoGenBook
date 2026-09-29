"""Contract 3.4: run_meta.json and llm_usage.jsonl.

One test per contract item of docs/ENGINE_REWRITE.md section 3. Skipped until
the phase that implements it (#151).
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

import pytest

from api.application.runs import _extract_totals, _run_meta_belongs_to_this_attempt
from helpers import copy_legacy_work_dir, run_cli


def test_finished_at_after_start_and_totals(tmp_path: Path) -> None:
    """finished_at ISO > started; token_totals/cost_totals_usd numeric values sum to the ledger."""
    from fake_llm import FakeLLM
    from helpers import api_run, make_work_dir

    started = datetime.now().astimezone()
    run = api_run(make_work_dir(tmp_path), FakeLLM(report_cost=True), outline="generate")
    assert run.exit_code == 0
    meta = run.run_meta()
    assert _run_meta_belongs_to_this_attempt(meta, started)
    ledger = run.usage_lines()
    tokens, cost = _extract_totals(meta)
    assert tokens == sum(line["total_tokens"] for line in ledger) > 0
    assert cost == pytest.approx(sum(line["cost_usd"] or 0 for line in ledger))
    assert meta["status"] == "ok" and meta["error"] is None


def test_error_is_written_on_failure(tmp_path: Path) -> None:
    """A failed run writes `error` with the LLM client's own text."""
    started = datetime.now().astimezone()
    run = run_cli(["--mode", "book", "-i", str(tmp_path / "missing.txt"), "-o", str(tmp_path / "out")], tmp_path=tmp_path)
    assert run.exit_code == 2
    meta = run.run_meta()
    assert "input file not found" in meta["error"] and meta["status"] == "error"
    assert _run_meta_belongs_to_this_attempt(meta, started)


def test_run_meta_keys_on_an_export(tmp_path: Path) -> None:
    """The keys the API reads, on a run that made no model request."""
    work = copy_legacy_work_dir(tmp_path)
    started = datetime.now().astimezone()
    run = run_cli(["--mode", "book", "-i", str(work / "book_input.txt"), "-o", str(work / "out"), "--use-txt", "--resume", "--no-tex", "--no-pdf"], tmp_path=tmp_path)
    assert run.exit_code == 0
    meta = run.run_meta()
    for key in ("finished_at", "started_at", "token_totals", "cost_totals_usd", "models", "duration_sec", "status", "error", "args"):
        assert key in meta
    assert meta["error"] is None and meta["status"] == "ok"
    assert _run_meta_belongs_to_this_attempt(meta, started)
    assert datetime.fromisoformat(meta["finished_at"]) >= datetime.fromisoformat(meta["started_at"])
    assert _extract_totals(meta) == (None, None)


def test_every_request_is_itemised(tmp_path: Path) -> None:
    """Every HTTP request the fake LLM saw appears in llm_usage.jsonl."""
    from fake_llm import Fault, FakeLLM
    from helpers import api_run, make_work_dir

    fake = FakeLLM(faults=[Fault(status=429, retry_after=0, times=2)], overrides={})
    run = api_run(make_work_dir(tmp_path), fake, outline="generate")
    assert run.exit_code == 0
    ledger = run.usage_lines()
    model_calls = [c for c in fake.calls if not c.path.endswith("/models")]
    assert len(ledger) == len(model_calls)
    assert [l["status"] for l in ledger].count(429) == 2
    assert len([l for l in ledger if l["kind"] == "chat"]) == len(fake.chat_calls())
