"""Contract 3.5: run kinds and resume semantics.

One test per contract item of docs/ENGINE_REWRITE.md section 3. Skipped until
the phase that implements it (#153).
"""

from __future__ import annotations

import pytest


def test_full_run() -> None:
    """Fresh work dir, no --resume: every leaf generated."""
    pytest.skip("pending: implemented in phase #153")


def test_retry_skips_existing_sections() -> None:
    """--resume skips leaves whose section file exists and whose input hash matches."""
    pytest.skip("pending: implemented in phase #153")


def test_regenerate_one_node() -> None:
    """API deletes sections/<key>.md, clears content_file_path, appends Writing instructions: exactly that leaf is regenerated, with the instructions."""
    pytest.skip("pending: implemented in phase #153")


def test_export_generates_nothing() -> None:
    """--resume --export-tex: zero LLM calls, only assembly."""
    pytest.skip("pending: implemented in phase #153")


def test_resume_refused_when_input_hash_differs() -> None:
    """A changed book_input.txt refuses resume and rebuilds the outline."""
    pytest.skip("pending: implemented in phase #153")


def test_content_locked_leaf_is_copied_verbatim() -> None:
    """content_locked + content_file: bytes copied, no LLM call for that leaf."""
    pytest.skip("pending: implemented in phase #153")
