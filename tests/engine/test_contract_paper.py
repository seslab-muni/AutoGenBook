"""Paper mode (#155): the old CLI's paper argv, the book artifact layout plus
the paper artifacts, KB-first citations with verified web references only,
the citation styles, and the four run kinds."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from fake_llm import Fault, FakeLLM
from helpers import engine_env, make_work_dir, requires_lualatex, requires_pandoc, run_cli
from responders import node_key_of

EDVAC_DOI = "10.1109/85.238389"
TAVILY = [
    {"url": "https://example.org/edvac", "title": "First Draft of a Report on the EDVAC",
     "content": f"The EDVAC report (doi {EDVAC_DOI}) describes a stored-program design.", "score": 0.9},
    {"url": "https://dead.example.net/x", "title": "A dead link", "content": "Nothing verifiable here.", "score": 0.8},
]


def paper_argv(work: Path, *extra: str) -> list[str]:
    """The paper argv of the old `main.py --mode paper`."""
    return ["--mode", "paper", "--paper-input", str(work / "paper_input.txt"), "-o", str(work / "out"),
            "--kb-dir", str(work / "kb"), "--use-txt", *extra]


def paper_run(work: Path, fake: FakeLLM, *extra: str, **env: str):
    return run_cli(paper_argv(work, *extra), fake=fake, env=engine_env(work.parent, **env))


def _leaves(graph: dict) -> list[str]:
    parents = {p for p, _c in graph["edges"]}
    return [k for k in graph["nodes"] if k != "book" and k not in parents]


def _document(out: Path) -> str:
    [path] = [p for p in out.glob("*.md") if p.name != "abstract.md"]
    return path.read_text(encoding="utf-8")


def _writer_keys(fake: FakeLLM) -> list[str]:
    return [node_key_of(c.prompt) for c in fake.chat_calls("SectionDraft")]


def test_paper_argv_is_accepted_and_unknown_flags_exit_2(tmp_path: Path) -> None:
    from engine.cli import build_parser

    args = build_parser().parse_args([
        "--mode", "paper", "--paper-input", "p.txt", "-o", "out", "-j", "paper_structure.json", "--use-json",
        "--kb-dir", "kb", "--paper-venue", "NeurIPS", "--citation-style", "footnote", "--audit", "--audit-mode", "strict",
        "--enable-web-rag", "--web-rag-k", "3", "--no-pdf", "--no-md", "--resume", "--fail-fast-schema",
    ])
    assert args.mode == "paper" and args.citation_style == "footnote" and args.paper_venue == "NeurIPS"
    with pytest.raises(SystemExit) as exc:
        build_parser().parse_args(["--mode", "paper", "--paper-template", "x"])
    assert exc.value.code == 2
    # A missing paper input exits 2 and says so in run_meta.json, as for books.
    work = tmp_path / "missing"
    work.mkdir()
    run = run_cli(["--mode", "paper", "--paper-input", str(work / "nope.txt"), "-o", str(work / "out")], tmp_path=tmp_path)
    assert run.exit_code == 2 and "input file not found" in run.run_meta()["error"]


def test_full_paper_run_writes_the_contract_artifacts(tmp_path: Path) -> None:
    work = make_work_dir(tmp_path, bench="en_paper")
    fake = FakeLLM()
    run = paper_run(work, fake, "--no-tex", "--no-pdf")
    assert run.exit_code == 0, run.text
    out = run.out_dir
    for name in ("paper_structure.json", "structure_graph.json", "kb_sources.json", "related_work.json", "abstract.md",
                 "references.json", "refs.bib", "glossary.json", "audit_report.json", "run_meta.json", "llm_usage.jsonl"):
        assert (out / name).exists(), name
    graph = run.graph()
    assert graph["graph"]["doc_type"] == "paper" and "book" in graph["nodes"]
    roles = [graph["nodes"][k].get("role") for k, _ in [(c, None) for p, c in graph["edges"] if p == "book"]]
    assert roles[:2] == ["introduction", "related_work"]  # the related-work section is inserted after the introduction
    leaves = _leaves(graph)
    assert sorted(p.stem for p in (out / "sections").glob("*.md")) == sorted(leaves)
    assert all(Path(graph["nodes"][k]["content_file_path"]) == out / "sections" / f"{k}.md" for k in leaves)
    meta = run.run_meta()
    assert meta["mode"] == "paper" and meta["run_kind"] == "full" and meta["error"] is None
    # Stage order: the abstract is written last, from the finished sections.
    labels = [u["label"] for u in run.usage_lines()]
    assert labels.index("paper.abstract") > max(i for i, label in enumerate(labels) if label.startswith("book.consistency") or label == "paper.writer")
    [abstract_call] = fake.chat_calls("PaperAbstract")
    assert all(graph["nodes"][k]["title"] in abstract_call.user for k in leaves)
    # References: one numbered entry per cited source document, formatted by the mini model.
    doc = _document(out)
    assert doc.startswith("# The Stored-Program Concept")
    assert "## Abstract {.unnumbered}" not in doc and "## Abstract" in doc and "**Keywords:**" in doc
    assert not re.search(r"\[(kb_|web_|RID:)[^\]]*\]", doc)
    refs = re.findall(r"(?m)^\[(\d+)\] (.+)$", doc.split("## References")[1])
    assert [n for n, _ in refs] == ["1", "2"]  # two KB documents, many cited passages
    assert all("Benchmark, Corpus" in text for _, text in refs)
    assert {c.model for c in fake.chat_calls("BibEntry")} == {"fake-mini"}
    references = json.loads((out / "references.json").read_text(encoding="utf-8"))
    assert sorted(references) == sorted(k.split("_chunk")[0].split("_page")[0] for k in references)
    assert (out / "refs.bib").read_text(encoding="utf-8").count("@") == 2


def test_web_references_are_emitted_only_when_verified(tmp_path: Path) -> None:
    work = make_work_dir(tmp_path, bench="en_paper")
    fake = FakeLLM(tavily_results=TAVILY, resolvable_urls={f"https://doi.org/{EDVAC_DOI}"})
    run = paper_run(work, fake, "--enable-web-rag", "--no-tex", "--no-pdf", TAVILY_API_KEY="tvly-fake")
    assert run.exit_code == 0, run.text
    out = run.out_dir
    related = json.loads((out / "related_work.json").read_text(encoding="utf-8"))
    web = [item for item in related["items"] if item["kind"] == "web"]
    assert [item["url"] for item in web] == ["https://example.org/edvac"] and web[0]["verified"] is True
    assert web[0]["doi"] == EDVAC_DOI
    assert [item["url"] for item in related["rejected_unverified"]] == ["https://dead.example.net/x"]
    assert any("1 verified, 1 rejected" in line for line in run.lines)
    doc = _document(out)
    assert "<https://example.org/edvac>" in doc and "dead.example.net" not in doc
    # Only the related-work section saw web material; the other writers had the KB only.
    for call in fake.chat_calls("SectionDraft"):
        section = node_key_of(call.prompt)
        role = run.graph()["nodes"][section].get("role")
        assert ("kind=web" in call.user) == (role == "related_work"), section
    sources = json.loads((out / "kb_sources.json").read_text(encoding="utf-8"))
    [key] = [k for k in sources["cite_keys"] if k.startswith("web_")]
    assert sources["cite_keys"][key]["source_path"] == "https://example.org/edvac"
    assert not any(c["cite_key"] == key for c in sources["chunks"])  # chunks stay KB-only
    bib = (out / "refs.bib").read_text(encoding="utf-8")
    assert f"doi = {{{EDVAC_DOI}}}" in bib and "url = {https://example.org/edvac}" in bib
    # An export (no LLM) still renders the web reference from kb_sources.json.
    fake2 = FakeLLM()
    export = paper_run(work, fake2, "--resume", "--no-tex", "--no-pdf")
    assert export.exit_code == 0 and fake2.calls == []
    assert "<https://example.org/edvac>" in _document(out)


def test_web_rag_without_key_falls_back_to_the_kb(tmp_path: Path) -> None:
    work = make_work_dir(tmp_path, bench="en_paper")
    fake = FakeLLM(tavily_results=TAVILY, resolvable_urls={"https://"})
    run = paper_run(work, fake, "--enable-web-rag", "--no-tex", "--no-pdf")
    assert run.exit_code == 0, run.text
    assert any(line.startswith("[WARN]") and "TAVILY_API_KEY" in line for line in run.lines)
    related = json.loads((run.out_dir / "related_work.json").read_text(encoding="utf-8"))
    assert all(item["kind"] == "kb" for item in related["items"]) and related["rejected_unverified"] == []


@requires_pandoc
@pytest.mark.parametrize("style", ["bibtex", "numeric", "footnote"])
def test_citation_styles(tmp_path: Path, style: str) -> None:
    work = make_work_dir(tmp_path, bench="en_paper")
    run = paper_run(work, FakeLLM(), "--citation-style", style, "--no-pdf")
    assert run.exit_code == 0, run.text
    [tex_path] = list(run.out_dir.glob("*.tex"))
    tex = tex_path.read_text(encoding="utf-8")
    doc = _document(run.out_dir)
    assert "\\begin{abstract}" in tex and "\\documentclass" in tex and "\\chapter" not in tex
    if style == "bibtex":
        assert re.search(r"\\cite\{kb_[A-Za-z0-9_.:\-]+\}", tex) and "\\bibliography{refs}" in tex
        assert "## References" in doc and "[1]" in doc
    elif style == "numeric":
        assert "\\cite{" not in tex and "\\bibliography{" not in tex and "{[}1{]}" in tex
        assert "## References" in doc
    else:
        assert "\\footnote{" in tex and "\\bibliography{" not in tex
        assert "## References" not in doc and "^[Benchmark, Corpus." in doc


@requires_lualatex
def test_paper_pdf_with_bibtex(tmp_path: Path) -> None:
    work = make_work_dir(tmp_path, bench="en_paper")
    run = paper_run(work, FakeLLM())
    assert run.exit_code == 0, run.text
    pdfs = list(run.out_dir.glob("*.pdf"))
    assert len(pdfs) == 1 and pdfs[0].stat().st_size > 1000
    assert any(line.startswith("[PDF] PDF written:") for line in run.lines)
    assert run.run_meta()["outputs"] and any(o.endswith(".pdf") for o in run.run_meta()["outputs"])


def test_paper_retry_regenerate_and_export(tmp_path: Path) -> None:
    work = make_work_dir(tmp_path, bench="en_paper")
    # Full run with one section failing for good.
    failing = FakeLLM(faults=[Fault(status=400, match=lambda c: c.schema_name == "SectionDraft" and node_key_of(c.prompt) == "4", times=None)])
    first = paper_run(work, failing, "--no-tex", "--no-pdf")
    assert first.exit_code == 1 and "4" in first.run_meta()["error"]
    assert not (first.out_dir / "sections" / "4.md").exists()
    assert not failing.chat_calls("PaperAbstract")  # the abstract waits for every section
    # Retry: only the missing section, then the abstract and the missing references.
    retry_fake = FakeLLM()
    retry = paper_run(work, retry_fake, "--resume", "--no-tex", "--no-pdf")
    assert retry.exit_code == 0, retry.text
    assert _writer_keys(retry_fake) == ["4"] and retry.run_meta()["run_kind"] == "resume"
    assert not retry_fake.chat_calls("PaperOutline") and len(retry_fake.chat_calls("PaperAbstract")) == 1
    # Regenerate one section the way the API does it.
    out = retry.out_dir
    (out / "sections" / "3.md").unlink()
    graph = retry.graph()
    graph["nodes"]["3"]["content_file_path"] = ""
    graph["nodes"]["3"]["summary"] += "\n\nWriting instructions: Compare the EDSAC and the Baby."
    (out / "structure_graph.json").write_text(json.dumps(graph, ensure_ascii=False, indent=2), encoding="utf-8")
    regen_fake = FakeLLM()
    regen = paper_run(work, regen_fake, "--resume", "--no-tex", "--no-pdf")
    assert regen.exit_code == 0, regen.text
    assert _writer_keys(regen_fake) == ["3"] and regen.run_meta()["run_kind"] == "resume"
    assert "Writing instructions: Compare the EDSAC and the Baby." in regen_fake.chat_calls("SectionDraft")[0].user
    assert not regen_fake.chat_calls("BibEntry")  # references.json already covers the cited documents
    # Export: nothing left to generate, zero model calls.
    export_fake = FakeLLM()
    export = paper_run(work, export_fake, "--resume", "--no-tex", "--no-pdf")
    assert export.exit_code == 0 and export_fake.calls == [] and export.run_meta()["run_kind"] == "export"
    assert "## References" in _document(out)


def test_paper_from_explicit_structure_json(tmp_path: Path) -> None:
    """-j paper_structure.json --use-json: the given sections, no outline call."""
    work = make_work_dir(tmp_path, bench="en_paper")
    out = work / "out"
    out.mkdir()
    structure = {
        "title": "Stored Programs", "abstract": "A given abstract.", "keywords": ["EDVAC"], "n_pages": 3,
        "sections": [
            {"title": "Introduction", "role": "introduction", "summary": "Why it matters.", "n_pages": 1},
            {"title": "Machines", "role": "method", "summary": "The machines compared.", "n_pages": 1,
             "subsections": [{"title": "EDVAC", "summary": "The report."}, {"title": "EDSAC", "summary": "The first service."}]},
            {"title": "Conclusion", "role": "conclusion", "summary": "What follows.", "n_pages": 1},
        ],
    }
    (out / "paper_structure.json").write_text(json.dumps(structure), encoding="utf-8")
    fake = FakeLLM()
    run = run_cli(["--mode", "paper", "--paper-input", str(work / "paper_input.txt"), "-o", str(out), "--kb-dir", str(work / "kb"),
                   "-j", "paper_structure.json", "--use-json", "--no-tex", "--no-pdf"], fake=fake, env=engine_env(tmp_path))
    assert run.exit_code == 0, run.text
    assert not fake.chat_calls("PaperOutline")
    graph = run.graph()
    top = [graph["nodes"][c]["title"] for p, c in graph["edges"] if p == "book"]
    assert top == ["Introduction", "Related Work", "Machines", "Conclusion"]
