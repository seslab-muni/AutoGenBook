"""Assembly stage shared by the document types: Markdown, audit, LaTeX, PDF."""

from __future__ import annotations

import asyncio
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from engine.assemble.audit import AuditReport, audit_sections
from engine.assemble.bibtex import write_bib
from engine.assemble.citations import CitationIndex, Numbering, Reference, bibliography_lines, resolve_numeric
from engine.assemble.latex import LatexError, compile_pdf, markdown_to_latex
from engine.assemble.markdown import AssembledDocument, assemble_document, markdown_for_humans
from engine.graph.doc_graph import DocGraph
from engine.pipeline.context import RunContext
from engine.util.fs import atomic_write_text, read_json, safe_filename

Resolver = Callable[[str, Numbering, str], str]
Bibliography = Callable[[Numbering, str], list[str]]


@dataclass
class AssemblyStyle:
    """How a document type renders citations and LaTeX. The defaults are the
    book's: numbered references per cited passage, a bibliography section, the
    `book.latex` template with chapters."""

    template: str = "book.latex"
    top_level: str = "chapter"
    documentclass: str | None = None
    group: Callable[[CitationIndex], Callable[[str], str]] | None = None
    md_resolve: Resolver = resolve_numeric
    md_bibliography: Bibliography | None = bibliography_lines
    tex_resolve: Resolver | None = None  # None: same body as the Markdown
    tex_bibliography: Bibliography | None = bibliography_lines
    bib_writer: Callable[[Path, Numbering], object] = write_bib
    bibtex: bool = False  # run bibtex between LuaLaTeX passes
    front_matter: list[str] = field(default_factory=list)
    tex_front_matter: list[str] | None = None  # None: same as front_matter
    latex_vars: dict[str, str] = field(default_factory=dict)
    abstract: str | None = None
    toc: bool = True
    check_numeric_claims: bool = False
    pandoc_args: list[str] = field(default_factory=list)  # e.g. --natbib for pandoc-syntax citations


@dataclass
class AssemblyOutcome:
    outputs: list[Path] = field(default_factory=list)
    audit: AuditReport | None = None
    audit_blocked: bool = False
    pdf_failed: str | None = None
    export_failed: str | None = None  # a requested non-PDF export (e.g. PPTX) failed
    document: AssembledDocument | None = None


def load_citation_index(ctx: RunContext, extra: list[Reference] | None = None) -> CitationIndex:
    index = CitationIndex.from_kb_sources(read_json(ctx.paths.kb_sources))
    for ref in extra or []:
        # Web references known to this run carry more detail than their
        # kb_sources.json entry: they replace it.
        index.by_key[ref.key] = ref
        if ref.rid:
            index.rid_to_key[ref.rid] = ref.key
    return index


def _duration(seconds: float) -> str:
    seconds = max(0, int(round(seconds)))
    minutes, sec = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}h {minutes}m {sec}s"
    if minutes:
        return f"{minutes}m {sec}s"
    return f"{sec}s"


