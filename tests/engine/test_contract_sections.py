"""Contract 3.4: sections/<key>.md.

One test per contract item of docs/ENGINE_REWRITE.md section 3. Skipped until
the phase that implements it (#153).
"""

from __future__ import annotations

import pytest


def test_one_file_per_leaf() -> None:
    """Every leaf has sections/<key>.md, no file for inner nodes."""
    pytest.skip("pending: implemented in phase #153")


def test_citations_are_cite_key_tokens_the_api_imports() -> None:
    """Citation tokens match `graph_import._CITATION_TOKEN_RE` and resolve in kb_sources.json."""
    pytest.skip("pending: implemented in phase #153")
