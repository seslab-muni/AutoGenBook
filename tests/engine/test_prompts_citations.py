"""Strict prompt renderer, every shipped prompt pack, citation resolver and
Markdown assembly (#151)."""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from engine.assemble.audit import audit_sections
from engine.assemble.citations import (
    CitationIndex,
    Numbering,
    Reference,
    bibliography_lines,
    cited_keys,
    find_citations,
    resolve_numeric,
)
from engine.assemble.markdown import assemble_document, markdown_for_humans, normalize_body, strip_writing_instructions
from engine.errors import PromptError
from engine.graph import DocGraph
from engine.prompts import PROMPTS_DIR, list_prompts, load_prompt, render


def _write(root: Path, name: str, text: str) -> None:
    path = root / f"{name}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(text).lstrip(), encoding="utf-8")


def test_renderer_is_strict(tmp_path: Path) -> None:
    load_prompt.cache_clear()
    root = str(tmp_path)
    _write(tmp_path, "common/base", """
        ---
        placeholders: [language_name]
        ---
        Write in {language_name}.
        """)
    _write(tmp_path, "p/ok", """
        ---
        compose: [common/base]
        placeholders: [title]
        ---
        === system ===
        Literal JSON: {{"a": 1}}
        === user ===
        Title: {title}
        """)
    messages = render("p/ok", {"title": "T {x} \\cite{y}", "language_name": "Czech"}, root=root)
    assert messages[0]["content"] == 'Write in Czech.\n\nLiteral JSON: {"a": 1}'
    assert messages[1]["content"] == "Title: T {x} \\cite{y}"  # values inserted verbatim
    with pytest.raises(PromptError, match="missing"):
        render("p/ok", {"title": "T"}, root=root)
    with pytest.raises(PromptError, match="unexpected"):
        render("p/ok", {"title": "T", "language_name": "x", "extra": 1}, root=root)

    _write(tmp_path, "p/unknown", "---\nplaceholders: []\n---\nHello {name}\n")
    with pytest.raises(PromptError, match="undeclared"):
        load_prompt("p/unknown", root)
    _write(tmp_path, "p/unused", "---\nplaceholders: [a, b]\n---\nHello {a}\n")
    with pytest.raises(PromptError, match="unused"):
        load_prompt("p/unused", root)
    _write(tmp_path, "p/stray", "---\nplaceholders: []\n---\nHello {Bad Name}\n")
    with pytest.raises(PromptError, match="stray"):
        load_prompt("p/stray", root)
    _write(tmp_path, "p/noheader", "Hello\n")
    with pytest.raises(PromptError, match="header"):
        load_prompt("p/noheader", root)
    load_prompt.cache_clear()


@pytest.mark.parametrize("prompt_id", list_prompts())
def test_every_shipped_prompt_loads_and_renders(prompt_id: str) -> None:
    prompt = load_prompt(prompt_id)
    values = {name: f"<{name}>" for name in prompt.required}
    messages = render(prompt_id, values)
    text = "\n".join(m["content"] for m in messages)
    for name in prompt.required:
        assert f"<{name}>" in text, f"{prompt_id}: {name} not rendered"
    assert "{" + "language_name" + "}" not in text
    # Prompts are English: no Czech diacritics in the instructions.
    template = (PROMPTS_DIR / f"{prompt_id}.md").read_text(encoding="utf-8")
    assert not any(ch in template for ch in "ěščřžůťďň"), prompt_id


def _index() -> CitationIndex:
    return CitationIndex.from_kb_sources(
        {
            "cite_keys": {},
            "rids": {},
            "chunks": [
                {"source_path": "/w/kb/s1/a.pdf", "loc": "page 2, chunk 1", "rid": "RID:kb:a_pdf_1:page_2:1", "cite_key": "kb_a_pdf_1_page_2_1", "excerpt": "e1"},
                {"source_path": "/w/kb/s2/b.md", "loc": "chunk 3", "rid": "RID:kb:b_md_2:chunk:3", "cite_key": "kb_b_md_2_chunk_3", "excerpt": "e2"},
            ],
        }
    )


