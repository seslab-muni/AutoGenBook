"""Contract 3.4: section_reviews/<key>.json and <key>_revised.json."""

from __future__ import annotations

import json
from pathlib import Path

from api.application.graph_import import _format_review_issue
from fake_llm import FakeLLM
from helpers import api_run, make_work_dir
from responders import node_key_of

FIELDS = {"severity", "type", "description", "required_fix"}


def _run(tmp_path: Path):
    work = make_work_dir(tmp_path)
    fake = FakeLLM()
    run = api_run(work, fake, outline="generate")
    assert run.exit_code == 0, run.text
    return run, fake


def test_review_json_has_issues_fields(tmp_path: Path) -> None:
    """`issues[] {severity, type, description, required_fix}`."""
    run, _fake = _run(tmp_path)
    reviews = sorted((run.out_dir / "section_reviews").glob("*.json"))
    base = [p for p in reviews if not p.stem.endswith("_revised")]
    assert {p.stem for p in base} == {p.stem for p in (run.out_dir / "sections").glob("*.md")}
    for path in reviews:
        data = json.loads(path.read_text(encoding="utf-8"))
        assert isinstance(data["issues"], list)
        for issue in data["issues"]:
            assert FIELDS <= set(issue) and issue["severity"] in {"minor", "major", "critical"}
            assert _format_review_issue(issue).startswith(f"[{issue['severity']}]")


def test_revised_json_written_after_revision_and_consistency(tmp_path: Path) -> None:
    """`_revised.json` after revision and with consistency findings merged in."""
    run, fake = _run(tmp_path)
    revised = {p.stem.removesuffix("_revised") for p in (run.out_dir / "section_reviews").glob("*_revised.json")}
    rejected = {node_key_of(c.prompt) for c in fake.chat_calls("SectionRevision")} - {None}
    assert rejected and rejected <= revised  # every revised section got its final review
    report = json.loads((run.out_dir / "consistency_report.json").read_text(encoding="utf-8"))
    assert report["findings"]
    for finding in report["findings"]:
        for key in finding["node_keys"]:
            data = json.loads((run.out_dir / "section_reviews" / f"{key}_revised.json").read_text(encoding="utf-8"))
            assert any(i["type"] == f"consistency:{finding['type']}" and i["description"] == finding["description"] for i in data["issues"])
    assert report["patched"]  # at most three sections patched
    assert len(report["patched"]) <= 3
