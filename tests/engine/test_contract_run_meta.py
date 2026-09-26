"""Contract 3.4: run_meta.json and llm_usage.jsonl.

One test per contract item of docs/ENGINE_REWRITE.md section 3. Skipped until
the phase that implements it (#151).
"""

from __future__ import annotations

import pytest


def test_finished_at_after_start_and_totals() -> None:
    """finished_at ISO > started; token_totals/cost_totals_usd numeric values sum to the ledger."""
    pytest.skip("pending: implemented in phase #151")


def test_error_is_written_on_failure() -> None:
    """A failed run writes `error` with the LLM client's own text."""
    pytest.skip("pending: implemented in phase #151")


def test_every_request_is_itemised() -> None:
    """Every HTTP request the fake LLM saw appears in llm_usage.jsonl."""
    pytest.skip("pending: implemented in phase #151")
