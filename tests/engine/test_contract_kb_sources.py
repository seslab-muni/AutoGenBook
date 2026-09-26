"""Contract 3.4: kb_sources.json.

One test per contract item of docs/ENGINE_REWRITE.md section 3. Skipped until
the phase that implements it (#152).
"""

from __future__ import annotations

import pytest


def test_shape_cite_keys_rids_chunks() -> None:
    """`cite_keys{}`, `rids{}` -> `{source_path, loc, excerpt}`; `chunks[]`."""
    pytest.skip("pending: implemented in phase #152")


def test_chunk_source_path_parent_is_the_source_id() -> None:
    """`Path(chunk.source_path).parent.name` is the kb/<source_id> directory."""
    pytest.skip("pending: implemented in phase #152")


def test_ids_follow_the_stable_naming() -> None:
    """`RID:kb:<source_id>:<loc_key>:<j>` and `kb_<source_id>_<loc>_<j>`."""
    pytest.skip("pending: implemented in phase #152")
