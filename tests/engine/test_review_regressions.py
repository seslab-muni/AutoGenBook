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
from engine.pipeline.text import heading_rule, strip_citations
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
    assert "level ###" in heading_rule(graph, "1")
    assert "level ######" in heading_rule(graph, "1-1-1-1")
    assert heading_rule(graph, "1-1-1-1-1") == "Do not use headings inside the body."


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
