"""Contract 3.4: kb_sources.json.

Built the way a run builds it, from a `kb/<source_id>/<file>` tree laid out
like `GenerationService._download_sources`, and read back with the API's own
functions (`graph_import._extract_citations`, `_sync_source_chunk_counts`'
parent-directory rule).
"""

from __future__ import annotations

import re
import shutil
import uuid
from pathlib import Path

from api.application.graph_import import _extract_citations
from engine.retrieval.extract import ExtractOptions
from engine.retrieval.kb import KnowledgeBase

REPO = Path(__file__).resolve().parents[2]
BENCH = REPO / "input" / "bench" / "cs_book" / "kb"


def _api_layout(tmp_path: Path) -> tuple[Path, dict[str, str]]:
    kb = tmp_path / "kb"
    ids: dict[str, str] = {}
    for src in sorted(BENCH.rglob("*.*")):
        source_id = str(uuid.uuid5(uuid.NAMESPACE_URL, src.name))
        (kb / source_id).mkdir(parents=True)
        shutil.copyfile(src, kb / source_id / src.name)
        ids[src.name] = source_id
    return kb, ids


def _index(tmp_path: Path) -> tuple[dict, dict[str, str]]:
    kb_dir, ids = _api_layout(tmp_path)
    kb = KnowledgeBase.build(kb_dir, cache_dir=tmp_path / ".kb_cache", extract_options=ExtractOptions())
    return kb.kb_sources_json(), ids


def test_shape_cite_keys_rids_chunks(tmp_path: Path) -> None:
    """`cite_keys{}`, `rids{}` -> `{source_path, loc, excerpt}`; `chunks[]`."""
    index, _ids = _index(tmp_path)
    assert set(index) >= {"cite_keys", "rids", "page_keys", "chunks"}
    assert index["chunks"]
    for chunk in index["chunks"]:
        assert {"source_path", "loc", "rid", "cite_key", "excerpt"} <= set(chunk)
        assert index["cite_keys"][chunk["cite_key"]] == {k: chunk[k] for k in ("source_path", "loc", "excerpt")}
        assert index["rids"][chunk["rid"]] == {k: chunk[k] for k in ("source_path", "loc", "excerpt")}
        assert len(chunk["excerpt"].split()) <= 12 and len(chunk["excerpt"]) <= 120
    # What the API does with a section citing the first key.
    key = index["chunks"][0]["cite_key"]
    [citation] = _extract_citations(f"A claim [{key}].", index)
    assert citation["id"] == key and citation["sourceDoc"] in {"genai_teaching_guide.md", "assessment_and_integrity.pdf"}


def test_chunk_source_path_parent_is_the_source_id(tmp_path: Path) -> None:
    """`Path(chunk.source_path).parent.name` is the kb/<source_id> directory."""
    index, ids = _index(tmp_path)
    counts: dict[str, int] = {}
    for chunk in index["chunks"]:
        counts[Path(chunk["source_path"]).parent.name] = counts.get(Path(chunk["source_path"]).parent.name, 0) + 1
        assert Path(chunk["source_path"]).is_absolute()
    assert set(counts) == set(ids.values()) and all(n > 0 for n in counts.values())


def test_ids_follow_the_stable_naming(tmp_path: Path) -> None:
    """`RID:kb:<source_id>:<loc_key>:<j>` and `kb_<source_id>_<loc>_<j>`."""
    index, _ids = _index(tmp_path)
    for chunk in index["chunks"]:
        pdf = chunk["source_path"].endswith(".pdf")
        loc_re = r"page (\d+), chunk (\d+)" if pdf else r"chunk (\d+)"
        match = re.fullmatch(loc_re, chunk["loc"])
        assert match, chunk["loc"]
        loc_key = f"page_{match.group(1)}" if pdf else "chunk"
        j = match.group(2) if pdf else match.group(1)
        sid = re.fullmatch(rf"RID:kb:(.+):{loc_key}:{j}", chunk["rid"]).group(1)
        assert re.fullmatch(r"[a-z0-9_]+_[0-9a-f]{8}", sid)
        assert chunk["cite_key"] == f"kb_{sid}_{loc_key}_{j}"
