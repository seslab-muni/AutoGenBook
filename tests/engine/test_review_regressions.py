"""Regression tests for the findings of the code review of the whole engine
diff (epic #158): resume after an interrupted subdivision, web references
across KB rebuilds, refused resume regenerating the outline, optional quality
passes, stale section files, the scheduler on long doomed chains, heading
rules, citation stripping, and the paper reference formatter."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from engine.assemble.citations import CitationIndex
from engine.graph import DocGraph
from engine.pipeline.scheduler import Scheduler, Task
from engine.pipeline.text import NO_BODY_HEADINGS, heading_rule, strip_citations
from engine.spec.models import graph_from_structure, normalize_structure
from engine.util.fs import sha256_file
from fake_llm import FakeLLM
from helpers import api_run, engine_env, make_work_dir, project_structure, run_cli
from test_contract_paper import EDVAC_DOI, TAVILY, paper_run


def _leaves(graph: dict) -> list[str]:
    parents = {p for p, _c in graph["edges"]}
    return [k for k in graph["nodes"] if k != "book" and k not in parents]


def test_resume_finishes_an_interrupted_subdivision(tmp_path: Path) -> None:
    """A graph saved after the outline but before subdivision finished is
    subdivided on --resume (no new outline), not drafted as giant leaves."""
    work = make_work_dir(tmp_path)
    structure = project_structure()
    for chapter in structure["childs"]:
        chapter["childs"] = []  # outline only: each chapter still needs splitting
        chapter["n_pages"] = 4.0
    graph = graph_from_structure(normalize_structure(structure), doc_type="book")
    graph.attrs.update({
        "engine": "engine", "subdivision_complete": False, "doc_type": "book",
        "input_path": str((work / "book_input.txt").resolve()), "input_sha256": sha256_file(work / "book_input.txt"),
    })
    (work / "out").mkdir()
    graph.save(work / "out" / "structure_graph.json")
    fake = FakeLLM()
    run = api_run(work, fake, outline="generate", resume=True)
    assert run.exit_code == 0, run.text
    assert not fake.chat_calls("BookOutline") and len(fake.chat_calls("SubdivisionPlan")) >= 2
    final = run.graph()
    assert final["graph"]["subdivision_complete"] is True
    assert all(key.count("-") >= 1 for key in _leaves(final))  # the chapters were split
    assert any("interrupted during subdivision" in line for line in run.lines)


def test_web_references_survive_a_kb_rebuild_on_resume(tmp_path: Path) -> None:
    work = make_work_dir(tmp_path)
    web = {"tavily_results": TAVILY, "resolvable_urls": {f"https://doi.org/{EDVAC_DOI}"}}
    env = {"TAVILY_API_KEY": "tvly-fake"}
    first = run_cli(["--mode", "book", "-i", str(work / "book_input.txt"), "-o", str(work / "out"), "--kb-dir", str(work / "kb"),
                     "--use-txt", "--enable-web-rag", "--no-tex", "--no-pdf"], fake=FakeLLM(**web), env=engine_env(tmp_path, **env))
    assert first.exit_code == 0, first.text
    sources = json.loads((work / "out" / "kb_sources.json").read_text(encoding="utf-8"))
    web_keys = [k for k in sources["cite_keys"] if k.startswith("web_")]
    assert web_keys
    citing = [p for p in (work / "out" / "sections").glob("*.md") if web_keys[0] in p.read_text(encoding="utf-8")]
    assert citing
    # Regenerate a different leaf: kb.build runs again and rewrites kb_sources.json.
    assert len(citing) > 1
    target = citing[-1].stem  # regenerated without web retrieval; the others keep their web citations
    (work / "out" / "sections" / f"{target}.md").unlink()
    graph = first.graph()
    graph["nodes"][target]["content_file_path"] = ""
    (work / "out" / "structure_graph.json").write_text(json.dumps(graph), encoding="utf-8")
    regen = run_cli(["--mode", "book", "-i", str(work / "book_input.txt"), "-o", str(work / "out"), "--kb-dir", str(work / "kb"),
                     "--use-txt", "--resume", "--no-tex", "--no-pdf"], fake=FakeLLM(), env=engine_env(tmp_path))
    assert regen.exit_code == 0, regen.text
    after = json.loads((work / "out" / "kb_sources.json").read_text(encoding="utf-8"))
    assert set(web_keys) <= set(after["cite_keys"])
    [doc] = [p for p in (work / "out").glob("*.md")]
    text = doc.read_text(encoding="utf-8")
    assert "<https://example.org/edvac>" in text and "Unresolved reference" not in text
    assert web_keys[0] in citing[0].read_text(encoding="utf-8")  # not stripped as unknown


def test_refused_resume_regenerates_the_outline_from_txt(tmp_path: Path) -> None:
    work = make_work_dir(tmp_path)
    argv = ["--mode", "book", "-i", str(work / "book_input.txt"), "-o", str(work / "out"), "--kb-dir", str(work / "kb"), "--no-tex", "--no-pdf"]
    assert run_cli(argv + ["--use-txt"], fake=FakeLLM(), env=engine_env(tmp_path)).exit_code == 0
    assert (work / "out" / "book_structure.json").exists()
    (work / "book_input.txt").write_text((work / "book_input.txt").read_text(encoding="utf-8") + "\nAdditional requirements: more.\n", encoding="utf-8")
    fake = FakeLLM()
    run = run_cli(argv + ["--resume"], fake=fake, env=engine_env(tmp_path))  # no --use-txt/--use-json
    assert run.exit_code == 0, run.text
    assert len(fake.chat_calls("BookOutline")) == 1
    assert any("Ignoring the existing book_structure.json" in line for line in run.lines)


def test_failed_optional_passes_do_not_fail_the_run(tmp_path: Path) -> None:
    work = make_work_dir(tmp_path)
    fake = FakeLLM(overrides={"Glossary": lambda call: "not json", "ConsistencyReport": lambda call: "still not json"})
    run = api_run(work, fake, outline="generate")
    assert run.exit_code == 0, run.text
    stats = run.run_meta()["stats"]
    assert stats["optional_failed"] == ["consistency", "glossary"] and stats["failed_tasks"] == []
    assert len(fake.chat_calls("SectionDraft")) == len(_leaves(run.graph()))  # drafts ran without a glossary
    assert any("optional pass; continuing without it" in line for line in run.lines)


def test_full_run_removes_stale_section_files(tmp_path: Path) -> None:
    work = make_work_dir(tmp_path)
    stale = work / "out" / "sections" / "9-9.md"
    stale.parent.mkdir(parents=True)
    stale.write_text("A section of another book.\n", encoding="utf-8")
    (work / "out" / "section_reviews").mkdir()
    (work / "out" / "section_reviews" / "9-9.json").write_text("{}", encoding="utf-8")
    run = api_run(work, FakeLLM(), outline="generate")
    assert run.exit_code == 0
    assert not stale.exists() and not (work / "out" / "section_reviews" / "9-9.json").exists()
    assert "another book" not in next((work / "out").glob("*.md")).read_text(encoding="utf-8")


async def test_scheduler_skips_long_doomed_chains_iteratively() -> None:
    async def boom() -> None:
        raise RuntimeError("first draft failed")

    async def ok() -> None:
        return None

    scheduler = Scheduler(workers=2)
    scheduler.add(Task("t0", "draft", boom))
    for i in range(1, 5000):  # chained mode, ~1250 leaves x 4 stages
        scheduler.add(Task(f"t{i}", "draft", ok, {f"t{i - 1}"}))
    scheduler.add(Task("free", "x", ok))
    result = await asyncio.wait_for(scheduler.run(), 30)
    assert list(result.failed) == ["t0"] and len(result.skipped) == 4999 and result.done == ["free"]


async def test_optional_task_failure_releases_dependents() -> None:
    order: list[str] = []

    async def fail() -> None:
        raise ValueError("glossary broke")

    async def draft() -> None:
        order.append("draft")

    scheduler = Scheduler(workers=1)
    scheduler.add(Task("glossary", "glossary", fail, optional=True))
    scheduler.add(Task("draft:1", "draft", draft, {"glossary"}))
    result = await scheduler.run()
    assert result.ok and order == ["draft"] and list(result.soft_failed) == ["glossary"]


def test_heading_rule_depth_limits() -> None:
    graph = DocGraph.new({"title": "B"})
    parent = "book"
    for depth in range(1, 6):
        key = "-".join(["1"] * depth)
        graph.add_node(key, parent, {"title": f"d{depth}"})
        parent = key
    # Default: the outline is the only structure, at every depth.
    assert heading_rule(graph, "1") == NO_BODY_HEADINGS
    assert heading_rule(graph, "1-1-1-1-1") == NO_BODY_HEADINGS
    # Opt-in (`--body-headings`): one level below the node heading, capped at ######.
    assert "level ###" in heading_rule(graph, "1", allow=True)
    assert "level ######" in heading_rule(graph, "1-1-1-1", allow=True)
    assert heading_rule(graph, "1-1-1-1-1", allow=True) == "Do not use headings inside the body."


def test_strip_citations_leaves_code_alone() -> None:
    body = "Prose [kb_fake_1] here.\n\n```\nexample[kb_fake_1] = 1\n```\n\nAnd `x[kb_fake_1]` too."
    out = strip_citations(body, ["kb_fake_1"], CitationIndex())
    assert out == "Prose here.\n\n```\nexample[kb_fake_1] = 1\n```\n\nAnd `x[kb_fake_1]` too."


def test_paper_reference_formatter_failure_is_not_fatal(tmp_path: Path) -> None:
    work = make_work_dir(tmp_path, bench="en_paper")
    fake = FakeLLM(overrides={"BibEntry": lambda call: "no json" if "stored_program" in call.prompt else __import__("responders").respond(call)})
    run = paper_run(work, fake, "--no-tex", "--no-pdf")
    assert run.exit_code == 0, run.text
    references = json.loads((run.out_dir / "references.json").read_text(encoding="utf-8"))
    assert len(references) == 1 and any("could not be formatted" in line for line in run.lines)
    assert "stored_program.pdf" in (run.out_dir / "The_Stored-Program_Concept_as_the_Turning_Point_of_Early_Computing.md").read_text(encoding="utf-8")


# ------------------------------------------------------ second review round
async def test_persistently_failing_reranker_is_given_up(tmp_path: Path) -> None:
    from engine.config import LLMSettings
    from engine.events import MemorySink
    from engine.llm.client import LLMClient
    from engine.llm.usage import UsageLedger
    from engine.retrieval.kb import HybridRetriever, KnowledgeBase
    from engine.retrieval.extract import ExtractOptions
    from engine.retrieval.rerank import LLMListwiseReranker, RemoteReranker
    from fake_llm import Fault
    from helpers import BENCH

    fake = FakeLLM(faults=[Fault(status=503, match=lambda c: c.path.endswith(("/rerank", "/score")), times=None)])
    llm = LLMClient(LLMSettings(base_url="http://fake.local/v1", api_key="k", model="m", mini_model="m", max_retries=0),
                    ledger=UsageLedger(None), sink=MemorySink(), concurrency=2, transport=fake.transport())
    kb = KnowledgeBase.build(BENCH / "en_book" / "kb", cache_dir=tmp_path / "c", extract_options=ExtractOptions(cache_dir=tmp_path / "x"))
    remote = RemoteReranker(llm, model="r", base_url="http://fake.local/v1", api_key="k")
    retriever = HybridRetriever(kb, rerankers=[remote, LLMListwiseReranker(llm)])
    for question in ("EDSAC", "EDVAC report", "Analytical Engine", "Jacquard loom"):
        assert await retriever.search([question], k=3)
    assert remote.unavailable and remote.failures == 3
    remote_calls = [c for c in fake.calls if c.path.endswith(("/rerank", "/score"))]
    assert len(remote_calls) == 6  # 3 queries x 2 endpoints, then no more
    assert len(fake.chat_calls()) == 2  # the 3rd query (on giving up) and the 4th used the LLM fallback
    await llm.aclose()


async def test_fail_fast_still_aborts_on_an_optional_task() -> None:
    from engine.errors import SchemaError

    async def bad() -> None:
        raise SchemaError("book.glossary", "no JSON")

    async def ok() -> None:
        return None

    scheduler = Scheduler(workers=1, fail_fast=lambda exc: isinstance(exc, SchemaError))
    scheduler.add(Task("glossary", "glossary", bad, optional=True))
    scheduler.add(Task("draft:1", "draft", ok, {"glossary"}))
    result = await scheduler.run()
    assert result.aborted and "glossary" in result.failed and "draft:1" in result.skipped


async def test_structured_level_edge_cases(tmp_path: Path) -> None:
    import openai
    import pytest as _pytest

    from engine.config import LLMSettings
    from engine.events import MemorySink
    from engine.llm.client import LLMClient
    from engine.llm.structured import Level
    from engine.llm.usage import UsageLedger
    from fake_llm import ChatReply, Fault
    from pydantic import BaseModel

    class Answer(BaseModel):
        title: str

    def client(fake: FakeLLM) -> LLMClient:
        return LLMClient(LLMSettings(base_url="http://fake.local/v1", api_key="k", model="m", mini_model="m", max_retries=0),
                         ledger=UsageLedger(None), sink=MemorySink(), concurrency=4, transport=fake.transport())

    msgs = [{"role": "user", "content": "x"}]
    # OpenRouter's 404 for unsupported parameters is a format rejection.
    fake = FakeLLM(faults=[Fault(status=404, match=lambda c: c.response_format_type == "json_schema", times=None,
                                 message="No endpoints found that can handle the requested parameters.")])
    c = client(fake)
    assert (await c.structured(msgs, Answer, label="t")).title and c.level_for("m") == Level.JSON_OBJECT
    await c.aclose()
    # A later level failing for another reason reports that reason.
    fake = FakeLLM(faults=[
        Fault(status=400, match=lambda c: c.response_format_type == "json_schema", times=None, message="response_format json_schema is not supported"),
        Fault(status=400, match=lambda c: c.response_format_type == "json_object", times=None, message="This model's maximum context length is 8192 tokens"),
    ])
    c = client(fake)
    with _pytest.raises(openai.BadRequestError, match="maximum context length"):
        await c.structured(msgs, Answer, label="t")
    assert c.level_for("m") == Level.JSON_SCHEMA
    await c.aclose()
    # A call that started at the stronger level never undoes a concurrent downgrade.
    fake = FakeLLM(latency_s=0.2)
    c = client(fake)
    c._settled.add("m")
    pending = asyncio.ensure_future(c.structured(msgs, Answer, label="t"))
    await asyncio.sleep(0.05)
    c._levels["m"] = Level.JSON_OBJECT
    await pending
    assert c.level_for("m") == Level.JSON_OBJECT
    await c.aclose()
    # A finished answer filed under reasoning_content is used; a truncated one is not.
    fake = FakeLLM(overrides={"Answer": lambda call: ChatReply("", finish_reason="stop", reasoning='{"title": "ok"}')})
    c = client(fake)
    assert (await c.structured(msgs, Answer, label="t")).title == "ok"
    await c.aclose()


def test_full_run_keeps_a_lock_source_inside_sections(tmp_path: Path) -> None:
    work = make_work_dir(tmp_path)
    text = "Kept text of the ENIAC section, byte for byte.\n"
    from helpers import write_project

    write_project(work, project_structure(locked_file="sections/2-1.md"), {"sections/2-1.md": text})
    (work / "out" / ".kb_cache" / "engine").mkdir(parents=True)
    (work / "out" / ".kb_cache" / "engine" / "sections.json").write_text(json.dumps({"9-9": {"summary": "OLD"}}), encoding="utf-8")
    run = api_run(work, FakeLLM(), outline="project")
    assert run.exit_code == 0, run.text
    assert (work / "out" / "sections" / "2-1.md").read_text(encoding="utf-8") == text
    assert "9-9" not in json.loads((work / "out" / ".kb_cache" / "engine" / "sections.json").read_text(encoding="utf-8"))


def test_full_run_of_another_input_drops_old_web_references(tmp_path: Path) -> None:
    work = make_work_dir(tmp_path)
    web = {"tavily_results": TAVILY, "resolvable_urls": {f"https://doi.org/{EDVAC_DOI}"}}
    base = ["--mode", "book", "-i", str(work / "book_input.txt"), "-o", str(work / "out"), "--kb-dir", str(work / "kb"), "--use-txt", "--no-tex", "--no-pdf"]
    assert run_cli(base + ["--enable-web-rag"], fake=FakeLLM(**web), env=engine_env(tmp_path, TAVILY_API_KEY="t")).exit_code == 0
    (work / "book_input.txt").write_text((work / "book_input.txt").read_text(encoding="utf-8") + "\nAdditional requirements: other.\n", encoding="utf-8")
    assert run_cli(base + ["--resume"], fake=FakeLLM(), env=engine_env(tmp_path)).exit_code == 0  # refused: a full run
    sources = json.loads((work / "out" / "kb_sources.json").read_text(encoding="utf-8"))
    assert not [k for k in sources["cite_keys"] if k.startswith("web_")]


def test_moved_but_unchanged_input_keeps_its_structure(tmp_path: Path) -> None:
    import shutil

    work = make_work_dir(tmp_path)
    argv = lambda w: ["--mode", "book", "-i", str(w / "book_input.txt"), "-o", str(w / "out"), "--kb-dir", str(w / "kb"), "--no-tex", "--no-pdf"]  # noqa: E731
    assert run_cli(argv(work) + ["--use-txt"], fake=FakeLLM(), env=engine_env(tmp_path)).exit_code == 0
    moved = tmp_path / "moved"
    shutil.copytree(work, moved)
    fake = FakeLLM()
    run = run_cli(argv(moved) + ["--resume"], fake=fake, env=engine_env(tmp_path))
    assert run.exit_code == 0 and any("different input file" in line for line in run.lines)
    assert not fake.chat_calls("BookOutline")  # the unchanged structure JSON was reused


def test_crc_protected_info_frame_is_skipped() -> None:
    from engine.media.audio import mp3_duration, silent_mp3

    clip = silent_mp3(0.5)
    frame = bytearray(clip[:417])
    frame[1] = 0xFA  # protection bit 0: CRC present
    frame[4 + 2 + 32 : 4 + 2 + 36] = b"Info"
    assert mp3_duration(bytes(frame) + clip) == mp3_duration(clip)


def test_paper_at_signs_and_legacy_tex_citations(tmp_path: Path) -> None:
    import shutil as _shutil

    import pytest as _pytest

    if not _shutil.which("pandoc"):
        _pytest.skip("pandoc not installed")
    from responders import respond

    def draft(call):
        out = respond(call)
        out["body_markdown"] += "\\n\\nJava marks overrides with the @Override annotation."
        return out

    work = make_work_dir(tmp_path, bench="en_paper")
    run = paper_run(work, FakeLLM(overrides={"SectionDraft": draft}), "--no-pdf")
    assert run.exit_code == 0, run.text
    [tex_path] = list(run.out_dir.glob("*.tex"))
    tex = tex_path.read_text(encoding="utf-8")
    assert "@Override" in tex and "\\citet{Override}" not in tex and "\\citep{kb_" in tex
    # A legacy .tex section citing inside a raw environment keeps \citep there.
    key = next(k for k in json.loads((run.out_dir / "kb_sources.json").read_text(encoding="utf-8"))["cite_keys"] if k.startswith("kb_"))
    (run.out_dir / "sections" / "3.md").unlink()
    (run.out_dir / "sections" / "3.tex").write_text(
        "\\begin{table}[h]\\centering\\begin{tabular}{l}Result \\cite{" + key + "}\\end{tabular}\\end{table}\n", encoding="utf-8")
    graph = run.graph()
    graph["nodes"]["3"]["content_file_path"] = ""
    (run.out_dir / "structure_graph.json").write_text(json.dumps(graph), encoding="utf-8")
    export = paper_run(work, FakeLLM(), "--resume", "--no-pdf")
    assert export.exit_code == 0, export.text
    tex = tex_path.read_text(encoding="utf-8")
    assert "\\begin{tabular}{l}Result \\citep{kb_" in tex and "[@" not in tex


# ------------------------------------------------------- third review round
def test_moved_and_changed_input_regenerates_the_outline(tmp_path: Path) -> None:
    import shutil

    work = make_work_dir(tmp_path)
    argv = lambda w: ["--mode", "book", "-i", str(w / "book_input.txt"), "-o", str(w / "out"), "--kb-dir", str(w / "kb"), "--no-tex", "--no-pdf"]  # noqa: E731
    assert run_cli(argv(work) + ["--use-txt"], fake=FakeLLM(), env=engine_env(tmp_path)).exit_code == 0
    moved = tmp_path / "moved"
    shutil.copytree(work, moved)
    (moved / "book_input.txt").write_text((moved / "book_input.txt").read_text(encoding="utf-8") + "\nAdditional requirements: x.\n", encoding="utf-8")
    fake = FakeLLM()
    assert run_cli(argv(moved) + ["--resume"], fake=fake, env=engine_env(tmp_path)).exit_code == 0
    assert len(fake.chat_calls("BookOutline")) == 1


def test_sections_use_single_key_brackets_the_api_imports(tmp_path: Path) -> None:
    from api.application.graph_import import _extract_citations

    from engine.pipeline.text import single_key_citations

    index = CitationIndex.from_kb_sources({"chunks": [{"cite_key": k, "rid": f"RID:kb:{k}", "source_path": f"/k/{k}.md"} for k in ("kb_a_1", "kb_b_2")]})
    body = "Claim [kb_a_1; kb_b_2]. Also \\cite{kb_a_1,kb_b_2}.\n\n```latex\nAs shown \\cite{knuth84} and [kb_a_1; kb_b_2].\n```\nInline `\\cite{x}`."
    out = single_key_citations(body, index)
    assert out.startswith("Claim [kb_a_1] [kb_b_2]. Also [kb_a_1] [kb_b_2].")
    assert "As shown \\cite{knuth84} and [kb_a_1; kb_b_2]." in out and "`\\cite{x}`" in out  # code untouched
    kb = {"cite_keys": {"kb_a_1": {"source_path": "/k/a.md"}, "kb_b_2": {"source_path": "/k/b.md"}}}
    assert sorted(c["id"] for c in _extract_citations(out.split("```")[0], kb)) == ["kb_a_1", "kb_b_2"]
    from engine.assemble.citations import Numbering, resolve_numeric

    assert resolve_numeric("Claim [kb_a_1] [kb_b_2].", Numbering(index)) == "Claim [1, 2]."


def test_latex_only_export_failure_fails_the_run(tmp_path: Path, monkeypatch) -> None:
    work = make_work_dir(tmp_path)
    monkeypatch.setenv("PATH", str(tmp_path / "empty-bin"))  # no pandoc
    run = api_run(work, FakeLLM(), outline="generate", output_format="latex")
    assert run.exit_code == 1 and "LaTeX export failed" in run.run_meta()["error"]


def test_lock_sources_are_read_before_any_lock_is_written(tmp_path: Path) -> None:
    from helpers import write_project

    work = make_work_dir(tmp_path)
    structure = project_structure()
    eniac, stored = structure["childs"][1]["childs"]
    eniac.update(content_locked=True, structure_locked=True, content_file="sections/1-2.md")  # -> 2-1
    stored.update(content_locked=True, structure_locked=True, content_file="sections/2-1.md")  # -> 2-2
    write_project(work, structure, {"sections/1-2.md": "Text A for ENIAC.\n", "sections/2-1.md": "Text B for the stored program.\n"})
    run = api_run(work, FakeLLM(), outline="project")
    assert run.exit_code == 0, run.text
    assert (work / "out" / "sections" / "2-1.md").read_text(encoding="utf-8") == "Text A for ENIAC.\n"
    assert (work / "out" / "sections" / "2-2.md").read_text(encoding="utf-8") == "Text B for the stored program.\n"


def test_full_run_rebuilds_the_glossary(tmp_path: Path) -> None:
    work = make_work_dir(tmp_path)
    assert api_run(work, FakeLLM(), outline="generate").exit_code == 0
    (work / "book_input.txt").write_text((work / "book_input.txt").read_text(encoding="utf-8").replace("Target readers:", "Target readers: engineers,"), encoding="utf-8")
    fake = FakeLLM()
    assert api_run(work, fake, outline="generate", resume=True).exit_code == 0  # refused: a full run
    assert len(fake.chat_calls("Glossary")) == 1


def test_replaced_source_gets_a_new_reference_record(tmp_path: Path) -> None:
    work = make_work_dir(tmp_path, bench="en_paper")
    first = paper_run(work, FakeLLM(), "--no-tex", "--no-pdf")
    assert first.exit_code == 0
    md = work / "kb" / "mechanical-computing" / "analytical_engine.md"
    md.write_text(md.read_text(encoding="utf-8") + "\n\nA new closing paragraph about the Analytical Engine.\n", encoding="utf-8")
    (first.out_dir / "sections" / "3.md").unlink()
    graph = first.graph()
    graph["nodes"]["3"]["content_file_path"] = ""
    (first.out_dir / "structure_graph.json").write_text(json.dumps(graph), encoding="utf-8")
    fake = FakeLLM()
    assert paper_run(work, fake, "--resume", "--no-tex", "--no-pdf").exit_code == 0
    formatted = [c.user for c in fake.chat_calls("BibEntry")]
    assert len(formatted) == 1 and "analytical_engine.md" in formatted[0]  # only the changed file


def test_language_codes_outside_the_table_are_kept() -> None:
    from engine.spec.language import language_name, normalize_language

    assert normalize_language("ja") == "ja" and normalize_language("pt-BR") == "pt" and normalize_language("Czech") == "cs"
    assert normalize_language("not a language") is None and language_name("ja") == "ja"


async def test_scratch_reasoning_and_generic_errors(tmp_path: Path) -> None:
    import openai
    import pytest as _pytest

    from engine.config import LLMSettings
    from engine.errors import SchemaError
    from engine.events import MemorySink
    from engine.llm.client import LLMClient
    from engine.llm.structured import Level
    from engine.llm.usage import UsageLedger
    from fake_llm import ChatReply, Fault
    from pydantic import BaseModel

    class Answer(BaseModel):
        title: str

    msgs = [{"role": "user", "content": "x"}]
    scratch = 'We need a title. Maybe {"title": "draft"} works, let me think more'
    fake = FakeLLM(overrides={"Answer": lambda call: ChatReply("", finish_reason="stop", reasoning=scratch)})
    c = LLMClient(LLMSettings(base_url="http://fake.local/v1", api_key="k", model="m", mini_model="m"),
                  ledger=UsageLedger(None), sink=MemorySink(), concurrency=2, transport=fake.transport())
    with _pytest.raises(SchemaError):
        await c.structured(msgs, Answer, label="t")
    await c.aclose()
    # A settled model never downgrades on a generic 'unsupported' error.
    fake = FakeLLM(faults=[Fault(status=400, match=lambda call: len([x for x in fake.chat_calls()]) >= 2, times=1,
                                 message="This feature is unsupported for your account tier")])
    c = LLMClient(LLMSettings(base_url="http://fake.local/v1", api_key="k", model="m", mini_model="m", max_retries=0),
                  ledger=UsageLedger(None), sink=MemorySink(), concurrency=2, transport=fake.transport())
    await c.structured(msgs, Answer, label="t")  # settles json_schema
    with _pytest.raises(openai.BadRequestError):
        await c.structured(msgs, Answer, label="t")
    assert c.level_for("m") == Level.JSON_SCHEMA
    await c.aclose()


def test_fail_fast_schema_covers_subdivision(tmp_path: Path) -> None:
    work = make_work_dir(tmp_path)
    run = api_run(work, FakeLLM(overrides={"SubdivisionPlan": lambda call: "not json"}), outline="generate", fail_fast_schema=True)
    assert run.exit_code == 1 and "schema" in run.run_meta()["error"]


async def test_overview_context_does_not_wait_for_embeddings(tmp_path: Path) -> None:
    from engine.config import LLMSettings, RetrievalSettings
    from engine.events import MemorySink
    from engine.llm.client import LLMClient
    from engine.llm.usage import UsageLedger
    from engine.retrieval.service import RetrievalService
    from helpers import BENCH

    fake = FakeLLM()
    llm = LLMClient(LLMSettings(base_url="http://fake.local/v1", api_key="k", model="m", mini_model="m"),
                    ledger=UsageLedger(None), sink=MemorySink(), concurrency=2, transport=fake.transport())
    settings = RetrievalSettings(kb_dir=BENCH / "en_book" / "kb", extract_cache_dir=tmp_path / "x", embed_base_url="http://fake.local/v1",
                                 rerank_base_url="http://fake.local/v1", rerank="none")
    service = RetrievalService(settings, MemorySink(), lambda: llm, out_dir=tmp_path, http_factory=lambda: llm.http)
    await service.build_kb()
    ctx = await service.context(["EDSAC first program"], k=3, lexical_only=True)
    assert ctx.items and not [c for c in fake.calls if c.path.endswith("/embeddings")]
    await llm.aclose()


def test_czech_paper_json_gets_a_czech_related_work_title(tmp_path: Path) -> None:
    work = make_work_dir(tmp_path, bench="en_paper")
    (work / "out").mkdir()
    structure = {"title": "Počítače s uloženým programem", "language": "cs", "sections": [
        {"title": "Úvod", "role": "introduction", "summary": "Proč je to důležité.", "n_pages": 1},
        {"title": "Závěr", "role": "conclusion", "summary": "Co z toho plyne.", "n_pages": 1}]}
    (work / "out" / "paper_structure.json").write_text(json.dumps(structure), encoding="utf-8")
    run = run_cli(["--mode", "paper", "-i", str(work / "paper_input.txt"), "-o", str(work / "out"), "-j", "paper_structure.json",
                   "--use-json", "--no-tex", "--no-pdf"], fake=FakeLLM(), env=engine_env(tmp_path))
    assert run.exit_code == 0, run.text
    graph = run.graph()
    assert [graph["nodes"][c]["title"] for p, c in graph["edges"] if p == "book"] == ["Úvod", "Související práce", "Závěr"]


def test_audit_flags_citation_needed(tmp_path: Path) -> None:
    from engine.assemble.audit import audit_sections

    report = audit_sections([("1", "A claim [citation needed] here.")], index=CitationIndex(), out_dir=tmp_path, mode="warn")
    assert any("citation needed" in f.message.lower() for f in report.findings)


def test_slide_neighbours_do_not_carry_writing_instructions(tmp_path: Path) -> None:
    from test_contract_presentation import pres_run

    work = make_work_dir(tmp_path, bench="en_presentation")
    first = pres_run(work, FakeLLM())
    assert first.exit_code == 0
    graph = first.graph()
    graph["nodes"]["2"]["summary"] += "\n\nWriting instructions: use a table and a very formal tone."
    (first.out_dir / "sections" / "1.md").unlink()
    graph["nodes"]["1"]["content_file_path"] = ""
    (first.out_dir / "structure_graph.json").write_text(json.dumps(graph), encoding="utf-8")
    fake = FakeLLM()
    assert pres_run(work, fake, "--resume").exit_code == 0
    [call] = fake.chat_calls("SlideDraft")
    assert "very formal tone" not in call.user


# ------------------------------------------------------ fourth review round
def test_regeneration_instructions_keep_the_glossary(tmp_path: Path) -> None:
    work = make_work_dir(tmp_path)
    first = api_run(work, FakeLLM(), outline="generate")
    assert first.exit_code == 0
    out = first.out_dir
    (out / "sections" / "1-2-1.md").unlink()
    graph = first.graph()
    graph["nodes"]["1-2-1"]["content_file_path"] = ""
    graph["nodes"]["1-2-1"]["summary"] += "\n\nWriting instructions: More examples."
    (out / "structure_graph.json").write_text(json.dumps(graph), encoding="utf-8")
    fake = FakeLLM()
    assert api_run(work, fake, outline="generate", resume=True).exit_code == 0
    assert not fake.chat_calls("Glossary")  # the cached glossary still applies


def test_cite_glued_to_a_word_stays_a_citation() -> None:
    from engine.pipeline.text import invalid_citations, single_key_citations

    index = CitationIndex()
    out = single_key_citations("as shown\\cite{kb_fake_1}.", index)
    assert out == "as shown [kb_fake_1]." and invalid_citations(out, index) == ["kb_fake_1"]


def test_implicit_paper_latex_failure_is_a_warning(tmp_path: Path, monkeypatch) -> None:
    work = make_work_dir(tmp_path, bench="en_paper")
    monkeypatch.setenv("PATH", str(tmp_path / "empty-bin"))  # no pandoc
    run = paper_run(work, FakeLLM(), "--no-pdf")
    assert run.exit_code == 0, run.text
    assert any(line.startswith("[WARN] LaTeX export failed") for line in run.lines)
    explicit = paper_run(make_work_dir(tmp_path, bench="en_paper", name="explicit"), FakeLLM(), "--no-pdf", "--export-tex")
    assert explicit.exit_code == 1


def test_writing_instructions_in_txt_bullets_are_stripped() -> None:
    from engine.assemble.markdown import strip_writing_instructions
    from engine.spec.book_txt import summarize_body

    summary = summarize_body(["- What it covers.", "- Writing instructions: Math level: basic.", "- Cover A and B."])
    assert summary == "What it covers.\nCover A and B.\n\nWriting instructions: Math level: basic."  # the API's shape
    assert strip_writing_instructions(summary) == "What it covers.\nCover A and B."
    assert strip_writing_instructions("Intro.\nWriting instructions: be brief.\nCover A.") == "Intro.\nWriting instructions: be brief.\nCover A."
    assert strip_writing_instructions("Mentions writing instructions: inline, kept.") == "Mentions writing instructions: inline, kept."


def test_footnote_space_survives_merging_and_paragraphs_stay_apart() -> None:
    from engine.assemble.citations import Numbering, resolve_numeric

    index = CitationIndex()
    assert resolve_numeric("A claim\\footnote{Source: kb_a_1} [kb_b_2] here.", Numbering(index)) == "A claim [1, 2] here."


def test_moved_input_without_a_stored_hash_regenerates(tmp_path: Path) -> None:
    """Unchanged content is only provable with a stored hash; without one a
    moved input may also have been edited, so the outline is regenerated."""
    import shutil

    work = make_work_dir(tmp_path)
    argv = lambda w: ["--mode", "book", "-i", str(w / "book_input.txt"), "-o", str(w / "out"), "--kb-dir", str(w / "kb"), "--no-tex", "--no-pdf"]  # noqa: E731
    assert run_cli(argv(work) + ["--use-txt"], fake=FakeLLM(), env=engine_env(tmp_path)).exit_code == 0
    graph = json.loads((work / "out" / "structure_graph.json").read_text(encoding="utf-8"))
    del graph["graph"]["input_sha256"]
    (work / "out" / "structure_graph.json").write_text(json.dumps(graph), encoding="utf-8")
    moved = tmp_path / "moved"
    shutil.copytree(work, moved)
    fake = FakeLLM()
    assert run_cli(argv(moved) + ["--resume"], fake=fake, env=engine_env(tmp_path)).exit_code == 0
    assert len(fake.chat_calls("BookOutline")) == 1


def test_audit_placeholders_are_case_aware(tmp_path: Path) -> None:
    from engine.assemble.audit import audit_sections

    report = audit_sections([("1", "todo el sistema funciona. TODO: fill in. Lorem Ipsum dolor. tbd. Todo: add figure.")],
                            index=CitationIndex(), out_dir=tmp_path, mode="warn")
    messages = " ".join(f.message for f in report.findings)
    assert "TODO" in messages and "todo el" not in messages and "lorem ipsum" in messages.lower()
    assert "tbd" in messages.lower() and "Todo:" in messages


def test_footnote_style_keeps_paragraph_breaks(tmp_path: Path) -> None:
    from responders import respond

    def draft(call):
        out = respond(call)
        key = next((k for k in __import__("responders").cite_keys_in(call.user) if k.startswith("kb_")), None)
        if key:
            out["body_markdown"] += f"\n\n[{key}] opens this paragraph."
        return out

    work = make_work_dir(tmp_path, bench="en_paper")
    run = paper_run(work, FakeLLM(overrides={"SectionDraft": draft}), "--citation-style", "footnote", "--no-tex", "--no-pdf")
    assert run.exit_code == 0, run.text
    doc = (run.out_dir / "The_Stored-Program_Concept_as_the_Turning_Point_of_Early_Computing.md").read_text(encoding="utf-8")
    assert "\n\n^[" in doc and "opens this paragraph" in doc



# ------------------------------------------------------- fifth review round
def test_adjacent_and_parenthesised_cites_stay_citations() -> None:
    from engine.pipeline.text import invalid_citations, single_key_citations

    index = CitationIndex()
    out = single_key_citations("A\\cite{kb_a}\\cite{kb_b}. See \\cite{kb_c}(p. 5).", index)
    assert out == "A [kb_a] [kb_b]. See [kb_c] (p. 5)."
    assert invalid_citations(out, index) == ["kb_a", "kb_b", "kb_c"]


def test_paper_json_language_beats_the_spec_for_the_inserted_title(tmp_path: Path) -> None:
    work = make_work_dir(tmp_path, bench="en_paper")
    (work / "paper_input.txt").write_text((work / "paper_input.txt").read_text(encoding="utf-8") + "Language: English\n", encoding="utf-8")
    (work / "out").mkdir()
    structure = {"title": "Počítače", "language": "cs", "sections": [
        {"title": "Úvod", "role": "introduction", "n_pages": 1}, {"title": "Závěr", "role": "conclusion", "n_pages": 1}]}
    (work / "out" / "paper_structure.json").write_text(json.dumps(structure), encoding="utf-8")
    run = run_cli(["--mode", "paper", "-i", str(work / "paper_input.txt"), "-o", str(work / "out"), "-j", "paper_structure.json",
                   "--use-json", "--no-tex", "--no-pdf"], fake=FakeLLM(), env=engine_env(tmp_path))
    assert run.exit_code == 0, run.text
    graph = run.graph()
    assert graph["graph"]["language"] == "cs"
    assert "Související práce" in [graph["nodes"][c]["title"] for p, c in graph["edges"] if p == "book"]


def test_iso_639_3_codes_and_unknown_language_warning(tmp_path: Path) -> None:
    from engine.spec.language import normalize_language

    assert [normalize_language(c) for c in ("fil", "yue", "fas", "isl", "any", "und")] == ["fil", "yue", "fa", "is", None, None]
    work = make_work_dir(tmp_path)
    run = api_run(work, FakeLLM(), outline="generate", extra=["--language", "not-a-code!"])
    assert run.exit_code == 0 and any("Unknown language code 'not-a-code!'" in line for line in run.lines)


def test_footnote_after_a_list_marker_keeps_the_list() -> None:
    from engine.pipeline.paper import _before_footnote

    assert _before_footnote("- ") == "- " and _before_footnote("text ") == "text"
    assert _before_footnote("para.\n\n") == "para.\n\n" and _before_footnote("1. ") == "1. "
