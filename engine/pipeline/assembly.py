"""Assembly stage shared by the document types: Markdown, audit, LaTeX, PDF."""

from __future__ import annotations

import asyncio
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

from engine.assemble.audit import AuditReport, audit_sections
from engine.assemble.bibtex import write_bib
from engine.assemble.citations import CitationIndex, Reference
from engine.assemble.latex import LatexError, compile_pdf, markdown_to_latex
from engine.assemble.markdown import AssembledDocument, assemble_document, markdown_for_humans
from engine.graph.doc_graph import DocGraph
from engine.pipeline.context import RunContext
from engine.util.fs import atomic_write_text, read_json, safe_filename


@dataclass
class AssemblyOutcome:
    outputs: list[Path] = field(default_factory=list)
    audit: AuditReport | None = None
    audit_blocked: bool = False
    pdf_failed: str | None = None
    document: AssembledDocument | None = None


def load_citation_index(ctx: RunContext, extra: list[Reference] | None = None) -> CitationIndex:
    index = CitationIndex.from_kb_sources(read_json(ctx.paths.kb_sources))
    for ref in extra or []:
        index.add(ref)
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
    template: str = "book.latex",
    top_level: str = "chapter",
    documentclass: str | None = None,
    front_matter: list[str] | None = None,
    abstract: str | None = None,
    check_numeric_claims: bool = False,
    extra_refs: list[Reference] | None = None,
    bibtex_in_pdf: bool = False,
) -> AssemblyOutcome:
    cfg = ctx.config
    sink = ctx.sink
    outcome = AssemblyOutcome()
    index = load_citation_index(ctx, extra_refs)
    t0 = time.perf_counter()
    doc = assemble_document(graph, cfg.out_dir, index=index, language=language, author=author, front_matter=front_matter)
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
        write_bib(cfg.out_dir / "refs.bib", doc.numbering)
        outcome.outputs.append(cfg.out_dir / "refs.bib")

    if cfg.audit_enabled:
        report = audit_sections(
            doc.sections, index=index, out_dir=cfg.out_dir, mode=cfg.audit_mode, missing=doc.missing,
            check_numeric_claims=check_numeric_claims,
        )
        report.dump(cfg.out_dir / "audit_report.json")
        outcome.audit = report
        counts = report.counts_by_severity
        sink.emit("info", f"Audit ({cfg.audit_mode}): {counts['error']} error(s), {counts['warning']} warning(s); see audit_report.json")
        if cfg.audit_mode == "strict" and report.errors:
            outcome.audit_blocked = True

    if not (cfg.tex_output or cfg.pdf_output):
        return outcome
    t0 = time.perf_counter()
    tex_dir = cfg.out_dir if cfg.tex_output else Path(tempfile.mkdtemp(prefix="engine_tex_"))
    tex_path = tex_dir / f"{stem}.tex"
    try:
        await asyncio.to_thread(
            markdown_to_latex,
            doc.body_markdown,
            tex_path,
            title=doc.title,
            author=author,
            language=language,
            template=template,
            top_level=top_level,
            documentclass=documentclass,
            raw_tex=doc.legacy_tex,
            graphics_path=cfg.out_dir,
            abstract=abstract,
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
        result = await asyncio.to_thread(compile_pdf, tex_path, pdf_path, log_dir=ctx.paths.logs, bibtex=bibtex_in_pdf)
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
