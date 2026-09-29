"""Book pipeline (#153): task DAG, parallel drafting, glossary, one
review/revise round, length control, consistency pass, resume rules.

Run kinds (contract 3.5) fall out of one rule - rebuild the DAG, mark every
task whose output exists as done, run the rest:
- full run: no usable graph -> structure (outline from TXT or JSON, then
  subdivision) -> generation -> assembly;
- retry: `--resume` with a matching graph -> leaves whose section file exists
  are skipped, interrupted chains resume after their last finished stage;
- regenerate one node: same, the API deleted exactly that section file and
  cleared its `content_file_path` (a `Writing instructions:` trailer in its
  summary is part of the writer's brief);
- export: every leaf exists -> nothing is generated, only assembly.
"""

from __future__ import annotations

import asyncio
import math
import time
from pathlib import Path
from typing import Any

from engine.agents.base import Agent
from engine.agents.models import (
    BookMetadata,
    BookOutline,
    ConsistencyReport,
    Glossary,
    LengthAdjustment,
    ReviewIssue,
    SectionDraft,
    SectionReview,
    SectionRevision,
    SubdivisionPlan,
)
from engine.assemble.citations import CitationIndex, Reference, cited_keys
from engine.assemble.markdown import read_section, section_path, strip_writing_instructions
from engine.errors import EXIT_AUDIT, EXIT_FAILURE, EngineError, SchemaError
from engine.graph.doc_graph import DocGraph
from engine.graph.keys import ROOT, child_key
from engine.pipeline.assembly import assemble_outputs
from engine.pipeline.context import RunContext
from engine.pipeline.plan import STAGES, GenerationPlan, LeafStatus, TaskSpec, plan_generation, plan_structure, plan_subdivision_resume
from engine.pipeline.resume import decide_resume
from engine.pipeline.scheduler import Scheduler, Task
from engine.pipeline.state import SectionMeta, WorkStore, fingerprint
from engine.pipeline.text import (
    LENGTH_TOLERANCE,
    clean_body,
    dumps,
    effective_lines,
    equation_guidance,
    glossary_text,
    heading_rule,
    invalid_citations,
    lines_to_words,
    outline_text,
    strip_citations,
    target_lines,
    word_count,
)
from engine.retrieval.scope import resolve_kb_sources
from engine.retrieval.service import RetrievalService
from engine.runner import PipelineOutcome
from engine.spec.book_txt import BookSpec, parse_book_txt
from engine.spec.language import detect_language, language_name, normalize_language
from engine.spec.models import graph_from_structure, normalize_structure
from engine.util.fs import atomic_write_bytes, atomic_write_json, atomic_write_text, read_json, sha256_file

OUTLINE = Agent("book/outline", BookOutline, "book.outline")
METADATA = Agent("book/metadata", BookMetadata, "book.metadata")
SUBDIVIDE = Agent("book/subdivide", SubdivisionPlan, "book.subdivide")
GLOSSARY = Agent("book/glossary", Glossary, "book.glossary")
WRITER = Agent("book/writer", SectionDraft, "book.writer")
REVIEWER = Agent("book/reviewer", SectionReview, "book.reviewer", temperature=0.1)
REVISER = Agent("book/reviser", SectionRevision, "book.reviser")
LENGTH = Agent("book/length", LengthAdjustment, "book.length")
CONSISTENCY = Agent("book/consistency", ConsistencyReport, "book.consistency", temperature=0.1)

MAX_REVISION_ROUNDS = 2
MAX_LENGTH_PASSES = 2


def _duration(seconds: float) -> str:
    seconds = max(0, int(round(seconds)))
    minutes, sec = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}h {minutes}m {sec}s"
    return f"{minutes}m {sec}s" if minutes else f"{sec}s"


def _short(text: str, limit: int) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[: limit - 3].rstrip() + "..."


