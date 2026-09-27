"""Paper pipeline (#155): the book DAG with a paper prompt pack plus three
paper-specific agents - the related-work builder, the abstract written last,
and the reference formatter.

Citations are KB first. With `--enable-web-rag`, Tavily hits are offered to
the related-work builder only after their DOI (doi.org) or URL resolved;
unverified references are recorded in `related_work.json` and never emitted.
Other sections cite the knowledge base only. `--citation-style` bibtex
(default: numbered Markdown references, `\\cite` + `refs.bib` + bibtex in
LaTeX), numeric (numbered in both) or footnote (the reference text as a
footnote at the citation). Artifacts follow the book layout.
"""

from __future__ import annotations

import asyncio
import dataclasses
import re
from pathlib import Path
from typing import Any

from engine.agents.base import Agent
from engine.agents.models import BibEntry, PaperAbstract, PaperOutline, RelatedWorkPlan, SectionDraft, SectionReview
from engine.assemble.bibtex import entry as bib_entry
from engine.assemble.bibtex import format_entry
from engine.assemble.citations import CitationIndex, Numbering, Reference, cited_keys, document_group, find_citations, format_reference, references_title
from engine.assemble.markdown import read_section, section_path, strip_writing_instructions
from engine.errors import EngineError
from engine.graph.keys import ROOT
from engine.pipeline.assembly import AssemblyStyle, assemble_outputs
from engine.pipeline.book import BookRun, _short
from engine.pipeline.plan import PRIORITY, GenerationPlan, TaskSpec
from engine.pipeline.text import equation_guidance, heading_rule
from engine.retrieval.context import format_context
from engine.retrieval.service import RetrievedContext
from engine.retrieval.types import RetrievalItem
from engine.retrieval.web import as_dict, verify_reference
from engine.runner import PipelineOutcome
from engine.spec.book_txt import BookSpec
from engine.spec.language import language_name
from engine.spec.models import graph_from_structure, normalize_structure
from engine.spec.paper import RELATED_WORK_TITLE, PaperSpec, normalize_paper_structure, paper_to_book_structure, parse_paper_txt
from engine.util.fs import atomic_write_json, atomic_write_text, read_json

PAPER_OUTLINE = Agent("paper/outline", PaperOutline, "paper.outline")
PAPER_WRITER = Agent("paper/writer", SectionDraft, "paper.writer")
PAPER_REVIEWER = Agent("paper/reviewer", SectionReview, "paper.reviewer", temperature=0.1)
RELATED_WORK = Agent("paper/related_work", RelatedWorkPlan, "paper.related_work")
ABSTRACT = Agent("paper/abstract", PaperAbstract, "paper.abstract")
REFERENCE = Agent("paper/reference", BibEntry, "paper.reference", role="mini", temperature=0.0)


