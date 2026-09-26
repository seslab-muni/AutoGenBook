"""Contract 3.4: section_reviews/<key>.json and <key>_revised.json.

One test per contract item of docs/ENGINE_REWRITE.md section 3. Skipped until
the phase that implements it (#153).
"""

from __future__ import annotations

import pytest


def test_review_json_has_issues_fields() -> None:
    """`issues[] {severity, type, description, required_fix}`."""
    pytest.skip("pending: implemented in phase #153")


def test_revised_json_written_after_revision_and_consistency() -> None:
    """`_revised.json` after revision and with consistency findings merged in."""
    pytest.skip("pending: implemented in phase #153")