async def assemble_outputs(
    ctx: RunContext,
    graph: DocGraph,
    *,
    language: str,
    author: str,
    extra_refs: list[Reference] | None = None,
    style: AssemblyStyle | None = None,
) -> AssemblyOutcome:
    cfg = ctx.config
    sink = ctx.sink
    style = style or AssemblyStyle()
    outcome = AssemblyOutcome()
    index = load_citation_index(ctx, extra_refs)

    def numbering() -> Numbering:
        return Numbering(index, style.group(index) if style.group else None)

    t0 = time.perf_counter()
    doc = assemble_document(
        graph, cfg.out_dir, index=index, language=language, author=author, front_matter=style.front_matter,
        numbering=numbering(), resolve=style.md_resolve, bibliography=style.md_bibliography,
        body_headings=cfg.body_headings,
    )
    outcome.document = doc
    for key in doc.missing:
        sink.emit("markdown", f"Section '{graph.title(key)}' ({key}) has no content; left empty in the document", level="warning", node_key=key)
    stem = safe_filename(doc.title)
    if cfg.md_output:
        md_path = cfg.out_dir / f"{stem}.md"
        atomic_write_text(md_path, markdown_for_humans(doc))
        outcome.outputs.append(md_path)
        sink.emit("markdown", f"Markdown document written: {md_path.name} ({len(doc.sections)} sections, {len(doc.numbering.numbers)} references) in {_duration(time.perf_counter() - t0)}")
    if doc.numbering.numbers and (cfg.tex_output or cfg.pdf_output or cfg.mode == "paper"):
        style.bib_writer(cfg.out_dir / "refs.bib", doc.numbering)
        outcome.outputs.append(cfg.out_dir / "refs.bib")

    if cfg.audit_enabled:
        report = audit_sections(
            doc.sections, index=index, out_dir=cfg.out_dir, mode=cfg.audit_mode, missing=doc.missing,
            check_numeric_claims=style.check_numeric_claims,
        )
        report.dump(cfg.out_dir / "audit_report.json")
        outcome.audit = report
        counts = report.counts_by_severity
        sink.emit("info", f"Audit ({cfg.audit_mode}): {counts['error']} error(s), {counts['warning']} warning(s); see audit_report.json")
        if cfg.audit_mode == "strict" and report.errors:
            outcome.audit_blocked = True

    if not (cfg.tex_output or cfg.pdf_output):
        return outcome
    tex_doc = doc
    if style.tex_resolve is not None or style.tex_bibliography is not style.md_bibliography or style.tex_front_matter is not None:
        tex_doc = assemble_document(
            graph, cfg.out_dir, index=index, language=language, author=author,
            front_matter=style.front_matter if style.tex_front_matter is None else style.tex_front_matter,
            numbering=numbering(), resolve=style.tex_resolve or style.md_resolve, bibliography=style.tex_bibliography,
            body_headings=cfg.body_headings,
        )
    t0 = time.perf_counter()
    tex_dir = cfg.out_dir if cfg.tex_output else Path(tempfile.mkdtemp(prefix="engine_tex_"))
    tex_path = tex_dir / f"{stem}.tex"
    if not cfg.tex_output and (cfg.out_dir / "refs.bib").exists():
        (tex_dir / "refs.bib").write_bytes((cfg.out_dir / "refs.bib").read_bytes())
    try:
        await asyncio.to_thread(
            markdown_to_latex,
            tex_doc.body_markdown,
            tex_path,
            title=doc.title,
            author=author,
            language=language,
            template=style.template,
            top_level=style.top_level,
            documentclass=style.documentclass,
            raw_tex=doc.legacy_tex,  # generated Markdown never passes raw TeX through
            graphics_path=cfg.out_dir,
            abstract=style.abstract,
            toc=style.toc,
            extra_args=[arg for name, value in style.latex_vars.items() for arg in ("-V", f"{name}={value}")] + list(style.pandoc_args),
        )
    except LatexError as exc:
        outcome.pdf_failed = str(exc)
        sink.emit("latex", f"LaTeX export failed: {exc}", level="warning")
        return outcome
    if cfg.tex_output:
        outcome.outputs.append(tex_path)
        sink.emit("latex", f"LaTeX written: {tex_path.name} in {_duration(time.perf_counter() - t0)}")
    if not cfg.pdf_output:
        return outcome
    if outcome.audit_blocked:
        sink.emit("pdf", "PDF not built: the strict audit found errors (see audit_report.json)", level="warning")
        return outcome
    t0 = time.perf_counter()
    pdf_path = cfg.out_dir / f"{stem}.pdf"
    try:
        result = await asyncio.to_thread(compile_pdf, tex_path, pdf_path, log_dir=ctx.paths.logs, bibtex=style.bibtex)
    except LatexError as exc:
        outcome.pdf_failed = str(exc)
        sink.emit("pdf", f"PDF export failed: {exc}", level="warning")
        return outcome
    if result.ok:
        outcome.outputs.append(pdf_path)
        sink.emit("pdf", f"PDF written: {pdf_path.name} in {_duration(time.perf_counter() - t0)}")
        if result.errors:
            sink.emit("pdf", f"LuaLaTeX reported {len(result.errors)} problem(s); first: {result.errors[0]}", level="warning")
    else:
        outcome.pdf_failed = "; ".join(result.errors[:3])
        sink.emit("pdf", f"PDF compilation failed: {outcome.pdf_failed}", level="warning")
    return outcome
