"""Contract 3.5: run kinds and resume semantics."""

from __future__ import annotations

import json
from pathlib import Path

from fake_llm import Fault, FakeLLM
from helpers import api_run, copy_legacy_work_dir, make_work_dir, project_structure, run_cli, write_project
from responders import node_key_of


def _writer_keys(fake: FakeLLM) -> list[str]:
    return [node_key_of(c.prompt) for c in fake.chat_calls("SectionDraft")]


def _leaves(graph: dict) -> list[str]:
    parents = {p for p, _c in graph["edges"]}
    return [k for k in graph["nodes"] if k != "book" and k not in parents]


def _sections(out: Path) -> dict[str, bytes]:
    return {p.name: p.read_bytes() for p in sorted((out / "sections").glob("*.md"))}


def test_full_run(tmp_path: Path) -> None:
    """Fresh work dir, no --resume: every leaf generated."""
    work = make_work_dir(tmp_path)
    fake = FakeLLM()
    run = api_run(work, fake, outline="generate")
    assert run.exit_code == 0, run.text
    leaves = _leaves(run.graph())
    assert sorted(_writer_keys(fake)) == sorted(leaves)
    assert run.run_meta()["run_kind"] == "full"
    assert (run.out_dir / "book_structure.json").exists()  # the generated structure is kept


def test_retry_skips_existing_sections(tmp_path: Path) -> None:
    """--resume skips leaves whose section file exists and whose input hash matches."""
    work = make_work_dir(tmp_path)
    # First attempt: the writer for one leaf keeps failing (a non-transient 400).
    failing = FakeLLM(faults=[Fault(status=400, match=lambda c: c.schema_name == "SectionDraft" and node_key_of(c.prompt) == "2-1-2", times=None, message="bad request")])
    first = api_run(work, failing, outline="generate")
    assert first.exit_code == 1
    assert "2-1-2" in first.run_meta()["error"] and "Error code: 400" in first.run_meta()["error"]
    before = _sections(first.out_dir)
    assert "2-1-2.md" not in before and len(before) == len(_leaves(first.graph())) - 1
    graph_before = first.graph()
    # Retry: same work dir, --resume.
    fake = FakeLLM()
    retry = api_run(work, fake, outline="generate", resume=True)
    assert retry.exit_code == 0, retry.text
    assert _writer_keys(fake) == ["2-1-2"]
    assert not fake.chat_calls("BookOutline") and not fake.chat_calls("SubdivisionPlan")
    after = _sections(retry.out_dir)
    assert {k: v for k, v in after.items() if k != "2-1-2.md" and k not in retry.run_meta()["stats"]["patched"]} == {
        k: v for k, v in before.items() if k not in retry.run_meta()["stats"]["patched"]
    }
    assert retry.graph()["graph"]["input_sha256"] == graph_before["graph"]["input_sha256"]
    assert any("Skipping existing section" in line for line in retry.lines)


def test_regenerate_one_node(tmp_path: Path) -> None:
    """API deletes sections/<key>.md, clears content_file_path, appends Writing instructions: exactly that leaf is regenerated, with the instructions."""
    work = make_work_dir(tmp_path)
    first = api_run(work, FakeLLM(), outline="generate")
    assert first.exit_code == 0
    out = first.out_dir
    target = "1-2-1"
    # What GenerationService._prepare_regenerate does to the work dir:
    (out / "sections" / f"{target}.md").unlink()
    graph = first.graph()
    graph["nodes"][target]["content_file_path"] = ""
    graph["nodes"][target]["summary"] += "\n\nWriting instructions: Focus on the Jacquard loom."
    (out / "structure_graph.json").write_text(json.dumps(graph, ensure_ascii=False, indent=2), encoding="utf-8")
    before = _sections(out)
    fake = FakeLLM()
    regen = api_run(work, fake, outline="generate", resume=True)
    assert regen.exit_code == 0, regen.text
    assert _writer_keys(fake) == [target]
    [call] = fake.chat_calls("SectionDraft")
    assert "Writing instructions: Focus on the Jacquard loom." in call.user
    # Full context from the neighbours: their existing text reaches the writer.
    assert "End of the previous section, already written" in call.user
    assert "Beginning of the next section, already written" in call.user
    after = _sections(out)
    assert set(after) == set(before) | {f"{target}.md"}
    patched = set(regen.run_meta()["stats"]["patched"])
    assert patched <= {target}  # consistency may only touch the regenerated leaf
    assert {k: v for k, v in after.items() if k != f"{target}.md"} == before
    assert regen.graph()["nodes"][target]["content_file_path"]


