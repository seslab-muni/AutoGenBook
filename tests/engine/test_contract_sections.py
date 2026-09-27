"""Contract 3.4: sections/<key>.md."""

from __future__ import annotations

import json
from pathlib import Path

from api.application.graph_import import _CITATION_TOKEN_RE, _extract_citations
from fake_llm import FakeLLM
from helpers import api_run, make_work_dir


def _run(tmp_path: Path):
    work = make_work_dir(tmp_path)
    run = api_run(work, FakeLLM(), outline="generate")
    assert run.exit_code == 0, run.text
    return run


def test_one_file_per_leaf(tmp_path: Path) -> None:
    """Every leaf has sections/<key>.md, no file for inner nodes."""
    run = _run(tmp_path)
    data = run.graph()
    parents = {p for p, _c in data["edges"]}
    leaves = {k for k in data["nodes"] if k != "book" and k not in parents}
    files = {p.stem for p in (run.out_dir / "sections").glob("*.md")}
    assert files == leaves
    for key in leaves:
        text = (run.out_dir / "sections" / f"{key}.md").read_text(encoding="utf-8")
        assert text.strip() and not text.lstrip().startswith("#")  # body only, no title heading


def test_citations_are_cite_key_tokens_the_api_imports(tmp_path: Path) -> None:
    """Citation tokens match `graph_import._CITATION_TOKEN_RE` and resolve in kb_sources.json."""
    run = _run(tmp_path)
    kb_index = json.loads((run.out_dir / "kb_sources.json").read_text(encoding="utf-8"))
    total = 0
    for path in (run.out_dir / "sections").glob("*.md"):
        text = path.read_text(encoding="utf-8")
        assert "\\cite{" not in text and "\\footnote{" not in text
        tokens = [t for t in _CITATION_TOKEN_RE.findall(text) if t.startswith("kb_")]
        assert all(t in kb_index["cite_keys"] for t in tokens)
        citations = _extract_citations(text, kb_index)
        assert len(citations) == len(set(tokens))
        total += len(citations)
    assert total > 0
