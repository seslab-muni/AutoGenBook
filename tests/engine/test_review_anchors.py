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


def test_golden_reviewer_issues_resolve_at_least_90_percent_with_the_expected_split(tmp_path: Path) -> None:
    """Acceptance criterion of #182, counted over ALL issues the reviewer emits
    (those with a `quote` key; consistency findings and the engine's own
    removed-citation note carry none). The fake reviewer quotes every issue; some
    quotes differ from the text the way models' do (doubled space, curly quotes,
    trailing ellipsis) and one is rewritten away by the fake reviser."""
    import responders

    run = _run(tmp_path)
    total, anchored, orphans, variants = 0, 0, [], set()
    for path in _review_files(run):
        key = _key(path)
        body = _section(run, key)
        for issue in json.loads(path.read_text(encoding="utf-8"))["issues"]:
            if "quote" not in issue:
                continue
            total += 1
            if issue["start"] is None:
                orphans.append((path.name, issue["type"]))
                continue
            anchored += 1
            assert body[issue["start"]:issue["end"]] == issue["quote"]
            for noise in ("\u201c", "\u201d", "\u2026", "  "):
                assert noise not in issue["quote"]  # rewritten to the text's own spelling
            if issue["type"] == "coverage":
                variants.add(responders.stable_int("quote-variant", key) % 4)
    assert (total, anchored) == (24, 23)
    assert orphans == [("3-2-1.json", "redundancy")]
    assert anchored / total >= 0.9
    assert variants == {0, 1, 2, 3}  # exact, whitespace, curly-quote and ellipsis variants all resolved


def test_quote_less_issues_stay_unanchored_and_foreign_offsets_are_dropped(tmp_path: Path) -> None:
    import responders

    def review(call):
        out = responders.section_review(call)
        out["issues"] = [
            {"type": "style", "severity": "minor", "description": "whole-section remark", "required_fix": "tighten", "quote": "", "replace_from": "", "replace_to": ""},
            {**out["issues"][0], "quote": "a sentence that appears nowhere in the section at all"},
        ]
        return out

    work = make_work_dir(tmp_path)
    run = api_run(work, FakeLLM(overrides={"SectionReview": review}), outline="generate")
    assert run.exit_code == 0, run.text
    for path in _review_files(run):
        for issue in json.loads(path.read_text(encoding="utf-8"))["issues"]:
            if "quote" in issue:
                assert issue["start"] is None and issue["end"] is None


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


def test_locked_leaf_review_offsets_are_re_resolved_on_resume(tmp_path: Path) -> None:
    """A content-locked leaf keeps the review files of an earlier run; the lock
    is materialised again on resume, so their offsets must index that text."""
    from helpers import project_structure, write_project

    work = make_work_dir(tmp_path)
    locked_rel = "locked_sections/5f1c.md"
    text = "ENIAC was completed in 1945. Curated text that must be kept byte for byte.\n\n* keep me *\n"
    write_project(work, project_structure(locked_file=locked_rel), {locked_rel: text})
    assert api_run(work, FakeLLM(), outline="project").exit_code == 0
    review = work / "out" / "section_reviews" / "2-1.json"
    review.parent.mkdir(exist_ok=True)
    stale = {"ok_to_keep": True, "issues": [
        {"type": "coverage", "severity": "minor", "description": "d", "required_fix": "f",
         "quote": "Curated text that must be kept byte for byte.", "start": 500, "end": 545},
        {"type": "style", "severity": "minor", "description": "no quote", "required_fix": "f", "start": 7, "end": 9},
        {"type": "style", "severity": "minor", "description": "gone", "required_fix": "f", "quote": "a sentence that is no longer there", "start": 1, "end": 5},
    ]}
    review.write_text(json.dumps(stale), encoding="utf-8")
    run = api_run(work, FakeLLM(), outline="project", resume=True)
    assert run.exit_code == 0, run.text
    body = (run.out_dir / "sections" / "2-1.md").read_text(encoding="utf-8")
    issues = json.loads(review.read_text(encoding="utf-8"))["issues"]
    assert issues[0]["start"] == body.index("Curated") and body[issues[0]["start"]:issues[0]["end"]] == issues[0]["quote"]
    assert issues[1]["start"] is None and issues[1]["end"] is None  # offsets without a quote are dropped
    assert issues[2]["start"] is None and issues[2]["end"] is None