def test_export_generates_nothing(tmp_path: Path) -> None:
    """--resume --export-tex: zero LLM calls, only assembly."""
    work = copy_legacy_work_dir(tmp_path)
    sections_before = {p.name: p.read_bytes() for p in (work / "out" / "sections").iterdir()}
    fake = FakeLLM()
    run = run_cli(
        ["--mode", "book", "-i", str(work / "book_input.txt"), "-o", str(work / "out"), "--use-txt", "--resume", "--export-tex", "--no-pdf"],
        fake=fake, tmp_path=tmp_path,
    )
    assert run.exit_code == 0, run.text
    assert fake.calls == [] and run.usage_lines() == []
    assert {p.name: p.read_bytes() for p in (work / "out" / "sections").iterdir()} == sections_before
    assert run.run_meta()["run_kind"] == "export"
    assert not any(line.startswith("[GEN]") and "Starting section" in line for line in run.lines)
    # The same after a run of the new engine itself, through the API's argv.
    fresh = make_work_dir(tmp_path, name="fresh")
    assert api_run(fresh, FakeLLM(), outline="generate").exit_code == 0
    fake2 = FakeLLM()
    export = api_run(fresh, fake2, outline="generate", resume=True, output_format="markdown", rebuild_kb=False)
    assert export.exit_code == 0 and fake2.calls == []
    assert export.run_meta()["run_kind"] == "export"


def test_resume_refused_when_input_hash_differs(tmp_path: Path) -> None:
    """A changed book_input.txt refuses resume and rebuilds the outline."""
    work = make_work_dir(tmp_path)
    assert api_run(work, FakeLLM(), outline="generate").exit_code == 0
    (work / "book_input.txt").write_text((work / "book_input.txt").read_text(encoding="utf-8") + "\nAdditional requirements: more examples.\n", encoding="utf-8")
    fake = FakeLLM()
    run = api_run(work, fake, outline="generate", resume=True)
    assert run.exit_code == 0, run.text
    assert any(line.startswith("[RESUME] Skipping --resume: the input changed") for line in run.lines)
    assert len(fake.chat_calls("BookOutline")) == 1
    assert sorted(_writer_keys(fake)) == sorted(_leaves(run.graph()))  # a full run, nothing reused
    assert run.run_meta()["run_kind"] == "full"


def test_content_locked_leaf_is_copied_verbatim(tmp_path: Path) -> None:
    """content_locked + content_file: bytes copied, no LLM call for that leaf."""
    work = make_work_dir(tmp_path)
    locked_rel = "locked_sections/5f1c.md"
    text = "ENIAC was completed in 1945. Curated text that must be kept byte for byte.\n\n* keep me *\n"
    write_project(work, project_structure(locked_file=locked_rel), {locked_rel: text})
    fake = FakeLLM()
    run = api_run(work, fake, outline="project")
    assert run.exit_code == 0, run.text
    assert (run.out_dir / "sections" / "2-1.md").read_bytes() == text.encode("utf-8")
    assert "2-1" not in _writer_keys(fake)
    assert any("Locked section 'ENIAC' (kept, used as context)" in line for line in run.lines)
    # Locked text is visible to the neighbour's writer and to the consistency pass.
    [neighbour] = [c for c in fake.chat_calls("SectionDraft") if node_key_of(c.prompt) == "2-2"]
    assert "Curated text that must be kept" in neighbour.user
    [consistency] = fake.chat_calls("ConsistencyReport")
    assert "[2-1] ENIAC" in consistency.user and "2-1" not in consistency.system.split("Only these sections may be patched:")[1].split(".")[0]

    # Fail open: an unreadable lock file is generated instead, with a [WARN].
    work2 = make_work_dir(tmp_path, name="failopen")
    write_project(work2, project_structure(locked_file="locked_sections/missing.md"))
    fake2 = FakeLLM()
    run2 = api_run(work2, fake2, outline="project")
    assert run2.exit_code == 0
    assert "2-1" in _writer_keys(fake2)
    assert any(line.startswith("[WARN] Section 'ENIAC' is content-locked") for line in run2.lines)


def test_project_outline_is_used_verbatim(tmp_path: Path) -> None:
    """outline "project": -j book_structure.json --use-json, no outline call; locked structure is not subdivided."""
    work = make_work_dir(tmp_path)
    write_project(work, project_structure(lock_nodes=True))
    fake = FakeLLM()
    run = api_run(work, fake, outline="project")
    assert run.exit_code == 0, run.text
    assert not fake.chat_calls("BookOutline") and not fake.chat_calls("SubdivisionPlan")
    assert _leaves(run.graph()) == ["1-1", "1-2", "2-1", "2-2"]
    # Scopes: the selected-source leaf only saw its own source.
    [call] = [c for c in fake.chat_calls("SectionDraft") if node_key_of(c.prompt) == "1-1"]
    assert "analytical_engine.md" in call.user and "stored_program.pdf" not in call.user
