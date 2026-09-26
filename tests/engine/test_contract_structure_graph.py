"""Contract 3.4: out/structure_graph.json.

One test per contract item of docs/ENGINE_REWRITE.md section 3. Skipped until
the phase that implements it (#153).
"""

from __future__ import annotations

import pytest


def test_shape_graph_nodes_edges() -> None:
    """`{graph, nodes, edges}`; graph.input_sha256/input_path; edges are [parent, child] rooted at 'book'."""
    pytest.skip("pending: implemented in phase #153")


def test_keys_are_dfs_ordered_dash_paths() -> None:
    """Node keys `book`, `1`, `1-2`, ... in DFS order."""
    pytest.skip("pending: implemented in phase #153")


def test_node_fields_the_api_reads() -> None:
    """title/summary/n_pages/content_file_path/kb_scope/kb_sources/content_locked/structure_locked/content_file survive."""
    pytest.skip("pending: implemented in phase #153")


def test_content_file_path_is_set_only_when_the_section_exists() -> None:
    """Absolute path, set after `sections/<key>.md` is written."""
    pytest.skip("pending: implemented in phase #153")


def test_writes_are_atomic_while_polled() -> None:
    """A poller reading once per ms never sees invalid JSON."""
    pytest.skip("pending: implemented in phase #153")
