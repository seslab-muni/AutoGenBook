"""The API's own adapter driving run_engine.py end to end.

`api/infrastructure/cli/book_command.build_command` builds the argv/env,
`subprocess_runner.run` starts `run_engine.py` exactly as the worker does
(cwd = repo root, stderr merged, own session, graph watcher), and the result
is read back with `artifacts.collect_artifact_paths` and `graph_import`. The
LLM is the fake, served over a loopback socket.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from api.application.graph_import import _extract_citations, _load_section_review
from api.domain.models import ArtifactKind
from api.infrastructure.cli import subprocess_runner
from api.infrastructure.cli.artifacts import collect_artifact_paths
from fake_llm import FakeLLM
from helpers import api_argv, engine_env, make_work_dir


def _run_via_api(work: Path, fake: FakeLLM, **options):
    events = []
    with fake.serve() as base_url:
        argv, env = api_argv(work, **options)
        env = {**env, **engine_env(work.parent), "AUTOGENBOOK_LLM_BASE_URL": base_url, "PATH": os.environ.get("PATH", "")}
        code = subprocess_runner.run(argv, env, str(Path(argv[1]).parent), work, events.append, poll_interval_s=0.1, timeout_s=600)
    return code, events


def test_subprocess_runner_streams_events_and_sections(tmp_path: Path) -> None:
    """`subprocess_runner.run` emits a 'section' event per leaf and classified log events."""
    work = make_work_dir(tmp_path)
    code, events = _run_via_api(work, FakeLLM(), outline="generate")
    assert code == 0, [e.message for e in events][-20:]
    graph = json.loads((work / "out" / "structure_graph.json").read_text(encoding="utf-8"))
    parents = {p for p, _c in graph["edges"]}
    leaves = {k for k in graph["nodes"] if k != "book" and k not in parents}
    section_keys = [e.payload["nodeKey"] for e in events if e.stage == "section"]
    assert sorted(section_keys) == sorted(leaves) and len(section_keys) == len(set(section_keys))
    stages = {e.stage for e in events}
    assert {"kb", "json", "subdivide", "generate", "markdown", "tokens", "cost"} <= stages
    assert "log" not in stages  # every line carried a contract prefix
    assert all(e.level != "error" for e in events)
    assert [e.seq for e in events] == sorted(e.seq for e in events)
    assert (work / "out" / "logs" / "cli_stdout.log").read_text(encoding="utf-8").startswith("[KB]")


async def test_artifacts_are_classified_and_citations_imported(tmp_path: Path) -> None:
    """`collect_artifact_paths` finds the book by extension; `_extract_citations` resolves citations."""
    work = make_work_dir(tmp_path)
    code, _events = _run_via_api(work, FakeLLM(), outline="generate", output_format="latex")
    assert code == 0
    out = work / "out"
    kinds: dict[ArtifactKind, list[str]] = {}
    for rel, kind in collect_artifact_paths(out):
        kinds.setdefault(kind, []).append(str(rel))
    assert len(kinds[ArtifactKind.markdown]) == 1
    assert kinds[ArtifactKind.structure_graph] == ["structure_graph.json"]
    assert kinds[ArtifactKind.kb_sources] == ["kb_sources.json"] and kinds[ArtifactKind.run_meta] == ["run_meta.json"]
    assert kinds[ArtifactKind.llm_usage] == ["llm_usage.jsonl"]
    assert kinds[ArtifactKind.section] and kinds[ArtifactKind.section_review]
    assert not any(rel.startswith(".kb_cache") for rels in kinds.values() for rel in rels)  # engine state is not uploaded
    if ArtifactKind.tex in kinds:
        assert len(kinds[ArtifactKind.tex]) == 1
    kb_index = json.loads((out / "kb_sources.json").read_text(encoding="utf-8"))
    cited = 0
    for rel in kinds[ArtifactKind.section]:
        cited += len(_extract_citations((out / rel).read_text(encoding="utf-8"), kb_index))
        review = await _load_section_review(out, Path(rel).stem)
        assert review is None or "notes" in review
    assert cited > 0