def test_resolver_accepts_all_three_forms_and_skips_code_and_links() -> None:
    index = _index()
    text = (
        "Claim [kb_a_pdf_1_page_2_1]. Old style \\cite{kb_b_md_2_chunk_3, kb_a_pdf_1_page_2_1}.\n"
        "Footnote\\footnote{Source: RID:kb:b_md_2:chunk:3}. Link [text](http://x) and ![img](a.png) and [x] box.\n"
        "`[kb_a_pdf_1_page_2_1]` in code and [kb_missing_key] unknown and [Note] prose.\n"
        "```\n[kb_b_md_2_chunk_3]\n```\n"
    )
    keys = cited_keys(text, index)
    assert keys == ["kb_a_pdf_1_page_2_1", "kb_b_md_2_chunk_3", "kb_missing_key"]
    numbering = Numbering(index)
    out = resolve_numeric(text, numbering, node_key="1-1")
    assert "Claim [1]." in out and "Old style [2, 1]." in out and "Footnote [2]." in out
    assert "[text](http://x)" in out and "![img](a.png)" in out and "[x] box" in out and "[Note]" in out
    assert "`[kb_a_pdf_1_page_2_1]`" in out and "```\n[kb_b_md_2_chunk_3]\n```" in out
    assert "[3] unknown" in out
    assert numbering.unknown == {"kb_missing_key": ["1-1"]}
    lines = bibliography_lines(numbering, "en")
    assert lines[0].startswith("[1] *a.pdf*, page 2, chunk 1") and "Unresolved reference" in lines[2]
    assert "Nedohledaný zdroj" in bibliography_lines(numbering, "cs")[2]


def test_find_citations_matches_the_api_token_regex() -> None:
    import re

    api_re = re.compile(r"\[([A-Za-z0-9_.:-]+)\]")  # api/application/graph_import.py
    text = "A [kb_a_pdf_1_page_2_1] and [web_tavily_x]."
    ours = [k for m in find_citations(text, _index()) for k in m.keys]
    assert ours == api_re.findall(text)


def test_body_normalisation() -> None:
    body = "## Intro\n\nText.\n\n# Sub\n\nMore.\n\n```\n# not a heading\n```"
    # Default: body headings are flattened to bold lead-ins; the outline is the structure.
    out = normalize_body(body, "Intro", level=3)
    assert out.startswith("Text.")
    assert "#" not in out.split("```")[0]
    assert "\n\n**Sub.** More." in out and "# not a heading" in out
    # Opt-in: headings are kept and shifted below the node heading.
    out = normalize_body(body, "Intro", level=3, allow_headings=True)
    assert out.startswith("Text.")
    assert "#### Sub" in out and "# not a heading" in out


def test_body_headings_flattened_once_and_level_capped() -> None:
    body = "### A ###\n#### **B**\ntext\n\n\n\n##### C\n\n```md\n## keep\n```\n## "
    out = normalize_body(body, "T", level=2)
    assert out == "**A.**\n\n**B.** text\n\n**C.**\n\n```md\n## keep\n```"
    assert normalize_body("## Deep", "T", level=6, allow_headings=True) == "###### Deep"


def test_assemble_document_and_audit(tmp_path: Path) -> None:
    out = tmp_path / "out"
    (out / "sections").mkdir(parents=True)
    g = DocGraph.new({"title": "My Book"})
    g.add_node("1", "book", {"title": "Chapter"})
    g.add_node("1-1", "1", {"title": "First"})
    g.add_node("1-2", "1", {"title": "Second"})
    g.add_node("2", "book", {"title": "Legacy"})
    (out / "sections" / "1-1.md").write_text("First body [kb_a_pdf_1_page_2_1].\n\n![fig](figures/missing.png)", encoding="utf-8")
    (out / "sections" / "2.tex").write_text("Old body \\cite{kb_nope}.", encoding="utf-8")
    doc = assemble_document(g, out, index=_index(), language="en", author="A. Author")
    md = markdown_for_humans(doc)
    assert md.startswith("# My Book\n\n**Author:** A. Author\n\n## Chapter\n\n### First\n\nFirst body [1].")
    assert "## Legacy" in md and "Old body [2]." in md and "## References" in md and "{.unnumbered}" not in md
    assert doc.missing == ["1-2"] and doc.legacy_tex
    report = audit_sections(doc.sections, index=_index(), out_dir=out, mode="strict", missing=doc.missing)
    codes = sorted(f.code for f in report.findings)
    assert codes == ["MISSING_FIGURE", "MISSING_SECTION", "UNKNOWN_CITE_KEY"]
    assert len(report.errors) == 2
    report.dump(out / "audit_report.json")
    assert (out / "audit_report.json").exists()


def test_web_reference_formatting() -> None:
    from engine.assemble.citations import format_reference

    ref = Reference(key="web_x", kind="web", title="A Paper", url="https://doi.org/10.1/x", authors=["Doe, J."], year="2024", doi="10.1/x")
    text = format_reference(ref, "web_x")
    assert "Doe, J." in text and "A Paper" in text and "doi:10.1/x" in text and "<https://doi.org/10.1/x>" in text
