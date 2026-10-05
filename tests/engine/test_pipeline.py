"""Task DAG planning, the scheduler, context modes and failure handling (#153)."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from engine.pipeline.plan import LeafStatus, plan_generation, plan_structure
from engine.pipeline.scheduler import Scheduler, Task
from engine.pipeline.text import clean_body, effective_lines, invalid_citations, lines_to_words, strip_citations, target_lines
from engine.assemble.citations import CitationIndex
from engine.graph import DocGraph
from fake_llm import Fault, FakeLLM
from helpers import api_run, make_work_dir, project_structure, write_project
from responders import node_key_of


def test_structure_plan() -> None:
    ids = [t.id for t in plan_structure(has_kb=True, need_dense=True, from_txt=True)]
    assert ids == ["kb.build", "kb.embed", "outline", "subdivide"]
    no_kb = plan_structure(has_kb=False, need_dense=False, from_txt=False)
    assert [(t.id, t.deps) for t in no_kb] == [("structure", ()), ("subdivide", ("structure",))]


def test_generation_plan_parallel_and_resume_marking() -> None:
    leaves = [LeafStatus("1-1", done=True), LeafStatus("1-2"), LeafStatus("2", resume_after="review"), LeafStatus("3")]
    plan = plan_generation(leaves, kb_deps=["kb.build", "kb.embed"])
    by_id = {t.id: t for t in plan.tasks}
    assert plan.skipped == ["1-1"] and plan.generated == ["1-2", "2", "3"]
    assert "draft:1-1" not in by_id
    assert set(by_id["draft:1-2"].deps) == {"glossary", "kb.build", "kb.embed"}
    assert set(by_id["draft:3"].deps) == set(by_id["draft:1-2"].deps)  # independent leaves
    assert "draft:2" not in by_id and "review:2" not in by_id  # resumes after its finished review
    assert "revise:2" in by_id and "review:2" not in by_id["revise:2"].deps
    assert set(by_id["consistency"].deps) == {"length:1-2", "length:2", "length:3"}
    assert by_id["length:2"].priority > by_id["draft:3"].priority


def test_generation_plan_chained_and_nothing_to_do() -> None:
    leaves = [LeafStatus("1"), LeafStatus("2", done=True), LeafStatus("3"), LeafStatus("4")]
    by_id = {t.id: t for t in plan_generation(leaves, context_mode="chained", need_glossary=False).tasks}
    assert "length:1" not in by_id["draft:3"].deps  # leaf 2 exists: no wait
    assert "length:3" in by_id["draft:4"].deps
    empty = plan_generation([LeafStatus("1", done=True)])
    assert empty.tasks == [] and empty.generated == []


async def test_scheduler_priorities_failures_and_dynamic_tasks() -> None:
    log: list[str] = []

    def job(name: str, fail: bool = False, delay: float = 0.0):
        async def run() -> None:
            await asyncio.sleep(delay)
            log.append(name)
            if fail:
                raise RuntimeError(name)
        return run

    scheduler = Scheduler(workers=1)
    scheduler.add(Task("a", "x", job("a"), priority=1))
    scheduler.add(Task("b", "x", job("b"), priority=5))
    scheduler.add(Task("c", "x", job("c", fail=True), {"b"}))
    scheduler.add(Task("d", "x", job("d"), {"c"}))

    async def spawn() -> None:
        log.append("spawn")
        scheduler.add(Task("late", "x", job("late"), {"a"}))

    scheduler.add(Task("s", "x", spawn, {"a"}))
    result = await scheduler.run()
    assert log[0] == "b"  # highest priority first
    assert "late" in log and "d" not in log
    assert set(result.failed) == {"c"} and "d" in result.skipped and not result.aborted


async def test_scheduler_critical_failure_aborts() -> None:
    started: list[str] = []

    async def slow() -> None:
        started.append("slow")
        await asyncio.sleep(10)

    async def boom() -> None:
        await asyncio.sleep(0.01)
        raise RuntimeError("outline failed")

    scheduler = Scheduler(workers=2)
    scheduler.add(Task("slow", "x", slow))
    scheduler.add(Task("outline", "outline", boom, critical=True))
    scheduler.add(Task("after", "x", slow, {"outline"}))
    result = await asyncio.wait_for(scheduler.run(), 5)
    assert result.aborted and "outline" in result.failed and "after" in result.skipped


def test_length_metric_and_body_cleanup() -> None:
    assert effective_lines("x" * 90 + "\n\n" + "y" * 91) == 3
    assert target_lines(1.5) == 60 and lines_to_words(40) == 540
    g = DocGraph.new({"title": "B"})
    g.add_node("1", "book", {"title": "Chapter"})
    g.add_node("1-1", "1", {"title": "Intro"})
    index = CitationIndex.from_kb_sources({"chunks": [{"cite_key": "kb_a_1_chunk_1", "rid": "RID:kb:a_1:chunk:1", "source_path": "/k/s/a.md", "loc": "chunk 1"}]})
    body = "```markdown\n## Intro\n\nText \\cite{kb_a_1_chunk_1} and \\footnote{Source: RID:kb:a_1:chunk:1}.\n\n# Detail\n\nMore [kb_fake_9].\n```"
    cleaned = clean_body(body, "Intro", g, "1-1", index)
    assert cleaned.startswith("Text [kb_a_1_chunk_1] and [kb_a_1_chunk_1].")
    assert "**Detail**" in cleaned and "#" not in cleaned
    assert "### Detail" in clean_body(body, "Intro", g, "1-1", index, allow_headings=True)
    assert invalid_citations(cleaned, index) == ["kb_fake_9"]
    assert strip_citations("More [kb_fake_9].", ["kb_fake_9"]) == "More."
    assert strip_citations("Both [kb_a_1_chunk_1; kb_fake_9].", ["kb_fake_9"]) == "Both [kb_a_1_chunk_1]."


def test_parallel_drafting_is_bounded_by_concurrency(tmp_path: Path) -> None:
    work = make_work_dir(tmp_path)
    fake = FakeLLM(latency_s=0.02)
    run = api_run(work, fake, outline="generate", extra=["--concurrency", "3"])
    assert run.exit_code == 0
    assert 1 < fake.max_in_flight <= 3
    # Drafts overlap: some draft request starts before the previous leaf's draft has finished.
    drafts = sorted(fake.chat_calls("SectionDraft"), key=lambda c: c.started)
    assert any(b.started < a.finished for a, b in zip(drafts, drafts[1:]))


def test_chained_mode_writes_leaves_in_order_with_previous_text(tmp_path: Path) -> None:
    work = make_work_dir(tmp_path)
    fake = FakeLLM()
    run = api_run(work, fake, outline="generate", extra=["--context-mode", "chained", "--concurrency", "4"])
    assert run.exit_code == 0, run.text
    drafts = sorted(fake.chat_calls("SectionDraft"), key=lambda c: c.started)
    keys = [node_key_of(c.prompt) for c in drafts]
    parents = {p for p, _c in run.graph()["edges"]}
    assert keys == [k for k in run.graph()["nodes"] if k != "book" and k not in parents]
    assert all(b.started >= a.finished for a, b in zip(drafts, drafts[1:]))
    assert "Full text of the previous section" in drafts[1].user and "Full text of the previous section" not in drafts[0].user


def test_fail_fast_schema_aborts_the_run(tmp_path: Path) -> None:
    work = make_work_dir(tmp_path)
    fake = FakeLLM(overrides={"SectionDraft": lambda call: "not json" if node_key_of(call.prompt) == "1-1-1" else __import__("responders").respond(call)})
    run = api_run(work, fake, outline="generate", fail_fast_schema=True)
    assert run.exit_code == 1
    assert "fail-fast-schema" in run.run_meta()["error"] and "schema" in run.run_meta()["error"]
    # Without the flag, the other leaves complete and only that leaf fails.
    work2 = make_work_dir(tmp_path, name="lenient")
    run2 = api_run(work2, FakeLLM(overrides=fake.overrides), outline="generate")
    assert run2.exit_code == 1
    assert "1 section(s) failed (1-1-1)" in run2.run_meta()["error"]
    assert len(list((run2.out_dir / "sections").glob("*.md"))) == 11  # the 11 other leaves were written


def test_interrupted_chain_resumes_after_its_last_stage(tmp_path: Path) -> None:
    work = make_work_dir(tmp_path)
    write_project(work, project_structure(lock_nodes=True))
    # Every reviser call fails: drafts and reviews persist, revise fails for the rejected leaves.
    fake = FakeLLM(faults=[Fault(status=400, match=lambda c: c.schema_name == "SectionRevision", times=None)])
    first = api_run(work, fake, outline="project")
    assert first.exit_code == 1
    failed = sorted({node_key_of(c.prompt) for c in fake.chat_calls("SectionRevision")})
    assert failed
    retry_fake = FakeLLM()
    retry = api_run(work, retry_fake, outline="project", resume=True)
    assert retry.exit_code == 0
    assert not retry_fake.chat_calls("SectionDraft")  # drafts were kept from the interrupted run
    assert sorted({node_key_of(c.prompt) for c in retry_fake.chat_calls("SectionRevision")}) >= failed


def test_cancellation_persists_progress_and_exits_143(tmp_path: Path) -> None:
    import os
    import signal
    import subprocess
    import sys
    import time

    from helpers import REPO_ROOT, api_argv, engine_env

    work = make_work_dir(tmp_path)
    fake = FakeLLM(latency_s=0.2)
    with fake.serve() as base_url:
        argv, env = api_argv(work, outline="generate")
        env = {**env, **engine_env(tmp_path), "AUTOGENBOOK_LLM_BASE_URL": base_url, "PATH": os.environ.get("PATH", "")}
        proc = subprocess.Popen([sys.executable] + argv[1:], cwd=REPO_ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
        deadline = time.monotonic() + 60
        seen = b""
        while b"Starting section" not in seen and time.monotonic() < deadline:
            seen += proc.stdout.readline()
        os.killpg(proc.pid, signal.SIGTERM)
        out, _ = proc.communicate(timeout=60)
    assert proc.returncode == 143
    meta = __import__("json").loads((work / "out" / "run_meta.json").read_text(encoding="utf-8"))
    assert meta["status"] == "cancelled" and "cancelled" in meta["error"]
    assert (work / "out" / "structure_graph.json").exists()