class PaperRun(BookRun):
    doc_type = "paper"
    optional_kinds = BookRun.optional_kinds | {"related_work", "abstract", "references"}
    agents = {**BookRun.agents, "outline": PAPER_OUTLINE, "writer": PAPER_WRITER, "reviewer": PAPER_REVIEWER}

    def __init__(self, ctx) -> None:  # noqa: ANN001
        super().__init__(ctx)
        self.spec: PaperSpec = PaperSpec()
        self.related_items: list[RetrievalItem] = []
        self.related_statement = ""
        self.references: dict[str, dict[str, Any]] = {}

    def parse_spec(self, text: str) -> BookSpec:
        return parse_paper_txt(text)

    # ------------------------------------------------------------ structure
    def _paper_attrs(self) -> dict[str, Any]:
        assert self.graph is not None
        return self.graph.attrs

    async def task_outline(self) -> None:
        spec = self.spec
        self.sink.emit("json", "Generating the paper structure from the TXT spec")
        from engine.spec.language import detect_language, normalize_language

        language = normalize_language(self.cfg.language) or normalize_language(spec.language) or detect_language(self.input_text)
        self.language = language
        total = float(spec.total_pages or 8.0)
        venue = spec.venue or self.cfg.paper_venue
        if spec.has_outline:
            sections = [
                {"title": n.title, "summary": n.summary, "n_pages": n.n_pages or 1.0, "childs": [c.to_structure() for c in n.children]}
                for n in spec.outline
            ]
            abstract, keywords, contributions = spec.summary, spec.keywords, spec.contributions
        else:
            kb = await self.kb_overview(f"{spec.title}\n{spec.summary}\n{' '.join(spec.keywords)}")
            out = await self.agents["outline"].run(self.ctx.llm, {
                "language_name": language_name(language), "spec_text": self.input_text.strip()[:30000],
                "total_pages": f"{total:g}", "venue": venue, "kb_overview": kb,
            })
            sections = [{"title": s.title, "summary": s.summary, "role": s.role, "n_pages": s.n_pages} for s in out.sections if s.title.strip()]
            if not sections:
                raise EngineError("the outline agent returned no sections")
            abstract = spec.summary or out.abstract_draft
            keywords = spec.keywords or out.keywords
            contributions = spec.contributions or out.contributions
        paper = normalize_paper_structure({
            "title": spec.title or "Untitled Paper", "abstract": abstract, "keywords": keywords, "contributions": contributions,
            "target_venue": venue, "citation_style": self.cfg.citation_style, "n_pages": total, "language": language,
            "additional_requirements": spec.notes, "sections": sections,
        })
        paper = self._ensure_related_work(paper)
        pages = [s.n_pages for s in paper.sections]
        scale = total / (sum(pages) or 1.0)
        for section in paper.sections:
            section.n_pages = max(0.3, round(section.n_pages * scale, 1))
        atomic_write_json(self.cfg.json_path, paper.model_dump(exclude_none=True))
        self._set_paper(paper)
        self.sink.emit("json", f"Structure: {len(paper.sections)} sections, saved to {self.cfg.json_path.name}")

    def _ensure_related_work(self, paper):  # noqa: ANN001, ANN202
        if any(s.role == "related_work" for s in paper.sections):
            return paper
        from engine.spec.paper import PaperSection

        title = RELATED_WORK_TITLE.get(self.language, "Related Work")
        section = PaperSection(title=title, role="related_work", n_pages=1.0,
                               summary="Prior work in the verified sources, organised by theme, and how this paper relates to it.")
        index = next((i + 1 for i, s in enumerate(paper.sections) if s.role == "introduction"), 0)
        paper.sections.insert(index, section)
        return paper

    async def task_structure(self) -> None:
        self.sink.emit("json", f"Loading the existing structure: {self.cfg.json_path.name}")
        raw = read_json(self.cfg.json_path)
        if not isinstance(raw, dict):
            raise EngineError(f"cannot read the structure JSON {self.cfg.json_path}")
        paper = normalize_paper_structure(raw)
        self._set_paper(self._ensure_related_work(paper))

    def _set_paper(self, paper) -> None:  # noqa: ANN001
        structure = normalize_structure(paper_to_book_structure(paper))
        graph = graph_from_structure(structure, doc_type=self.doc_type)
        for key, section in zip([k for k in graph.children.get(ROOT, [])], paper.sections):
            graph.nodes[key]["role"] = section.role
        graph.attrs.update({
            "abstract": paper.abstract, "keywords": paper.keywords, "contributions": paper.contributions,
            "target_venue": paper.target_venue, "citation_style": self.cfg.citation_style,
        })
        self._set_graph(graph, paper.language)

    # ------------------------------------------------------- generation plan
    def _related_work_key(self) -> str | None:
        assert self.graph is not None
        for key in self.leaf_order:
            chain = [key] + self.graph.ancestors(key)
            if any(self.graph.nodes[k].get("role") == "related_work" for k in chain if k != ROOT):
                return key
        return None

    def extra_runners(self) -> dict[str, Any]:
        return {"related_work": self.task_related_work, "abstract": self.task_abstract, "references": self.task_references}

    def extend_plan(self, plan: GenerationPlan) -> list[TaskSpec]:
        tasks = list(plan.tasks)
        if not plan.generated:
            return tasks
        base = [t for t in ("subdivide", "glossary", "kb.build", "kb.embed") if t in self.scheduler.tasks or any(x.id == t for x in tasks)]
        rw_key = self._related_work_key()
        if rw_key in plan.generated:
            tasks.append(TaskSpec("related_work", "related_work", tuple(base), priority=PRIORITY["glossary"]))
            tasks = [dataclasses.replace(t, deps=t.deps + ("related_work",)) if t.id == f"draft:{rw_key}" else t for t in tasks]
        finals = [t.id for t in tasks if t.kind == "length"]
        after = ("consistency",) if any(t.id == "consistency" for t in tasks) else tuple(finals)
        tasks.append(TaskSpec("abstract", "abstract", after, priority=4))
        tasks.append(TaskSpec("references", "references", ("abstract",), priority=3))
        return tasks

    # --------------------------------------------------------- writer hooks
    def writer_values(self, key: str, context: str) -> dict[str, Any]:
        assert self.graph is not None
        graph = self.graph
        common = self._common(key)
        return {
            "language_name": common["language_name"],
            "paper_title": graph.nodes[ROOT].get("title", ""),
            "abstract": _short(str(graph.attrs.get("abstract") or graph.nodes[ROOT].get("summary", "")), 1500) or "(not yet written)",
            "contributions": "; ".join(graph.attrs.get("contributions") or []) or "(see the outline)",
            "target_readers": common["target_readers"],
            "equation_guidance": equation_guidance(graph.attrs.get("equation_frequency_level", 3)),
            "glossary": common["glossary"],
            "outline": self._outline_for(key),
            "neighbours": common["neighbours"],
            "node_key": key,
            "section_role": self._role(key),
            "section_title": common["section_title"],
            "section_summary": common["section_summary"],
            "target_words": common["target_words"],
            "heading_rule": heading_rule(graph, key),
            "retrieved_context": context,
        }

    def reviewer_values(self, key: str, body: str, context: str) -> dict[str, Any]:
        assert self.graph is not None
        common = self._common(key)
        return {
            "language_name": common["language_name"],
            "paper_title": self.graph.nodes[ROOT].get("title", ""),
            "glossary": common["glossary"],
            "neighbours": common["neighbours"],
            "node_key": key,
            "section_title": common["section_title"],
            "section_summary": common["section_summary"],
            "target_words": common["target_words"],
            "retrieved_context": context,
            "citation_check": self._citation_check(body),
            "section_body": body,
        }

    def _role(self, key: str) -> str:
        assert self.graph is not None
        for k in [key] + self.graph.ancestors(key):
            role = self.graph.nodes.get(k, {}).get("role")
            if role and k != ROOT:
                return str(role)
        return "other"

    async def _retrieve(self, key: str, queries: list[str]) -> RetrievedContext:
        """KB only for ordinary sections; the related-work section is written
        from the related-work map (KB + verified web references)."""
        assert self.graph is not None
        if key == self._related_work_key() and self.related_items:
            text = format_context(self.related_items, max_chars_total=self.cfg.retrieval.max_chars_total * 2, item_chars=900)
            if self.related_statement:
                text = f"Positioning (from the related-work map): {self.related_statement}\n\n{text}"
            return RetrievedContext(list(self.related_items), text)
        from engine.retrieval.scope import resolve_kb_sources

        return await self.retrieval.context(
            queries, kb_sources=resolve_kb_sources(self.graph, key), allow_web=False,
            node_title=self.graph.title(key), node_key=key,
        )

    # ---------------------------------------------------------- paper tasks
    async def task_related_work(self) -> None:
        assert self.graph is not None
        graph = self.graph
        attrs = graph.attrs
        title = str(graph.nodes[ROOT].get("title", ""))
        keywords = list(attrs.get("keywords") or [])
        queries = [f"{title}\n{attrs.get('abstract', '')}", " ".join(keywords) or title]
        candidates: list[RetrievalItem] = []
        if self.retrieval.retriever is not None:
            context = await self.retrieval.context(queries, k=10)
            candidates += context.kb_items
        rejected: list[dict[str, Any]] = []
        if self.cfg.retrieval.enable_web:
            self.retrieval.enable_web_only()
            if self.retrieval.web is not None and self.retrieval.web.available:
                web_items = await self.retrieval.web.search(queries, k=self.cfg.retrieval.web_k)
                checks = await asyncio.gather(*(verify_reference(self.ctx.llm.http, item) for item in web_items))
                for item, ok in zip(web_items, checks):
                    item.verified = bool(ok)
                    if ok:
                        candidates.append(item)
                    else:
                        rejected.append(as_dict(item))
                self.sink.emit("kb", f"Web references: {sum(checks)} verified, {len(rejected)} rejected (DOI/URL did not resolve)")
        plan = RelatedWorkPlan()
        if candidates:
            plan = await RELATED_WORK.run(self.ctx.llm, {
                "language_name": language_name(self.language), "paper_title": title,
                "abstract": _short(str(attrs.get("abstract", "")), 1500) or "(not yet written)",
                "keywords": ", ".join(keywords) or "-", "contributions": "; ".join(attrs.get("contributions") or []) or "-",
                "retrieved_context": format_context(candidates, max_chars_total=12000, item_chars=900),
            })
        by_key = {item.cite_key: item for item in candidates}
        chosen: list[RetrievalItem] = []
        entries: list[dict[str, Any]] = []
        for entry in plan.entries:
            item = by_key.get(entry.cite_key)
            if item is None or item in chosen:
                continue
            chosen.append(item)
            entries.append({
                "cite_key": item.cite_key, "kind": item.kind, "title": item.title or item.source, "source": item.source,
                "loc": item.loc, "url": item.url, "doi": item.doi,
                "verified": True if item.kind == "kb" else bool(item.verified),
                "relation": entry.relation, "summary": entry.summary,
            })
        if not chosen:
            chosen = candidates[:6]
        for item in chosen:
            if item.kind == "web":
                ref = Reference(key=item.cite_key, kind="web", title=item.title or "", url=item.url or "", rid=item.rid,
                                doi=item.doi or "", excerpt=item.text[:120], verified=True)
                self.web_refs[item.cite_key] = ref
                self.index.add(ref)
        self.related_items = chosen
        self.related_statement = plan.positioning_statement
        atomic_write_json(self.cfg.out_dir / "related_work.json", {
            "positioning_statement": plan.positioning_statement, "gaps": plan.gaps, "items": entries,
            "rejected_unverified": rejected,
        })
        self.sink.emit("generate", f"Related-work map: {len(entries)} source(s) selected")

    async def task_abstract(self) -> None:
        assert self.graph is not None
        graph = self.graph
        overview = []
        for key in self.leaf_order:
            meta = self.meta.get(key) or {}
            summary = meta.get("summary") or strip_writing_instructions(str(graph.nodes[key].get("summary", "")))
            overview.append(f"[{key}] {graph.title(key)}: {_short(summary, 500)}")
        result = await ABSTRACT.run(self.ctx.llm, {
            "language_name": language_name(self.language), "paper_title": graph.nodes[ROOT].get("title", ""),
            "contributions": "; ".join(graph.attrs.get("contributions") or []) or "-",
            "sections": "\n".join(overview), "word_limit": 250,
        })
        abstract = result.abstract.strip()
        graph.attrs["abstract"] = abstract
        if result.keywords:
            graph.attrs["keywords"] = result.keywords[:8]
        graph.save(self.paths.graph)
        atomic_write_text(self.cfg.out_dir / "abstract.md", abstract + "\n")
        self.sink.emit("generate", "Abstract written from the finished sections")

    async def task_references(self) -> None:
        """Format one bibliographic record per cited KB document (mini model),
        cached in references.json so exports never need a model."""
        assert self.graph is not None
        self.references = read_json(self.cfg.out_dir / "references.json") or {}
        group = document_group(self.index)
        needed: dict[str, str] = {}
        for key in self.leaf_order:
            path = section_path(self.cfg.out_dir, key, self.graph.nodes[key])
            if path is None:
                continue
            for cite in cited_keys(read_section(path), self.index):
                doc = group(cite)
                if doc.startswith("kb_") and doc not in self.references:
                    needed.setdefault(doc, cite)
        kb = self.retrieval.kb

        async def one(doc: str, cite: str) -> None:
            ref = self.index.lookup(cite)
            opening = ""
            if kb is not None and ref is not None:
                chunks = [c for c in kb.chunks if c.source_path == ref.source_path][:3]
                opening = "\n\n".join(c.text for c in chunks)[:2500]
            if not opening:
                return
            entry = await REFERENCE.run(self.ctx.llm, {"file_name": ref.file_name if ref else doc, "opening_text": opening})
            self.references[doc] = entry.model_dump()

        results = await asyncio.gather(*(one(doc, cite) for doc, cite in needed.items()), return_exceptions=True)
        for doc, result in zip(needed, results):
            if isinstance(result, asyncio.CancelledError):
                raise result
            if isinstance(result, BaseException):
                # That document keeps its file-name entry; a later run retries it.
                self.sink.emit("generate", f"Reference for '{doc}' could not be formatted ({str(result)[:200]}); using the file name", level="warning")
        atomic_write_json(self.cfg.out_dir / "references.json", self.references)

    # ------------------------------------------------------------- assembly
    async def assemble(self):  # noqa: ANN201
        assert self.graph is not None
        attrs = self.graph.attrs
        if not self.references:
            self.references = read_json(self.cfg.out_dir / "references.json") or {}
        abstract = str(attrs.get("abstract") or "").strip()
        if not abstract and (self.cfg.out_dir / "abstract.md").exists():
            abstract = (self.cfg.out_dir / "abstract.md").read_text(encoding="utf-8").strip()
        keywords = ", ".join(attrs.get("keywords") or [])
        front = []
        if abstract:
            front += [f"## {'Abstrakt' if self.language == 'cs' else 'Abstract'} {{.unnumbered}}", abstract]
        if keywords:
            front.append(f"**{'Klíčová slova' if self.language == 'cs' else 'Keywords'}:** {keywords}")
        for item in (read_json(self.cfg.out_dir / "related_work.json") or {}).get("items", []):
            if item.get("kind") == "web" and item.get("verified") and item["cite_key"] not in self.web_refs:
                ref = Reference(key=item["cite_key"], kind="web", title=item.get("title") or "", url=item.get("url") or "",
                                doi=item.get("doi") or "", verified=True)
                self.web_refs[ref.key] = ref
        style = self._style(abstract, front)
        return await assemble_outputs(self.ctx, self.graph, language=self.language, author=self.author,
                                      extra_refs=list(self.web_refs.values()), style=style)

    def _style(self, abstract: str, front: list[str]) -> AssemblyStyle:
        references = self.references
        language = self.language
        citation_style = self.cfg.citation_style

        def entry_text(group: str, ref: Reference | None, numbering: Numbering) -> str:
            record = references.get(group)
            locs = [numbering.index.lookup(k).loc for k in numbering.members.get(group, []) if numbering.index.lookup(k) and numbering.index.lookup(k).loc]
            if record and record.get("title"):
                authors = "; ".join(record.get("authors") or [])
                parts = [p for p in (authors, f"*{record['title']}*", record.get("venue"), record.get("publisher"), record.get("year")) if p]
                text = ". ".join(parts)
                if record.get("doi"):
                    text += f". doi:{record['doi']}"
                if record.get("url"):
                    text += f". <{record['url']}>"
            else:
                text = format_reference(ref, group, language).rstrip(".")
                text = re.sub(r", (?:page|slide) \d+, chunk \d+|, chunk \d+", "", text)
            if locs and ref is not None and ref.kind == "kb":
                pages = sorted({m.group(1) for loc in locs for m in [re.search(r"page (\d+)", loc)] if m}, key=int)
                if pages:
                    text += f" (pp. {', '.join(pages)})" if len(pages) > 1 else f" (p. {pages[0]})"
            return text.rstrip(".") + "."

        def bibliography(numbering: Numbering, lang: str) -> list[str]:
            return [f"[{n}] {entry_text(group, ref, numbering)}" for n, group, ref in numbering.ordered()]

        def cite_resolver(text: str, numbering: Numbering, node_key: str) -> str:
            matches = find_citations(text, numbering.index)
            out, pos = [], 0
            for m in matches:
                out.append(text[pos:m.start])
                groups: list[str] = []
                for key in m.keys:
                    numbering.number(key, node_key)
                    g = numbering.group(numbering.index.canonical(key))
                    if g not in groups:
                        groups.append(g)
                # Pandoc citation syntax, rendered as \citep{...} by --natbib: the
                # section text itself goes through pandoc with raw TeX off.
                out.append("[" + "; ".join(f"@{_bibkey(g)}" for g in groups) + "]")
                pos = m.end
            out.append(text[pos:])
            return "".join(out)

        def footnote_resolver(text: str, numbering: Numbering, node_key: str) -> str:
            matches = find_citations(text, numbering.index)
            out, pos = [], 0
            for m in matches:
                out.append(text[pos:m.start].rstrip())
                notes = []
                for key in m.keys:
                    numbering.number(key, node_key)
                    g = numbering.group(numbering.index.canonical(key))
                    notes.append(entry_text(g, numbering.index.lookup(key), numbering))
                out.append("^[" + " ".join(dict.fromkeys(notes)) + "]")
                pos = m.end
            out.append(text[pos:])
            return "".join(out)

        def bib_writer(path: Path, numbering: Numbering) -> None:
            chunks = []
            for _n, group, ref in numbering.ordered():
                record = references.get(group)
                key = _bibkey(group)
                if record and record.get("title"):
                    fields = [("title", record["title"])]
                    if record.get("authors"):
                        fields.append(("author", " and ".join(record["authors"])))
                    for name in ("year", "publisher", "url", "doi"):
                        if record.get(name):
                            fields.append((name, record[name]))
                    if record.get("venue"):
                        fields.append(("journal" if record.get("entry_type") == "article" else "howpublished", record["venue"]))
                    kind = record.get("entry_type") if record.get("entry_type") in {"article", "book", "inproceedings", "techreport", "phdthesis", "misc"} else "misc"
                    if kind == "article" and not record.get("venue"):
                        kind = "misc"
                    chunks.append(format_entry(kind, key, fields))
                else:
                    text = bib_entry(group, ref)
                    chunks.append(re.sub(r"^@(\w+)\{[^,]*,", lambda m: f"@{m.group(1)}{{{key},", text, count=1))
            path.write_text("\n\n".join(chunks) + ("\n" if chunks else ""), encoding="utf-8")

        keywords_only = [line for line in front if line.startswith("**")]
        base = dict(
            template="paper.latex", top_level="section", documentclass="article", group=document_group,
            bib_writer=bib_writer, front_matter=front, tex_front_matter=keywords_only, abstract=abstract or None,
            toc=False, check_numeric_claims=True,
        )
        if citation_style == "footnote":
            return AssemblyStyle(**base, md_resolve=footnote_resolver, md_bibliography=None, tex_resolve=None, tex_bibliography=None)
        if citation_style == "numeric":
            return AssemblyStyle(**base, md_bibliography=bibliography, tex_bibliography=bibliography)
        return AssemblyStyle(**base, md_bibliography=bibliography, tex_resolve=cite_resolver, tex_bibliography=None, bibtex=True,
                             latex_vars={"bibliography-file": "refs"}, pandoc_args=["--natbib"])


def _bibkey(group: str) -> str:
    """BibTeX key for a reference group, also a valid pandoc citation key
    (no trailing punctuation)."""
    return re.sub(r"[^A-Za-z0-9_:\-.]", "_", group).strip(".:-") or "ref"


async def run_paper(ctx) -> PipelineOutcome:  # noqa: ANN001
    return await PaperRun(ctx).run()