async def test_null_fields_from_a_json_object_provider_do_not_trigger_a_repair_call(tmp_path: Path) -> None:
    from engine.agents.models import SectionReview
    from engine.config import LLMSettings
    from engine.events import MemorySink
    from engine.llm.client import LLMClient
    from engine.llm.usage import UsageLedger

    def review(call):
        return {"ok_to_keep": True, "suggested_edits": [], "retrieval_queries": [], "issues": [
            {"type": "style", "severity": "minor", "description": "d", "required_fix": "f",
             "quote": None, "replace_from": None, "replace_to": None, "start": 5, "end": 9},
            {"type": "style", "severity": "minor", "description": "d", "required_fix": "f", "quote": 7, "start": 3},
        ]}

    fake = FakeLLM(supports=("json_object",), overrides={"SectionReview": review})
    client = LLMClient(
        LLMSettings(base_url="http://fake.local/v1", api_key="k", model="m", mini_model="m", pricing_disabled=True),
        ledger=UsageLedger(None), sink=MemorySink(), concurrency=2, transport=fake.transport(),
    )
    try:
        out = await client.structured([{"role": "user", "content": "review"}], SectionReview, label="t")
    finally:
        await client.aclose()
    assert len([c for c in fake.chat_calls("SectionReview") if c.status == 200]) == 1  # accepted at once: no repair round trip
    for issue in out.issues:
        assert (issue.quote, issue.replace_from, issue.replace_to, issue.start, issue.end) == ("", "", "", None, None)


def test_replace_pair_follows_the_text_or_is_dropped(tmp_path: Path) -> None:
    """`_anchor_reviews` rewrites the quote to the matched text; a replacement
    pair that no longer applies to it is cleared, one that applies is kept
    (adjusted to the text's own spelling)."""
    from engine.pipeline.book import BookRun

    class Stub:
        pass

    from engine.pipeline.context import Paths

    out = tmp_path / "out"
    (out / "sections").mkdir(parents=True)
    (out / "section_reviews").mkdir()
    (out / "sections" / "1.md").write_text("The method \u201cgenerated\u201d new content for the reader today.\n", encoding="utf-8")
    issues = [
        {"type": "t", "quote": "The method \"generated\" new content", "replace_from": "\"generated\"", "replace_to": "produced"},
        {"type": "t", "quote": "The method generated new content", "replace_from": "created", "replace_to": "made"},
        {"type": "t", "quote": "content for the reader", "replace_from": "reader", "replace_to": ""},
    ]
    (out / "section_reviews" / "1.json").write_text(json.dumps({"issues": issues}), encoding="utf-8")
    stub = Stub()
    stub.paths = Paths(out)
    BookRun._anchor_reviews(stub, "1")
    got = json.loads((out / "section_reviews" / "1.json").read_text(encoding="utf-8"))["issues"]
    text = (out / "sections" / "1.md").read_text(encoding="utf-8")
    for issue in got:
        assert text[issue["start"]:issue["end"]] == issue["quote"]
    assert got[0]["replace_from"] in got[0]["quote"] and got[0]["replace_to"] == "produced"
    assert got[1]["replace_from"] == "" and got[1]["replace_to"] == ""
    assert got[2]["replace_from"] == "reader" and got[2]["replace_to"] == ""


def test_review_issue_coerces_null_text_fields_and_drops_model_offsets() -> None:
    from engine.agents.models import ReviewIssue

    issue = ReviewIssue.model_validate({"description": "d", "quote": None, "replace_from": 3, "replace_to": None, "start": 4, "end": 9})
    assert (issue.quote, issue.replace_from, issue.replace_to, issue.start, issue.end) == ("", "", "", None, None)


def test_reviser_view_is_unchanged_for_quote_less_issues_and_keeps_an_empty_replacement_target() -> None:
    from engine.agents.models import ReviewIssue, SectionReview
    from engine.pipeline.text import dumps

    review = SectionReview(ok_to_keep=False, issues=[ReviewIssue(type="coverage", severity="major", description="d", required_fix="f")],
                           suggested_edits=["e"], retrieval_queries=["q"])
    legacy = {"ok_to_keep": False, "issues": [{"type": "coverage", "severity": "major", "description": "d", "required_fix": "f"}],
              "suggested_edits": ["e"], "retrieval_queries": ["q"]}
    assert dumps(review.for_reviser()) == dumps(legacy)  # the full-run reviser prompt is byte-identical for these
    delete = SectionReview(issues=[ReviewIssue(description="d", quote="the very big dog", replace_from="very big ", replace_to="")])
    assert delete.for_reviser()["issues"][0]["replace_to"] == "" and delete.for_reviser()["issues"][0]["replace_from"] == "very big "
