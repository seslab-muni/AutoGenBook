"""Phase 3 of #182: reviewer issues are anchored by the engine.

The model supplies `quote` (and optionally `replace_from`/`replace_to`); the
engine resolves the quote against the section text as it lies on disk and
writes `start`/`end` (Unicode code points). The offsets must refer to the
final `sections/<key>.md`, whatever revise / length adjust / consistency did
to the body after the review."""

from __future__ import annotations

import json
from pathlib import Path

from fake_llm import FakeLLM
from helpers import api_run, make_work_dir


def _run(tmp_path: Path, mode: str = "book"):
    work = make_work_dir(tmp_path)
    run = api_run(work, FakeLLM(), outline="generate")
    assert run.exit_code == 0, run.text
    return run


def _section(run, key: str) -> str:
    # exactly what graph_import reads into content_markdown
    return (run.out_dir / "sections" / f"{key}.md").read_text(encoding="utf-8")


def _review_files(run):
    return sorted((run.out_dir / "section_reviews").glob("*.json"))


def _key(path: Path) -> str:
    return path.stem.removesuffix("_revised")


def test_issue_offsets_index_the_final_section_file(tmp_path: Path) -> None:
    run = _run(tmp_path)
    seen = 0
    for path in _review_files(run):
        body = _section(run, _key(path))
        for issue in json.loads(path.read_text(encoding="utf-8"))["issues"]:
            if not issue.get("quote"):
                assert issue.get("start") is None and issue.get("end") is None
                continue
            seen += 1
            if issue["start"] is None:
                # not stale: the quote really is gone from the final text
                assert issue["end"] is None and issue["quote"] not in body, (path.name, issue)
            else:
                assert body[issue["start"]:issue["end"]] == issue["quote"], (path.name, issue)
    assert seen


def test_at_least_90_percent_of_imported_issues_are_anchored(tmp_path: Path) -> None:
    """Acceptance criterion of #182: what the API imports (`<key>_revised.json`
    when it exists, else `<key>.json`) resolves to non-null anchors."""
    run = _run(tmp_path)
    total = anchored = 0
    reviews = {p.name for p in _review_files(run)}
    for path in _review_files(run):
        key = _key(path)
        if not path.stem.endswith("_revised") and f"{key}_revised.json" in reviews:
            continue
        body = _section(run, key)
        for issue in json.loads(path.read_text(encoding="utf-8"))["issues"]:
            if not issue.get("quote"):
                continue
            total += 1
            if issue["start"] is not None:
                assert body[issue["start"]:issue["end"]] == issue["quote"]
                anchored += 1
    assert total >= 10
    assert anchored / total >= 0.9, (anchored, total)


def test_draft_review_offsets_are_not_stale_after_revision(tmp_path: Path) -> None:
    """`<key>.json` is written on the draft; the reviser then rewrites the
    section. The draft issues are re-resolved against the final text: quotes
    that did not survive get null offsets, never the draft's."""
    import responders

    def rewrite(call):
        out = responders.respond(call)
        out["body_markdown"] = "Entirely new wording (revised) that shares nothing with the draft except being fake.\n\n" + "Another new paragraph. " * 40
        return out

    work = make_work_dir(tmp_path)
    run = api_run(work, FakeLLM(overrides={"SectionRevision": rewrite}), outline="generate")
    assert run.exit_code == 0, run.text
    gone = 0
    for path in _review_files(run):
        body = _section(run, _key(path))
        for issue in json.loads(path.read_text(encoding="utf-8"))["issues"]:
            if issue.get("quote") and issue["start"] is None:
                gone += 1
                assert issue["quote"] not in body
            if issue.get("start") is not None:
                assert body[issue["start"]:issue["end"]] == issue["quote"]
    assert gone  # the rewritten sections' draft issues are orphaned in the file


def test_replace_fields_are_preserved(tmp_path: Path) -> None:
    run = _run(tmp_path)
    issues = [i for p in _review_files(run) for i in json.loads(p.read_text(encoding="utf-8"))["issues"] if i.get("replace_from")]
    assert issues
    for issue in issues:
        assert issue["replace_to"] and issue["replace_from"] in issue["quote"]


def test_schema_sent_to_the_model_hides_offsets() -> None:
    from engine.agents.models import SectionReview
    from engine.llm.structured import json_schema_for

    schema = json_schema_for(SectionReview)
    props = schema["$defs"]["ReviewIssue"]["properties"]
    assert {"quote", "replace_from", "replace_to"} <= set(props)
    assert "start" not in props and "end" not in props
    assert schema["$defs"]["ReviewIssue"]["required"] == list(props)


def test_reviser_sees_quotes_but_never_offsets() -> None:
    from engine.agents.models import ReviewIssue, SectionReview

    plain = SectionReview(issues=[ReviewIssue(type="coverage", description="d", required_fix="f")]).for_reviser()
    assert plain["issues"] == [{"type": "coverage", "severity": "minor", "description": "d", "required_fix": "f"}]
    rich = SectionReview(issues=[ReviewIssue(description="d", quote="q", start=3, end=4, replace_from="a", replace_to="b")]).for_reviser()
    assert rich["issues"][0]["quote"] == "q" and rich["issues"][0]["replace_to"] == "b"
    assert "start" not in rich["issues"][0] and "end" not in rich["issues"][0]
