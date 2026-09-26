"""The API's own adapter driving run_engine.py end to end.

One test per contract item of docs/ENGINE_REWRITE.md section 3. Skipped until
the phase that implements it (#153).
"""

from __future__ import annotations

import pytest


def test_subprocess_runner_streams_events_and_sections() -> None:
    """`subprocess_runner.run` emits a 'section' event per leaf and classified log events."""
    pytest.skip("pending: implemented in phase #153")


def test_artifacts_are_classified_and_citations_imported() -> None:
    """`collect_artifact_paths` finds the book by extension; `_extract_citations` resolves citations."""
    pytest.skip("pending: implemented in phase #153")