class BookRun:
    doc_type = "book"
    # Quality passes whose failure is reported but neither blocks dependents
    # nor fails the run (drafts proceed without a glossary, a book whose
    # consistency pass failed is still complete).
    optional_kinds: frozenset[str] = frozenset({"glossary", "consistency"})
    agents = {
        "outline": OUTLINE, "metadata": METADATA, "subdivide": SUBDIVIDE, "glossary": GLOSSARY, "writer": WRITER,
        "reviewer": REVIEWER, "reviser": REVISER, "length": LENGTH, "consistency": CONSISTENCY,
    }

    def __init__(self, ctx: RunContext) -> None:
        self.ctx = ctx
        self.cfg = ctx.config
        self.sink = ctx.sink
        self.paths = ctx.paths
        self.graph: DocGraph | None = None
        self.spec: BookSpec = BookSpec()
        self.input_text = ""
        self.input_sha = ""
        self.language = "en"
        self.author = ""
        self.retrieval = RetrievalService(
            self.cfg.retrieval, self.sink, lambda: ctx.llm, out_dir=self.cfg.out_dir, http_factory=lambda: ctx.llm.http
        )
        self.work = WorkStore(self.paths.work)
        self.meta = SectionMeta(self.paths.work / "sections.json")
        self.glossary: Glossary | None = None
        self.index = CitationIndex.from_kb_sources(read_json(self.paths.kb_sources))
        self.web_refs: dict[str, Reference] = {}
        self.snapshot: dict[str, Path] = {}
        self.leaf_order: list[str] = []
        self.plan: GenerationPlan | None = None
        self.locked: set[str] = set()
        self.finished: list[str] = []
        self.patched: list[str] = []
        self.scheduler = Scheduler(
            workers=self.cfg.concurrency,
            fail_fast=lambda exc: self.cfg.fail_fast_schema and isinstance(exc, SchemaError),
            on_failure=self._on_failure,
        )
        self.gen_started = 0.0
        self.resumed = False  # this run continues a saved structure (--resume accepted)

    # ================================================================== run
    async def run(self) -> PipelineOutcome:
        cfg = self.cfg
        self.input_text = cfg.input_path.read_text(encoding="utf-8", errors="replace")
        self.input_sha = sha256_file(cfg.input_path)
        self.spec = self.parse_spec(self.input_text)
        decision = decide_resume(cfg, self.input_sha, self.sink)
        has_kb = cfg.kb_dir is not None
        need_dense = has_kb and cfg.retrieval.dense != "none"
        run_kind = "full"
        if decision.accepted and decision.graph is not None and self._subdivision_interrupted(decision.graph):
            # This engine saved the structure but was stopped before subdivision
            # finished: finish it (no outline call), then plan as usual.
            self.graph = decision.graph
            self._resolve_language_and_author()
            self._stamp_graph()
            self.graph.save(self.paths.graph)
            self.sink.emit("resume", "The saved structure was interrupted during subdivision; finishing it before generating")
            run_kind = "resume"
            self.resumed = True
            for spec in plan_subdivision_resume(has_kb=has_kb, need_dense=need_dense):
                self._add(spec)
            if not has_kb and cfg.retrieval.enable_web:
                self.retrieval.enable_web_only()
        elif decision.accepted and decision.graph is not None:
            self.resumed = True
            self.graph = decision.graph
            self._resolve_language_and_author()
            self._stamp_graph()
            self.graph.save(self.paths.graph)
            statuses = self._prepare_leaves(resumed=True)
            todo = [s for s in statuses if not s.done]
            extra = self.pending_extra(statuses)
            run_kind = "resume" if (todo or extra) else "export"
            kb_tasks: list[str] = []
            if has_kb and (todo or not self.paths.kb_sources.exists()):
                self._add(TaskSpec("kb.build", "kb.build", priority=100))
                kb_tasks.append("kb.build")
                if todo and need_dense:
                    self._add(TaskSpec("kb.embed", "kb.embed", ("kb.build",), priority=90))
                    kb_tasks.append("kb.embed")
            elif cfg.retrieval.enable_web:
                self.retrieval.enable_web_only()
            if todo or extra:
                self._add_generation(statuses, kb_tasks)
            else:
                self.sink.emit("generate", f"All {len(statuses)} sections exist; assembling only")
        else:
            # A full run owns the work dir: intermediate results of an earlier
            # (refused or different) run must not leak into this one.
            self.clear_work()
            from_txt = self._structure_from_txt(force_txt=decision.force_txt)
            for spec in plan_structure(has_kb=has_kb, need_dense=need_dense, from_txt=from_txt):
                self._add(spec)
            if not has_kb and cfg.retrieval.enable_web:
                self.retrieval.enable_web_only()
        self.gen_started = time.perf_counter()
        result = await self.scheduler.run()
        outcome = PipelineOutcome(run_kind=run_kind)
        outcome.stats = {
            "leaves": len(self.leaf_order),
            "generated": len(self.finished),
            "skipped": len(self.plan.skipped) if self.plan else len(self.leaf_order),
            "locked": sorted(self.locked),
            "patched": self.patched,
            "failed_tasks": sorted(result.failed),
            "skipped_tasks": sorted(result.skipped),
            "optional_failed": sorted(result.soft_failed),
        }
        if self.finished:
            self.sink.emit("generate", f"Duration: {_duration(time.perf_counter() - self.gen_started)} ({len(self.finished)} sections)")
        if self.graph is None:
            raise self._first_error(result) or EngineError("no document structure was produced")
        self._persist_web_refs()
        assembly = await self.assemble()
        outcome.outputs = assembly.outputs
        if not result.ok:
            outcome.exit_code = EXIT_FAILURE
            outcome.error = self._failure_message(result)
        elif assembly.audit_blocked:
            outcome.exit_code = EXIT_AUDIT
            outcome.error = "Book audit failed in strict mode. See audit_report.json for details."
        elif assembly.pdf_failed and (cfg.pdf_output or cfg.tex_requested):
            outcome.exit_code = EXIT_FAILURE
            outcome.error = f"{'PDF' if cfg.pdf_output else 'LaTeX'} export failed: {assembly.pdf_failed}"
        elif assembly.export_failed:
            outcome.exit_code = EXIT_FAILURE
            outcome.error = assembly.export_failed
        return outcome

    # ----------------------------------------------------------- overrides
    def parse_spec(self, text: str) -> BookSpec:
        return parse_book_txt(text)

    def pending_extra(self, statuses: list[LeafStatus]) -> bool:
        """True when a resumed run has work besides missing leaves (e.g. a
        presentation's narration for existing slides)."""
        return False

    def clear_work(self) -> None:
        """A full run owns the output: intermediate results and per-section
        metadata of an earlier run must not leak into this one. (Its section
        and review files are removed once the new leaves are known, in
        `_prepare_leaves`, so content-lock sources are kept.)"""
        _clear_dir(self.paths.work / "work")
        self.meta.reset()
        for stale in self.full_run_artifacts():
            if stale.exists():
                stale.unlink()

    def full_run_artifacts(self) -> list[Path]:
        """Cached per-run artifacts a full run must regenerate, not reuse."""
        return [self.paths.glossary, self.cfg.out_dir / "consistency_report.json"]

    def raise_if_fail_fast(self, exc: BaseException) -> None:
        """`--fail-fast-schema` inside passes that collect per-item failures."""
        if self.cfg.fail_fast_schema and isinstance(exc, SchemaError):
            raise exc

    def needs_split(self, node: dict[str, Any], max_pages: float) -> bool:
        return bool(node.get("needsSubdivision")) or float(node.get("n_pages", 1.0)) >= max_pages

    async def assemble(self):  # noqa: ANN201 - AssemblyOutcome
        assert self.graph is not None
        return await assemble_outputs(
            self.ctx, self.graph, language=self.language, author=self.author, extra_refs=list(self.web_refs.values())
        )

    # ============================================================ plumbing
    def _add(self, spec: TaskSpec) -> None:
        runner = self._runner(spec)
        self.scheduler.add(
            Task(spec.id, spec.kind, runner, set(spec.deps), spec.node_key, spec.priority, spec.order,
                 critical=spec.kind in {"outline", "structure"}, optional=spec.kind in self.optional_kinds)
        )

    def _runner(self, spec: TaskSpec):  # noqa: ANN202
        kind, key = spec.kind, spec.node_key
        table = {
            "kb.build": self.task_kb_build,
            "kb.embed": self.task_kb_embed,
            "outline": self.task_outline,
            "structure": self.task_structure,
            "subdivide": self.task_subdivide,
            "glossary": self.task_glossary,
            "consistency": self.task_consistency,
        }
        extra = self.extra_runners()
        if kind in extra and key is not None:  # per-node kinds of a document type
            return lambda: extra[kind](key)
        table.update(extra)
        if kind in table:
            return table[kind]
        stage = {"draft": self.task_draft, "review": self.task_review, "revise": self.task_revise, "length": self.task_length}[kind]
        return lambda: stage(key)  # type: ignore[arg-type]

    def extra_runners(self) -> dict[str, Any]:
        """Task kinds a document type adds to the DAG (kind -> coroutine factory)."""
        return {}

    def _on_failure(self, task: Task, exc: BaseException) -> None:
        if isinstance(exc, asyncio.CancelledError):
            return
        where = f"section '{self.graph.title(task.node_key)}' ({task.node_key})" if (task.node_key and self.graph) else task.kind
        tail = " (optional pass; continuing without it)" if task.optional else ""
        self.sink.emit("generate", f"{task.kind} failed for {where}: {str(exc)[:300]}{tail}", level="warning", node_key=task.node_key)

    def _first_error(self, result) -> BaseException | None:  # noqa: ANN001
        for exc in result.failed.values():
            if not isinstance(exc, asyncio.CancelledError):
                return exc
        return None

    def _failure_message(self, result) -> str:  # noqa: ANN001
        first = self._first_error(result)
        failed_leaves = sorted({t.split(":", 1)[1] for t in result.failed if ":" in t})
        head = f"{len(failed_leaves)} section(s) failed ({', '.join(failed_leaves[:10])})" if failed_leaves else f"{len(result.failed)} task(s) failed"
        if result.aborted and self.cfg.fail_fast_schema:
            head += "; aborted by --fail-fast-schema"
        return f"{head}: {first}" if first is not None else head

    # ------------------------------------------------------- run settings
    def resolve_language(self, structure_language: str | None = None, sample: str | None = None, *, saved: str | None = None) -> str:
        """The output language: --language, the saved graph's (`saved` stands in
        for a graph about to be built from a structure), the spec's, the
        structure JSON's, else detected (from `sample` or the graph/input)."""
        if saved is not None:
            graph_language = saved
        else:
            graph_language = str(self.graph.attrs.get("language") or "") if self.graph is not None else ""
        if self.cfg.language and not normalize_language(self.cfg.language) and not getattr(self, "_warned_language", False):
            self._warned_language = True
            self.sink.emit("info", f"Unknown language code '{self.cfg.language}'; detecting the language instead", level="warning")
        return (
            normalize_language(self.cfg.language)
            or normalize_language(graph_language)
            or normalize_language(self.spec.language)
            or normalize_language(structure_language)
            or detect_language(sample or self._language_sample())
        )

    def _resolve_language_and_author(self, structure_language: str | None = None) -> None:
        assert self.graph is not None
        self.language = self.resolve_language(structure_language)
        self.author = self.cfg.author or str(self.graph.attrs.get("author") or "") or (self.spec.author or "")

    def _language_sample(self) -> str:
        if self.graph is not None:
            nodes = list(self.graph.dfs())[:30]
            sample = " ".join(f"{self.graph.nodes[k].get('title', '')}. {strip_writing_instructions(str(self.graph.nodes[k].get('summary', '')))}" for k in nodes)
            if sample.strip(" ."):
                return sample
        return self.input_text

    def _stamp_graph(self) -> None:
        assert self.graph is not None
        attrs = self.graph.attrs
        attrs["input_path"] = str(self.cfg.input_path)
        attrs["input_sha256"] = self.input_sha
        attrs["doc_type"] = self.doc_type
        attrs["language"] = self.language
        if self.author:
            attrs["author"] = self.author
        attrs["engine"] = "engine"

    def _structure_from_txt(self, *, force_txt: bool = False) -> bool:
        cfg = self.cfg
        if cfg.use_txt:
            return True
        if cfg.use_json:
            return not cfg.json_path.exists()
        if force_txt and cfg.json_path.exists():
            self.sink.emit("json", f"Ignoring the existing {cfg.json_path.name} (it belongs to the previous input); generating a new structure from the TXT")
            return True
        return not cfg.json_path.exists()

    @staticmethod
    def _subdivision_interrupted(graph: DocGraph) -> bool:
        """A structure this engine saved before subdivision completed (graphs
        from the old engine or the API carry no such marker and are final)."""
        return graph.attrs.get("engine") == "engine" and graph.attrs.get("subdivision_complete") is False

    # ============================================================ KB tasks
    async def task_kb_build(self) -> None:
        # Web references cited by the sections this resumed run keeps live only
        # in kb_sources.json (loaded into self.index at start), which the KB
        # build rewrites: carry them over. A full run starts from scratch.
        previous = self.index.web_references() if self.resumed else []
        kb = await self.retrieval.build_kb()
        if kb is not None:
            self.index = CitationIndex.from_kb_sources(kb.kb_sources_json())
            for ref in previous:
                self.web_refs.setdefault(ref.key, ref)
                self.index.add(ref)
            if previous:
                self._persist_web_refs()

    async def task_kb_embed(self) -> None:
        await self.retrieval.prepare_dense()

    async def kb_overview(self, query: str, limit: int = 3500, *, lexical_only: bool = True) -> str:
        """KB passages for a whole-document prompt. BM25 only by default (the
        outline runs before the embeddings exist, and must not wait for them);
        the glossary, which runs after `kb.embed`, uses hybrid retrieval."""
        if self.retrieval.retriever is None:
            return "(no knowledge base)"
        context = await self.retrieval.context([query], k=6, lexical_only=lexical_only)
        text = context.text or "(nothing relevant found)"
        return text if len(text) <= limit else text[:limit] + "..."

    # ===================================================== structure tasks
    async def task_outline(self) -> None:
        t0 = time.perf_counter()
        spec = self.spec
        self.sink.emit("json", "Generating the book structure from the TXT spec")
        provisional = self.resolve_language(None, self.input_text)
        self.language = provisional
        total = float(spec.total_pages or 20.0)
        base_values = {"language_name": language_name(provisional), "spec_text": self.input_text.strip()[:30000]}
        if spec.has_outline:
            outline = "\n".join(self._spec_outline_lines(spec))
            meta = await self.agents["metadata"].run(self.ctx.llm, {**base_values, "outline": outline})
            childs = [node.to_structure() for node in spec.outline]
            raw = {
                "title": spec.title or meta.title,
                "summary": meta.summary or spec.summary,
                "n_pages": spec.total_pages or round(sum(c["n_pages"] for c in childs), 1),
                "target_readers": spec.target_readers or meta.target_readers,
                "additional_requirements": spec.additional_requirements or meta.additional_requirements,
                "equation_frequency_level": meta.equation_frequency_level,
                "childs": childs,
            }
        else:
            kb = await self.kb_overview(f"{spec.title}\n{spec.summary}")
            chapters_hint = max(3, min(12, int(round(total / 4))))
            out = await self.agents["outline"].run(
                self.ctx.llm, {**base_values, "total_pages": f"{total:g}", "chapter_hint": chapters_hint, "kb_overview": kb}
            )
            raw = self._structure_from_outline(out, total)
            for note in out.redundancy_notes[:10]:
                self.sink.emit("json", f"Redundancy check: {_short(note, 200)}")
        raw.setdefault("max_depth", 5)
        raw.setdefault("max_output_pages", 1.5)
        raw["language"] = provisional
        structure = normalize_structure(raw)
        atomic_write_json(self.cfg.json_path, structure.model_dump(exclude_none=True))
        self._set_graph(graph_from_structure(structure, doc_type=self.doc_type), structure.language)
        self.sink.emit("json", f"Structure: {len(structure.childs)} chapters, {len(self.graph.nodes) - 1} nodes, saved to {self.cfg.json_path.name}; duration {_duration(time.perf_counter() - t0)}")  # type: ignore[union-attr]

    def _spec_outline_lines(self, spec: BookSpec) -> list[str]:
        lines: list[str] = []

        def walk(nodes: list[Any], depth: int) -> None:
            for node in nodes:
                pages = f" ({node.n_pages:g} p.)" if node.n_pages else ""
                lines.append(f"{'  ' * depth}- {node.title}{pages}: {_short(node.summary, 200)}")
                walk(node.children, depth + 1)

        walk(spec.outline, 0)
        return lines

    def _structure_from_outline(self, out: BookOutline, total: float) -> dict[str, Any]:
        chapters = [c for c in out.chapters if c.title.strip()] or []
        if not chapters:
            raise EngineError("the outline agent returned no chapters")
        chapter_pages = _scale([max(0.1, float(c.n_pages or 1.0)) for c in chapters], total)
        childs: list[dict[str, Any]] = []
        for chapter, pages in zip(chapters, chapter_pages):
            sections = [s for s in chapter.sections if s.title.strip()]
            node: dict[str, Any] = {"title": chapter.title.strip(), "summary": chapter.summary.strip(), "n_pages": pages}
            if sections:
                section_pages = _scale([max(0.1, float(s.n_pages or 1.0)) for s in sections], pages)
                node["childs"] = [
                    {"title": s.title.strip(), "summary": s.summary.strip(), "n_pages": p} for s, p in zip(sections, section_pages)
                ]
            childs.append(node)
        return {
            "title": self.spec.title or out.title,
            "summary": out.summary or self.spec.summary,
            "n_pages": total,
            "target_readers": self.spec.target_readers or out.target_readers,
            "additional_requirements": self.spec.additional_requirements or out.additional_requirements,
            "equation_frequency_level": out.equation_frequency_level,
            "childs": childs,
        }

    async def task_structure(self) -> None:
        t0 = time.perf_counter()
        self.sink.emit("json", f"Loading the existing structure: {self.cfg.json_path.name}")
        raw = read_json(self.cfg.json_path)
        if not isinstance(raw, dict):
            raise EngineError(f"cannot read the structure JSON {self.cfg.json_path}")
        structure = normalize_structure(raw)
        self._set_graph(graph_from_structure(structure, doc_type=self.doc_type), structure.language)
        self.sink.emit("json", f"Structure: {len(structure.childs)} chapters; duration {_duration(time.perf_counter() - t0)}")

    def _set_graph(self, graph: DocGraph, structure_language: str | None) -> None:
        graph.attrs["subdivision_complete"] = False  # set True once task_subdivide finishes
        self.graph = graph
        self._resolve_language_and_author(structure_language)
        self._stamp_graph()
        graph.save(self.paths.graph)

    async def task_subdivide(self) -> None:
        assert self.graph is not None
        graph = self.graph
        t0 = time.perf_counter()
        max_depth = int(graph.attrs.get("max_depth", 5) or 5)
        max_pages = float(graph.attrs.get("max_output_pages", 1.5) or 1.5)
        count = 0
        for depth in range(1, max_depth):
            candidates = [
                key for key in graph.dfs()
                if key != ROOT and graph.depth(key) == depth and graph.is_leaf(key)
                and not graph.nodes[key].get("structure_locked") and not graph.nodes[key].get("content_locked")
                and self.needs_split(graph.nodes[key], max_pages)
            ]
            if not candidates:
                continue
            self.sink.emit("subdivide", f"Depth {depth}/{max_depth}: subdividing {len(candidates)} node(s)")
            # Outline snapshot per level: siblings run in parallel and must not see
            # each other's new children (prompts stay independent of scheduling).
            outlines = {key: outline_text(graph, focus=key) for key in candidates}
            results = await asyncio.gather(*(self._subdivide_node(key, max_pages, outlines[key]) for key in candidates), return_exceptions=True)
            for key, result in zip(candidates, results):
                if isinstance(result, BaseException):
                    if isinstance(result, asyncio.CancelledError):
                        raise result
                    self.raise_if_fail_fast(result)
                    self.sink.emit("subdivide", f"Could not subdivide '{graph.title(key)}' ({str(result)[:200]}); kept as one section", level="warning", node_key=key)
                    graph.nodes[key]["needsSubdivision"] = False
                else:
                    count += int(bool(result))
            graph.save(self.paths.graph)
        graph.attrs["subdivision_complete"] = True
        graph.save(self.paths.graph)
        self.sink.emit("subdivide", f"Duration: {_duration(time.perf_counter() - t0)} ({count} node(s) subdivided, {len(graph.leaves())} leaves)")
        statuses = self._prepare_leaves(resumed=False)
        kb_tasks = [t for t in ("kb.build", "kb.embed") if t in self.scheduler.tasks]
        self._add_generation(statuses, kb_tasks)

    async def _subdivide_node(self, key: str, max_pages: float, outline: str) -> bool:
        graph = self.graph
        assert graph is not None
        node = graph.nodes[key]
        pages = float(node.get("n_pages", 1.0))
        suggested = max(2, min(8, math.ceil(pages / max_pages)))
        context = "(none)"
        if self.retrieval.retriever is not None:
            ctx = await self.retrieval.context([f"{node.get('title', '')}\n{strip_writing_instructions(str(node.get('summary', '')))}"],
                                               kb_sources=resolve_kb_sources(graph, key), k=6, lexical_only=True)
            context = ctx.text or "(none)"
        values = {
            "language_name": language_name(self.language),
            "document_kind": self.doc_type,
            "book_title": graph.nodes[ROOT].get("title", ""),
            "book_summary": _short(str(graph.nodes[ROOT].get("summary", "")), 1500),
            "target_readers": graph.attrs.get("target_readers", "") or "(not specified)",
            "outline": outline,
            "parent_title": node.get("title", ""),
            "parent_summary": node.get("summary", ""),
            "n_pages": f"{pages:g}",
            "max_output_pages": f"{max_pages:g}",
            "suggested_count": suggested,
            "retrieved_context": context,
        }
        plan = await self.agents["subdivide"].run(self.ctx.llm, values, node_key=key)
        sections = [s for s in plan.sections if s.title.strip()]
        if len(sections) < 2:
            node["needsSubdivision"] = False
            self.sink.emit("subdivide", f"'{node.get('title', '')}' needs no split", node_key=key)
            return False
        child_pages = _scale([max(0.1, float(s.n_pages or 0.5)) for s in sections], pages)
        graph.remove_children(key)
        for index, (section, child_pages_value) in enumerate(zip(sections, child_pages), start=1):
            graph.add_node(
                child_key(key, index), key,
                {"title": section.title.strip(), "summary": section.summary.strip(), "n_pages": child_pages_value,
                 "needsSubdivision": child_pages_value >= max_pages, "structure_locked": False},
            )
        graph.save(self.paths.graph)
        self.sink.emit("subdivide", f"'{node.get('title', '')}' -> {len(sections)} subsections", node_key=key)
        return True

    # ======================================================== generation
    def _prepare_leaves(self, *, resumed: bool) -> list[LeafStatus]:
        """Honour content locks, mark existing sections, find interrupted chains."""
        assert self.graph is not None
        graph = self.graph
        self.leaf_order = graph.leaves()
        total = len(self.leaf_order)
        statuses: list[LeafStatus] = []
        changed = False
        # Read every lock source before writing any: a source may be another
        # leaf's section file (e.g. keys shifted after an inserted chapter).
        lock_data = {key: self._read_lock(key, graph.nodes[key]) for key in self.leaf_order if graph.nodes[key].get("content_locked")}
        for position, key in enumerate(self.leaf_order, start=1):
            node = graph.nodes[key]
            locked = self._materialize_lock(key, node, lock_data.get(key))
            if locked is not None:
                self.locked.add(key)
                self.snapshot[key] = locked
                changed = True
                self.sink.emit("generate", f"{position}/{total} Locked section '{node.get('title', '')}' (kept, used as context)", node_key=key)
                statuses.append(LeafStatus(key, done=True))
                continue
            # Only a resumed run reuses section files; a full run (including one
            # whose --resume was refused) regenerates every leaf.
            existing = section_path(self.cfg.out_dir, key, node) if resumed else None
            if existing is not None:
                self.snapshot[key] = existing
                resolved = str(existing.resolve())
                if node.get("content_file_path") != resolved:
                    node["content_file_path"] = resolved
                    changed = True
                if resumed:
                    self.sink.emit("resume", f"{position}/{total} Skipping existing section '{node.get('title', '')}'", node_key=key)
                statuses.append(LeafStatus(key, done=True))
                continue
            if node.get("content_file_path"):
                node["content_file_path"] = ""
                changed = True
            statuses.append(LeafStatus(key, resume_after=self.work.last_stage(key, self._fp(key), STAGES[:-1])))
        if not resumed:
            self._remove_stale_outputs()
        if changed:
            graph.save(self.paths.graph)
        return statuses

    def _remove_stale_outputs(self) -> None:
        """A full run regenerates every unlocked leaf: section and review
        files left by an earlier run (possibly of another structure, under the
        same positional keys) must not be assembled or imported. Materialised
        locks and files that serve as a lock's `content_file` are kept."""
        assert self.graph is not None
        keep: set[Path] = set()
        for key in self.locked:
            keep.add(self.paths.section(key).resolve())
        for node in self.graph.nodes.values():
            raw = str(node.get("content_file") or "").strip() if node.get("content_locked") else ""
            if raw:
                source = Path(raw).expanduser()
                keep.add((source if source.is_absolute() else self.cfg.out_dir / source).resolve())
        for folder in (self.paths.sections, self.paths.reviews):
            if not folder.is_dir():
                continue
            for path in folder.iterdir():
                if not path.is_file() or path.resolve() in keep:
                    continue
                stem = path.name.split(".", 1)[0].removesuffix("_revised")
                if stem in self.locked and folder == self.paths.reviews:
                    continue
                try:
                    path.unlink()
                except OSError:
                    pass

    def _materialize_lock(self, key: str, node: dict[str, Any], data: bytes | None) -> Path | None:
        """Content lock (issue #113): write the lock's text (read beforehand by
        `_read_lock`) byte for byte to `sections/<key>.md`."""
        if data is None:
            return None
        target = self.paths.section(key)
        if not (target.exists() and target.read_bytes() == data):
            atomic_write_bytes(target, data)
        node["content_file_path"] = str(target.resolve())
        return target

    def _read_lock(self, key: str, node: dict[str, Any]) -> bytes | None:
        """The `content_file` bytes of a content-locked leaf; fail open with a
        [WARN] (the leaf is generated) when it cannot be read."""
        if not node.get("content_locked"):
            return None
        title = node.get("title", "") or "(untitled)"
        raw = str(node.get("content_file") or "").strip()
        if not raw:
            self.sink.emit("generate", f"Section '{title}' is content-locked but has no content_file; generating it instead.", level="warning", node_key=key)
            return None
        source = Path(raw).expanduser()
        if not source.is_absolute():
            source = self.cfg.out_dir / source
        try:
            data = source.read_bytes()
        except OSError as exc:
            self.sink.emit("generate", f"Section '{title}' is content-locked but '{source.name}' could not be read ({exc}); generating it instead.", level="warning", node_key=key)
            return None
        if not data.strip():
            self.sink.emit("generate", f"Section '{title}' is content-locked but '{source.name}' is empty; generating it instead.", level="warning", node_key=key)
            return None
        return data

    def _add_generation(self, statuses: list[LeafStatus], kb_tasks: list[str]) -> None:
        glossary = self._load_glossary()
        todo = [s for s in statuses if not s.done]
        self.plan = plan_generation(
            statuses,
            context_mode=self.cfg.context_mode,
            need_glossary=bool(todo) and glossary is None,
            kb_deps=kb_tasks,
            consistency=bool(todo),
        )
        if glossary is not None:
            self.glossary = glossary
        for spec in self.extend_plan(self.plan):
            self._add(spec)

    def extend_plan(self, plan: GenerationPlan) -> list[TaskSpec]:
        """Hook for document types to add tasks/dependencies to the generation plan."""
        return list(plan.tasks)

    def _fp(self, key: str) -> str:
        assert self.graph is not None
        node = self.graph.nodes[key]
        return fingerprint(node.get("title"), node.get("summary"), node.get("n_pages"), self.language, self.cfg.context_mode)

    def _glossary_fp(self) -> str:
        """The glossary depends on the whole brief: titles and summaries of the
        outline, readers, requirements and language."""
        assert self.graph is not None
        attrs = self.graph.attrs
        return fingerprint(
            # Without the per-node "Writing instructions:" a regeneration adds.
            [(self.graph.nodes[k].get("title"), strip_writing_instructions(str(self.graph.nodes[k].get("summary") or ""))) for k in self.graph.dfs()],
            attrs.get("target_readers"), attrs.get("additional_requirements"), self.language,
        )

    def _load_glossary(self) -> Glossary | None:
        data = read_json(self.paths.glossary)
        if isinstance(data, dict) and data.get("fingerprint") == self._glossary_fp():
            try:
                return Glossary.model_validate(data.get("glossary") or {})
            except ValueError:
                return None
        return None

    async def task_glossary(self) -> None:
        assert self.graph is not None
        graph = self.graph
        self.sink.emit("generate", f"Writing the {self.doc_type} glossary (terminology, notation, audience and tone)")
        values = {
            "language_name": language_name(self.language),
            "document_kind": self.doc_type,
            "book_title": graph.nodes[ROOT].get("title", ""),
            "book_summary": _short(str(graph.nodes[ROOT].get("summary", "")), 2000),
            "target_readers": graph.attrs.get("target_readers", "") or "(not specified)",
            "additional_requirements": graph.attrs.get("additional_requirements", "") or "(none)",
            "outline": outline_text(graph, with_summaries="all", max_summary=160),
            "kb_overview": await self.kb_overview(f"{graph.nodes[ROOT].get('title', '')}\n{graph.nodes[ROOT].get('summary', '')}", lexical_only=False),
        }
        self.glossary = await self.agents["glossary"].run(self.ctx.llm, values)
        atomic_write_json(self.paths.glossary, {"fingerprint": self._glossary_fp(), "glossary": self.glossary.model_dump()})

    # ------------------------------------------------------ leaf helpers
    def _position(self, key: str) -> tuple[int, int]:
        return self.leaf_order.index(key) + 1, len(self.leaf_order)

    def _queries(self, key: str) -> list[str]:
        assert self.graph is not None
        node = self.graph.nodes[key]
        title = str(node.get("title", ""))
        summary = strip_writing_instructions(str(node.get("summary", "")))
        queries = [f"{title}\n{summary}".strip()]
        parent = self.graph.parent.get(key)
        focus = title
        if parent and parent != ROOT:
            focus = f"{self.graph.title(parent)}: {title}"
        if self.glossary is not None:
            text = f"{title} {summary}".casefold()
            terms = [t.term for t in self.glossary.terms if t.term and t.term.casefold() in text][:5]
            if terms:
                focus += " (" + ", ".join(terms) + ")"
        if focus != queries[0]:
            queries.append(focus)
        return queries

    async def _retrieve(self, key: str, queries: list[str]):  # noqa: ANN202
        assert self.graph is not None
        allow_web = self.cfg.retrieval.enable_web
        context = await self.retrieval.context(
            queries, kb_sources=resolve_kb_sources(self.graph, key), allow_web=allow_web,
            node_title=self.graph.title(key), node_key=key,
        )
        for item in context.items:
            if item.kind == "web" and item.cite_key not in self.web_refs:
                ref = Reference(key=item.cite_key, kind="web", title=item.title or "", url=item.url or "", rid=item.rid, doi=item.doi or "", excerpt=item.text[:120])
                self.web_refs[item.cite_key] = ref
                self.index.add(ref)
        return context

    def _neighbours(self, key: str) -> str:
        assert self.graph is not None
        graph = self.graph
        consider_prev = bool(graph.attrs.get("do_consider_previous_sections", True))
        position = self.leaf_order.index(key)
        prev_key = self.leaf_order[position - 1] if position > 0 else None
        next_key = self.leaf_order[position + 1] if position + 1 < len(self.leaf_order) else None
        parts: list[str] = []
        parent = graph.parent.get(key)
        if parent and parent != ROOT:
            parts.append(f"Part of: {graph.title(parent)} - {_short(strip_writing_instructions(str(graph.nodes[parent].get('summary', ''))), 400)}")
        for label, other in (("Previous section", prev_key), ("Next section", next_key)):
            if other is not None:
                summary = _short(strip_writing_instructions(str(graph.nodes[other].get("summary", ""))), 300)
                parts.append(f"{label} ({other} {graph.title(other)}): {summary}")
        if consider_prev and prev_key is not None:
            if self.cfg.context_mode == "chained":
                path = section_path(self.cfg.out_dir, prev_key, graph.nodes[prev_key])
                if path is not None:
                    parts.append(f"Full text of the previous section (continue from it; do not repeat it):\n<<<\n{read_section(path)[-6000:]}\n>>>")
            elif prev_key in self.snapshot:
                parts.append(f"End of the previous section, already written (connect to it; do not repeat it):\n<<<\n{read_section(self.snapshot[prev_key])[-1200:]}\n>>>")
        if consider_prev and next_key is not None and self.cfg.context_mode != "chained" and next_key in self.snapshot:
            parts.append(f"Beginning of the next section, already written (lead into it; do not cover it):\n<<<\n{read_section(self.snapshot[next_key])[:800]}\n>>>")
        return "\n".join(parts) or "(none)"

    def _outline_for(self, key: str) -> str:
        assert self.graph is not None
        if not bool(self.graph.attrs.get("do_consider_outline", True)):
            return "(outline not provided)"
        return outline_text(self.graph, focus=key)

    def _common(self, key: str) -> dict[str, Any]:
        assert self.graph is not None
        graph = self.graph
        node = graph.nodes[key]
        return {
            "language_name": language_name(self.language),
            "book_title": graph.nodes[ROOT].get("title", ""),
            "target_readers": graph.attrs.get("target_readers", "") or "(not specified)",
            "glossary": glossary_text(self.glossary),
            "neighbours": self._neighbours(key),
            "node_key": key,
            "section_title": node.get("title", ""),
            "section_summary": node.get("summary", "") or "(no summary)",
            "target_words": lines_to_words(target_lines(float(node.get("n_pages", 1.0)))),
        }

    def _citation_check(self, body: str) -> str:
        bad = invalid_citations(body, self.index)
        if bad:
            return "these cited keys are NOT in the knowledge base (errors): " + ", ".join(bad[:20])
        keys = cited_keys(body, self.index)
        return f"{len(keys)} distinct cited key(s), all present in the knowledge base" if keys else "the draft cites nothing"

    def reviewer_values(self, key: str, body: str, context: str) -> dict[str, Any]:
        return {**self._common(key), "retrieved_context": context, "citation_check": self._citation_check(body), "section_body": body}

    def writer_values(self, key: str, context: str) -> dict[str, Any]:
        assert self.graph is not None
        graph = self.graph
        return {
            **self._common(key),
            "book_summary": _short(str(graph.nodes[ROOT].get("summary", "")), 1500),
            "additional_requirements": graph.attrs.get("additional_requirements", "") or "(none)",
            "equation_guidance": equation_guidance(graph.attrs.get("equation_frequency_level", 3)),
            "outline": self._outline_for(key),
            "heading_rule": heading_rule(graph, key),
            "retrieved_context": context,
        }

    async def _review_body(self, key: str, body: str, context: str) -> SectionReview:
        return await self.agents["reviewer"].run(self.ctx.llm, self.reviewer_values(key, body, context), node_key=key)

    def _work(self, key: str, stage: str) -> dict[str, Any]:
        data = self.work.load(key, stage, self._fp(key))
        if data is None:
            raise EngineError(f"missing intermediate result '{stage}' for section {key}")
        return data

    # ------------------------------------------------------- leaf stages
    async def task_draft(self, key: str) -> None:
        assert self.graph is not None
        graph = self.graph
        node = graph.nodes[key]
        position, total = self._position(key)
        self.sink.emit("generate", f"{position}/{total} Starting section '{node.get('title', '')}'", node_key=key)
        for stale in (self.paths.review(key), self.paths.review(key, revised=True)):
            if stale.exists():
                stale.unlink()
        retrieved = await self._retrieve(key, self._queries(key))
        values = self.writer_values(key, retrieved.text or "(none)")
        draft = await self.agents["writer"].run(self.ctx.llm, values, node_key=key)
        body = clean_body(draft.body_markdown, str(node.get("title", "")), graph, key, self.index)
        if not body.strip():
            raise EngineError(f"the writer returned an empty section for {key}")
        self.work.save(key, "draft", self._fp(key), {
            "body": body, "summary": draft.summary, "key_terms": draft.key_terms, "context": retrieved.text or "(none)",
        })

    async def task_review(self, key: str) -> None:
        data = self._work(key, "draft")
        review = await self._review_body(key, data["body"], data["context"])
        atomic_write_json(self.paths.review(key), review.model_dump())
        self.work.save(key, "review", self._fp(key), {**data, "review": review.model_dump()})

    async def task_revise(self, key: str) -> None:
        assert self.graph is not None
        data = self._work(key, "review")
        review = SectionReview.model_validate(data["review"])
        body, context, summary = data["body"], data["context"], data.get("summary", "")
        rounds = 0
        while review.needs_revision and rounds < MAX_REVISION_ROUNDS:
            rounds += 1
            if review.retrieval_queries:
                extra = await self._retrieve(key, review.retrieval_queries[:3])
                if extra.text:
                    context = _merge_context(context, extra.text, self.cfg.retrieval.max_chars_total * 2)
            values = {
                **self._common(key),
                "document_kind": self.doc_type,
                "heading_rule": heading_rule(self.graph, key),
                "retrieved_context": context,
                "review_json": dumps(review.model_dump()),
                "section_body": body,
            }
            revision = await self.agents["reviser"].run(self.ctx.llm, values, node_key=key)
            revised = clean_body(revision.body_markdown, self.graph.title(key), self.graph, key, self.index)
            if revised.strip():
                body = revised
                summary = revision.summary or summary
            review = await self._review_body(key, body, context)
        if rounds:
            atomic_write_json(self.paths.review(key, revised=True), {**review.model_dump(), "revision_rounds": rounds})
        self.work.save(key, "revise", self._fp(key), {**data, "body": body, "summary": summary, "context": context, "rounds": rounds})

    async def task_length(self, key: str) -> None:
        assert self.graph is not None
        data = self._work(key, "revise")
        body = data["body"]
        node = self.graph.nodes[key]
        target = target_lines(float(node.get("n_pages", 1.0)))
        low, high = round(target * (1 - LENGTH_TOLERANCE)), round(target * (1 + LENGTH_TOLERANCE))
        for _pass in range(MAX_LENGTH_PASSES):
            actual = effective_lines(body)
            if low <= actual <= high:
                break
            values = {
                "language_name": language_name(self.language),
                "document_kind": self.doc_type,
                "node_key": key,
                "section_title": node.get("title", ""),
                "direction": "Shorten" if actual > high else "Expand",
                "target_words": lines_to_words(target),
                "min_words": lines_to_words(low),
                "max_words": lines_to_words(high),
                "current_words": word_count(body),
                "section_body": body,
            }
            adjusted = await self.agents["length"].run(self.ctx.llm, values, node_key=key)
            candidate = clean_body(adjusted.body_markdown, str(node.get("title", "")), self.graph, key, self.index)
            if candidate.strip() and abs(effective_lines(candidate) - target) < abs(actual - target):
                body = candidate
            else:
                break
        await self._finish_leaf(key, body, data.get("summary", ""), data.get("key_terms", []))

    async def _finish_leaf(self, key: str, body: str, summary: str, key_terms: list[str]) -> None:
        assert self.graph is not None
        body = self._drop_invalid_citations(key, body)
        path = self.paths.section(key)
        atomic_write_text(path, body.rstrip() + "\n")
        self.graph.nodes[key]["content_file_path"] = str(path.resolve())
        self.graph.save(self.paths.graph)
        self.meta.set(key, {"summary": summary, "key_terms": key_terms[:20], "citations": cited_keys(body, self.index)[:20]})
        self.work.clear(key)
        self.finished.append(key)
        position, total = self._position(key)
        self.sink.emit("generate", f"{position}/{total} Generated section '{self.graph.title(key)}'", node_key=key)

    def _drop_invalid_citations(self, key: str, body: str) -> str:
        bad = invalid_citations(body, self.index)
        if not bad:
            return body
        self._merge_review_issues(key, [{
            "type": "citation", "severity": "major",
            "description": f"Removed citations of keys that are not in the knowledge base: {', '.join(bad[:10])}",
            "required_fix": "Support the affected statements with retrieved sources or rephrase them cautiously.",
        }])
        self.sink.emit("generate", f"Section {key}: removed {len(bad)} citation(s) of unknown keys", level="warning", node_key=key)
        return strip_citations(body, bad, self.index)

    def _merge_review_issues(self, key: str, issues: list[dict[str, Any]], **extra: Any) -> None:
        base = read_json(self.paths.review(key, revised=True)) or read_json(self.paths.review(key)) or {"ok_to_keep": True, "issues": []}
        if not isinstance(base, dict):
            base = {"ok_to_keep": True, "issues": []}
        base["issues"] = list(base.get("issues") or []) + issues
        base.update(extra)
        atomic_write_json(self.paths.review(key, revised=True), base)

    # -------------------------------------------------------- consistency
    async def task_consistency(self) -> None:
        assert self.graph is not None
        graph = self.graph
        overview: list[str] = []
        per_item = max(250, min(700, 60000 // max(1, len(self.leaf_order))))
        for key in self.leaf_order:
            path = section_path(self.cfg.out_dir, key, graph.nodes[key])
            if path is None:
                continue
            body = read_section(path)
            meta = self.meta.get(key) or {}
            summary = meta.get("summary") or strip_writing_instructions(str(graph.nodes[key].get("summary", "")))
            terms = ", ".join((meta.get("key_terms") or [])[:8])
            cites = ", ".join(cited_keys(body, self.index)[:8])
            flat = " ".join(body.split())
            entry = (
                f"[{key}] {graph.title(key)}\n  summary: {_short(summary, per_item // 2)}\n  terms: {terms or '-'}\n"
                f"  cites: {cites or '-'}\n  opening: {_short(flat[:400], per_item // 4)}\n  closing: {_short(flat[-400:], per_item // 4)}"
            )
            overview.append(entry)
        patchable = [k for k in self.plan.generated if k not in self.locked and k in self.finished] if self.plan else []
        max_patches = self.cfg.max_consistency_patches
        self.sink.emit("generate", f"Consistency pass over {len(overview)} sections")
        values = {
            "language_name": language_name(self.language),
            "document_kind": self.doc_type,
            "book_title": graph.nodes[ROOT].get("title", ""),
            "glossary": glossary_text(self.glossary, 2500),
            "sections": "\n".join(overview),
            "patchable": ", ".join(patchable) if patchable and max_patches else "(none)",
            "max_patches": max_patches if patchable else 0,
        }
        report = await self.agents["consistency"].run(self.ctx.llm, values)
        leaves = set(self.leaf_order)
        findings = []
        for finding in report.findings:
            keys = [k for k in finding.node_keys if k in leaves]
            if keys:
                finding.node_keys = keys
                findings.append(finding)
        patches = []
        seen: set[str] = set()
        for patch in report.patches:
            if patch.node_key in patchable and patch.node_key not in seen and len(patches) < max_patches:
                patches.append(patch)
                seen.add(patch.node_key)
        results = await asyncio.gather(*(self._apply_patch(p.node_key, p.instructions, findings) for p in patches), return_exceptions=True)
        for patch, result in zip(patches, results):
            if isinstance(result, BaseException):
                if isinstance(result, asyncio.CancelledError):
                    raise result
                self.raise_if_fail_fast(result)
                self.sink.emit("generate", f"Consistency patch for {patch.node_key} failed: {str(result)[:200]}", level="warning", node_key=patch.node_key)
            else:
                self.patched.append(patch.node_key)
        # Every finding reaches the UI through the affected sections' review files
        # (only sections written in this run: the others are not re-imported).
        for key in (self.plan.generated if self.plan else []):
            issues = [
                {"type": f"consistency:{f.type}", "severity": f.severity, "description": f.description, "required_fix": f.required_fix}
                for f in findings if key in f.node_keys
            ]
            if issues:
                self._merge_review_issues(key, issues, consistency_patched=key in self.patched)
        atomic_write_json(self.cfg.out_dir / "consistency_report.json", {
            "findings": [f.model_dump() for f in findings],
            "patched": self.patched,
            "patch_instructions": {p.node_key: p.instructions for p in patches},
        })
        self.sink.emit("generate", f"Consistency pass: {len(findings)} finding(s), {len(self.patched)} section(s) patched")

    async def _apply_patch(self, key: str, instructions: str, findings: list[Any]) -> None:
        assert self.graph is not None
        path = self.paths.section(key)
        body = read_section(path)
        issues = [
            ReviewIssue(type=f"consistency:{f.type}", severity=f.severity, description=f.description, required_fix=f.required_fix)
            for f in findings if key in f.node_keys
        ]
        issues.append(ReviewIssue(type="consistency", severity="major", description=instructions, required_fix=instructions))
        review = SectionReview(ok_to_keep=False, issues=issues)
        values = {
            **self._common(key),
            "document_kind": self.doc_type,
            "heading_rule": heading_rule(self.graph, key),
            "retrieved_context": "(the section's citations stay valid; do not add new ones)",
            "review_json": dumps(review.model_dump()),
            "section_body": body,
        }
        revision = await self.agents["reviser"].run(self.ctx.llm, values, node_key=key)
        revised = clean_body(revision.body_markdown, self.graph.title(key), self.graph, key, self.index)
        if revised.strip():
            revised = self._drop_invalid_citations(key, revised)
            atomic_write_text(path, revised.rstrip() + "\n")
            meta = self.meta.get(key) or {}
            self.meta.set(key, {**meta, "summary": revision.summary or meta.get("summary", ""), "citations": cited_keys(revised, self.index)[:20]})
            self.sink.emit("generate", f"Consistency fix applied to section '{self.graph.title(key)}'", node_key=key)

    # ------------------------------------------------------------ web refs
    def _persist_web_refs(self) -> None:
        """Web references cited in sections are added to kb_sources.json
        (`cite_keys`/`rids`, not `chunks`) so the API imports them too."""
        if not self.web_refs:
            return
        data = read_json(self.paths.kb_sources)
        if not isinstance(data, dict):
            data = {"cite_keys": {}, "rids": {}, "page_keys": {}, "chunks": []}
        for ref in self.web_refs.values():
            entry = {"source_path": ref.url, "loc": ref.url.split("/")[2] if "://" in ref.url else ref.url, "excerpt": ref.excerpt,
                     "kind": "web", "title": ref.title, "url": ref.url, "doi": ref.doi}
            data.setdefault("cite_keys", {})[ref.key] = entry
            if ref.rid:
                data.setdefault("rids", {})[ref.rid] = entry
        atomic_write_json(self.paths.kb_sources, data)


def _clear_dir(path: Path) -> None:
    if path.is_dir():
        for child in path.iterdir():
            if child.is_file():
                try:
                    child.unlink()
                except OSError:
                    pass


def _scale(values: list[float], total: float) -> list[float]:
    """Scale page budgets to `total`, rounded to tenths (min 0.1)."""
    current = sum(values) or 1.0
    scaled = [max(0.1, round(v * total / current, 1)) for v in values]
    return scaled


def _merge_context(base: str, extra: str, limit: int) -> str:
    blocks = [b for b in base.split("\n\n[") if b.strip()] if base and base != "(none)" else []
    known = {b.split("]", 1)[0] for b in blocks}
    merged = base if base and base != "(none)" else ""
    for block in extra.split("\n\n["):
        head = block.split("]", 1)[0].lstrip("[")
        if head in known or f"[{head}" in known:
            continue
        piece = block if block.startswith("[") else "[" + block
        if len(merged) + len(piece) + 2 > limit:
            break
        merged = f"{merged}\n\n{piece}" if merged else piece
    return merged or "(none)"


async def run_book(ctx: RunContext) -> PipelineOutcome:
    return await BookRun(ctx).run()
