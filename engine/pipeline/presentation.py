"""Presentation pipeline (#156): slides are the leaves of the shared document
graph (root `book`, `doc_type` "presentation"), written to
`sections/<key>.md` like book sections.

DAG, planned once the slides are known:

    [kb.build] -> draft(slide)                       (parallel, like book leaves)
    draft(slide) -> narration(slide) -> tts(slide)   (per slide, when requested)
    narration(title) -> tts(title)

Media tasks do not compete for the LLM limiter (TTS requests bypass it; local
Coqui runs in a worker thread). Narration and audio are cached per slide
under a fingerprint of their input, so a resumed or export run only makes
what is missing. Outputs: the deck Markdown (old engine's format), optional
PPTX (narration as speaker notes), Beamer `.tex`/`.pdf`, `<deck>_narration.json`
/ `.md`, `audio/slide_NN.<mp3|wav>`, `<deck>_audio.<ext>` and `<deck>.srt`.
Slide numbers in `--presentation-exclude-slides` count the title slide as 1,
as in the old engine.
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path
from typing import Any

from engine.agents.base import Agent
from engine.agents.models import PresentationOutline, SlideDraft, SlideNarration, SubdivisionPlan
from engine.assemble.citations import Numbering, document_group, find_citations, resolve_numeric
from engine.assemble.deck import MAX_TEXT_LINES, DeckSettings, build_deck, deck_to_beamer, deck_to_pptx, limit_lines, slide_body
from engine.assemble.latex import LatexError, compile_pdf
from engine.assemble.markdown import read_section, section_path, strip_writing_instructions
from engine.errors import EngineError
from engine.graph.keys import ROOT
from engine.media.audio import join_mp3, join_wav, srt
from engine.media.tts import Clip, TTSProvider, make_provider
from engine.pipeline.assembly import AssemblyOutcome, load_citation_index
from engine.pipeline.book import BookRun, _short
from engine.pipeline.plan import PRIORITY, GenerationPlan, LeafStatus, TaskSpec
from engine.pipeline.state import WorkStore, fingerprint
from engine.pipeline.text import clean_body, outline_text
from engine.runner import PipelineOutcome
from engine.spec.book_txt import BookSpec
from engine.spec.language import language_name
from engine.spec.models import graph_from_structure, normalize_structure
from engine.spec.presentation import (
    DECK_ATTRS,
    PresentationSpec,
    PresentationStructure,
    normalize_presentation_structure,
    parse_presentation_txt,
    parse_slide_ranges,
    presentation_to_book_structure,
)
from engine.util.fs import atomic_write_json, atomic_write_text, read_json, safe_filename

PRES_OUTLINE = Agent("presentation/outline", PresentationOutline, "presentation.outline")
PRES_SUBDIVIDE = Agent("presentation/subdivide", SubdivisionPlan, "presentation.subdivide")
SLIDE_WRITER = Agent("presentation/slide_writer", SlideDraft, "presentation.slide_writer")
NARRATOR = Agent("presentation/narration", SlideNarration, "presentation.narration", temperature=0.7)

SOURCES_TITLE = {"cs": "Zdroje", "sk": "Zdroje", "de": "Quellen", "pl": "Źródła", "fr": "Sources", "es": "Fuentes"}
_GENERAL_KNOWLEDGE_RE = re.compile(
    r"\(?\s*(?:general background knowledge|obecné znalosti|obecne znalosti|všeobecné znalosti)\s*\)?[.:]?", re.IGNORECASE
)
_MARKUP_RE = re.compile(r"[*_`#>|]+")


class PresentationRun(BookRun):
    doc_type = "presentation"
    agents = {**BookRun.agents, "subdivide": PRES_SUBDIVIDE, "writer": SLIDE_WRITER}

    def __init__(self, ctx) -> None:  # noqa: ANN001
        super().__init__(ctx)
        self.spec: PresentationSpec = PresentationSpec()
        self.pres = self.cfg.presentation
        self.media = WorkStore(self.paths.work / "media")
        self.narrations: dict[str, str] = {}
        self.clips: dict[str, Clip] = {}
        self._provider: TTSProvider | None = None
        self.excluded = parse_slide_ranges(self.pres.exclude_slides)

    def parse_spec(self, text: str) -> BookSpec:
        return parse_presentation_txt(text)

    def clear_work(self) -> None:
        super().clear_work()
        from engine.pipeline.book import _clear_dir

        _clear_dir(self.paths.work / "media" / "work")

    # ------------------------------------------------------------ structure
    async def task_outline(self) -> None:
        spec = self.spec
        self.sink.emit("json", "Generating the presentation structure from the TXT spec")
        language = self.resolve_language(None, self.input_text)
        self.language = language
        target = spec.target_slides()
        duration = spec.duration_minutes or round(target * 1.5)
        if spec.has_slides:
            slides = [
                {"title": s.title, "summary": _short("; ".join(s.bullets), 600) or s.title, "n_pages": 1.0,
                 "needsSubdivision": False, "slide_draft": s.draft}
                for s in spec.slides
            ]
            summary, audience, style = spec.summary, spec.audience, spec.style
            self.sink.emit("json", f"Using the {len(slides)} slides of the TXT spec")
        else:
            kb = await self.kb_overview(f"{spec.title}\n{spec.summary}\n{spec.must_include}")
            out = await PRES_OUTLINE.run(self.ctx.llm, {
                "language_name": language_name(language), "spec_text": self.input_text.strip()[:30000],
                "target_slides": target, "duration": f"{duration:g}", "kb_overview": kb,
            })
            slides = []
            for plan in out.slides:
                if not plan.title.strip():
                    continue
                count = max(1.0, float(round(plan.n_slides or 1.0)))
                slides.append({"title": plan.title, "summary": plan.summary, "n_pages": count, "needsSubdivision": count > 1})
            if not slides:
                raise EngineError("the outline agent returned no slides")
            summary = spec.summary or out.summary
            audience = spec.audience or out.audience
            style = spec.style or out.style_guidance
            duration = spec.duration_minutes or out.duration_minutes or duration
        deck = normalize_presentation_structure({
            "title": spec.title or "Untitled Presentation", "summary": summary, "audience": audience,
            "duration_minutes": duration, "style_guidance": style, "theme": spec.theme or "Madrid",
            "author": spec.author or "", "language": language, "additional_requirements": spec.additional_requirements,
            "slides": slides,
        })
        atomic_write_json(self.cfg.json_path, deck.model_dump(exclude_none=True))
        self._set_deck(deck)
        self.sink.emit("json", f"Structure: {len(deck.slides)} slide entries, saved to {self.cfg.json_path.name}")

    async def task_structure(self) -> None:
        self.sink.emit("json", f"Loading the existing structure: {self.cfg.json_path.name}")
        raw = read_json(self.cfg.json_path)
        if not isinstance(raw, dict):
            raise EngineError(f"cannot read the structure JSON {self.cfg.json_path}")
        self._set_deck(normalize_presentation_structure(raw))

    def _set_deck(self, deck: PresentationStructure) -> None:
        structure = normalize_structure(presentation_to_book_structure(deck))
        graph = graph_from_structure(structure, doc_type=self.doc_type)
        drafts: list[str] = []

        def walk(nodes: list[Any]) -> None:
            for node in nodes:
                drafts.append(node.slide_draft)
                walk(node.childs)

        walk(deck.slides)
        for key, draft in zip([k for k in graph.dfs() if k != ROOT], drafts):
            if draft:
                graph.nodes[key]["slide_draft"] = draft
        graph.attrs.update({name: getattr(deck, name) for name in DECK_ATTRS})
        graph.attrs["max_output_pages"] = deck.max_output_pages
        if deck.author and not self.cfg.author:
            graph.attrs["author"] = deck.author
        self._set_graph(graph, deck.language)

    def needs_split(self, node: dict[str, Any], max_pages: float) -> bool:
        """Only entries that cover more than one slide are split."""
        return float(node.get("n_pages", 1.0)) > max(1.0, max_pages) + 1e-6

    # ------------------------------------------------------- generation plan
    def frames(self) -> list[str]:
        """Frame keys in deck order: the title slide (ROOT), then the slides."""
        return [ROOT] + list(self.leaf_order)

    def frame_index(self, key: str) -> int:
        return 1 if key == ROOT else self.leaf_order.index(key) + 2

    def _wants_audio(self, key: str) -> bool:
        return self.pres.tts and self.frame_index(key) not in self.excluded

    def _add_generation(self, statuses: list[LeafStatus], kb_tasks: list[str]) -> None:
        plan = GenerationPlan(skipped=[s.key for s in statuses if s.done], generated=[s.key for s in statuses if not s.done])
        order = {s.key: i for i, s in enumerate(statuses)}
        previous: str | None = None
        for status in statuses:
            if status.done:
                previous = None
                continue
            deps = list(kb_tasks)
            if self.cfg.context_mode == "chained" and previous is not None:
                deps.append(previous)
            plan.tasks.append(TaskSpec(f"draft:{status.key}", "draft", tuple(deps), status.key, PRIORITY["draft"], order[status.key]))
            previous = f"draft:{status.key}"
        if self.pres.narration:
            for key in self.frames():
                position = self.frame_index(key)
                deps = (f"draft:{key}",) if key in plan.generated else ()
                plan.tasks.append(TaskSpec(f"narration:{key}", "narration", deps, key, PRIORITY["review"], position))
                if self._wants_audio(key):
                    plan.tasks.append(TaskSpec(f"tts:{key}", "tts", (f"narration:{key}",), key, PRIORITY["length"], position))
        self.plan = plan
        for spec in plan.tasks:
            self._add(spec)

    def extra_runners(self) -> dict[str, Any]:
        return {"narration": self.task_narration, "tts": self.task_tts}

    def pending_extra(self, statuses: list[LeafStatus]) -> bool:
        if not self.pres.narration:
            return False
        for key in self.frames():
            text = self._frame_text(key)
            if text is None:
                return True  # a missing slide: generated anyway
            narration = self.media.load(key, "narration", self._narration_fp(key, text))
            if narration is None:
                return True
            if self._wants_audio(key) and self._cached_clip(key, narration["text"]) is None:
                return True
        return False

    # -------------------------------------------------------- slide writing
    def _neighbours(self, key: str) -> str:
        assert self.graph is not None
        graph = self.graph
        position = self.leaf_order.index(key)
        parts: list[str] = []
        parent = graph.parent.get(key)
        if parent and parent != ROOT:
            parts.append(f"Part of: {graph.title(parent)} - {_short(strip_writing_instructions(str(graph.nodes[parent].get('summary', ''))), 300)}")
        for label, offset in (("Previous slide", -1), ("Next slide", 1)):
            index = position + offset
            if 0 <= index < len(self.leaf_order):
                other = self.leaf_order[index]
                parts.append(f"{label} ({graph.title(other)}): {_short(strip_writing_instructions(str(graph.nodes[other].get('summary', ''))), 240)}")
                path = self.snapshot.get(other)
                if path is None and self.cfg.context_mode == "chained" and offset == -1:
                    path = section_path(self.cfg.out_dir, other, graph.nodes[other])
                if path is not None:
                    parts.append(f"{label}, already written (do not repeat it):\n<<<\n{read_section(path)[:900]}\n>>>")
        return "\n".join(parts) or "(none)"

    async def task_draft(self, key: str) -> None:
        assert self.graph is not None
        graph = self.graph
        node = graph.nodes[key]
        position, total = self._position(key)
        title = str(node.get("title", ""))
        self.sink.emit("generate", f"{position}/{total} Starting section '{title}'", node_key=key)
        retrieved = await self._retrieve(key, self._queries(key))
        attrs = graph.attrs
        values = {
            "language_name": language_name(self.language),
            "presentation_title": graph.nodes[ROOT].get("title", ""),
            "presentation_summary": _short(str(graph.nodes[ROOT].get("summary", "")), 1200) or "(none)",
            "audience": attrs.get("audience") or attrs.get("target_readers") or "(not specified)",
            "duration": f"{float(attrs.get('duration_minutes') or 15):g}",
            "style_guidance": attrs.get("style_guidance") or "(none)",
            "additional_requirements": attrs.get("additional_requirements") or "(none)",
            "outline": outline_text(graph, focus=key, with_summaries="all", max_summary=140),
            "neighbours": self._neighbours(key),
            "node_key": key,
            "slide_title": title,
            "slide_summary": strip_writing_instructions(str(node.get("summary", ""))) or "(no summary)",
            "max_lines": MAX_TEXT_LINES,
            "slide_draft": str(node.get("slide_draft") or "") or "(none)",
            "retrieved_context": retrieved.text or "(none)",
        }
        draft = await self.agents["writer"].run(self.ctx.llm, values, node_key=key)
        body = slide_body(clean_body(draft.body_markdown, title, graph, key, self.index, lead_ins=False))
        if self.pres.disable_general_knowledge_citation:
            body = _GENERAL_KNOWLEDGE_RE.sub("", body)
        body, dropped = limit_lines(body, MAX_TEXT_LINES)
        if dropped:
            self.sink.emit("generate", f"Slide '{title}': {dropped} line(s) over the {MAX_TEXT_LINES}-line limit dropped", level="warning", node_key=key)
        if not body.strip():
            raise EngineError(f"the slide writer returned an empty slide for {key}")
        await self._finish_leaf(key, body, draft.summary, [])

    # ------------------------------------------------------------ narration
    def _frame_text(self, key: str) -> str | None:
        """The frame's visible text without citation markers (None when a
        slide has no file yet)."""
        assert self.graph is not None
        if key == ROOT:
            root = self.graph.nodes[ROOT]
            return "\n\n".join(p for p in (str(root.get("summary", "") or ""), self.author) if p.strip())
        path = section_path(self.cfg.out_dir, key, self.graph.nodes[key])
        if path is None:
            return None
        return _without_citations(read_section(path), self)

    def _frame_title(self, key: str) -> str:
        assert self.graph is not None
        return self.graph.title(key) if key != ROOT else str(self.graph.nodes[ROOT].get("title", ""))

    def _narration_fp(self, key: str, text: str) -> str:
        return fingerprint(self._frame_title(key), text, self.language, self.pres.narration_model or self.cfg.llm.model)

    def _seconds_per_slide(self) -> int:
        assert self.graph is not None
        minutes = float(self.graph.attrs.get("duration_minutes") or 15)
        return int(max(20, min(150, round(minutes * 60 / max(1, len(self.frames()))))))

    async def task_narration(self, key: str) -> None:
        text = self._frame_text(key)
        if text is None:
            raise EngineError(f"slide {key} has no content to narrate")
        fp = self._narration_fp(key, text)
        cached = self.media.load(key, "narration", fp)
        if cached is not None:
            self.narrations[key] = cached["text"]
            return
        assert self.graph is not None
        index = self.frame_index(key)
        values = {
            "language_name": language_name(self.language),
            "presentation_title": self.graph.nodes[ROOT].get("title", ""),
            "audience": self.graph.attrs.get("audience") or "(not specified)",
            "slide_index": index,
            "slide_title": self._frame_title(key),
            "slide_body": text or "(title slide)",
            "seconds": self._seconds_per_slide() if key != ROOT else 20,
        }
        result = await NARRATOR.run(self.ctx.llm, values, node_key=key, model=self.pres.narration_model)
        narration = " ".join(_MARKUP_RE.sub("", result.narration).split())
        if not narration:
            raise EngineError(f"empty narration for slide {index}")
        self.media.save(key, "narration", fp, {"text": narration})
        self.narrations[key] = narration
        self.sink.emit("generate", f"Narration written for slide {index} '{self._frame_title(key)}'", node_key=key)

    # ------------------------------------------------------------------ TTS
    def provider(self) -> TTSProvider:
        if self._provider is None:
            speakers = list(self.pres.tts_speaker_wavs) or sorted(self.cfg.out_dir.glob("reference*.wav"))
            self._provider = make_provider(self.pres, llm=self.ctx.llm, language=self.language,
                                           api_key=self.pres.tts_api_key, speaker_wavs=speakers)
        return self._provider

    def _tts_fp(self, narration: str) -> str:
        model = (self.pres.tts_local_model or "coqui-auto") if self.pres.tts_mode == "local" else self.pres.tts_model
        return fingerprint(narration, self.pres.tts_mode, model, self.pres.tts_voice, self.language)

    def _audio_path(self, key: str) -> Path:
        extension = "wav" if self.pres.tts_mode == "local" else "mp3"
        return self.cfg.out_dir / "audio" / f"slide_{self.frame_index(key):02d}.{extension}"

    def _cached_clip(self, key: str, narration: str) -> Clip | None:
        cached = self.media.load(key, "tts", self._tts_fp(narration))
        path = self._audio_path(key)
        if cached is not None and path.exists() and cached.get("file") == path.name:
            return Clip(path, float(cached.get("seconds") or 0.0))
        return None

    async def task_tts(self, key: str) -> None:
        narration = self.narrations.get(key)
        if not narration:
            raise EngineError(f"no narration for slide {self.frame_index(key)}")
        clip = self._cached_clip(key, narration)
        if clip is None:
            path = self._audio_path(key)
            clip = await self.provider().synthesize(narration, path, node_key=key)
            self.media.save(key, "tts", self._tts_fp(narration), {"seconds": clip.seconds, "file": path.name})
            self.sink.emit("generate", f"Audio for slide {self.frame_index(key)}: {clip.seconds:.1f}s ({self.pres.tts_mode})", node_key=key)
        self.clips[key] = clip

    # ------------------------------------------------------------- assembly
    def _load_media(self) -> None:
        """Narration/audio made by earlier runs (export and resumed runs)."""
        for key in self.frames():
            text = self._frame_text(key)
            if text is None:
                continue
            if key not in self.narrations:
                cached = self.media.load(key, "narration", self._narration_fp(key, text))
                if cached is not None:
                    self.narrations[key] = cached["text"]
            if key not in self.clips and key in self.narrations and self._wants_audio(key):
                clip = self._cached_clip(key, self.narrations[key])
                if clip is not None:
                    self.clips[key] = clip

    async def assemble(self) -> AssemblyOutcome:
        assert self.graph is not None
        graph = self.graph
        cfg = self.cfg
        outcome = AssemblyOutcome()
        index = load_citation_index(self.ctx, list(self.web_refs.values()))
        numbering = Numbering(index, document_group(index))
        slides: list[tuple[str, str]] = []
        for key in self.leaf_order:
            path = section_path(cfg.out_dir, key, graph.nodes[key])
            if path is None:
                self.sink.emit("markdown", f"Slide '{graph.title(key)}' ({key}) has no content; left empty in the deck", level="warning", node_key=key)
                slides.append((graph.title(key), ""))
                continue
            slides.append((graph.title(key), resolve_numeric(read_section(path), numbering, key)))
        if numbering.numbers:
            lines = []
            for n, group, ref in numbering.ordered():
                name = (ref.file_name or ref.title or ref.url) if ref is not None else group
                lines.append(f"- [{n}] {name}")
            slides.append((SOURCES_TITLE.get(self.language, "Sources"), "\n".join(lines)))
        root = graph.nodes[ROOT]
        settings = DeckSettings.from_attrs(str(root.get("title", "")), str(root.get("summary", "") or ""), self.author, graph.attrs)
        settings.language = self.language
        deck = build_deck(settings, slides)
        stem = safe_filename(settings.title or "presentation")
        if not cfg.md_output:
            self.sink.emit("markdown", "--no-md ignored in presentation mode (the deck Markdown is the source of every export)", level="warning")
        md_path = cfg.out_dir / f"{stem}.md"
        atomic_write_text(md_path, deck)
        outcome.outputs.append(md_path)
        self.sink.emit("markdown", f"Deck written: {md_path.name} ({len(slides) + 1} slides)")

        self._load_media()
        if self.pres.narration:
            items = [{"index": self.frame_index(k), "title": self._frame_title(k), "narration": self.narrations[k]}
                     for k in self.frames() if k in self.narrations]
            json_path = cfg.out_dir / f"{stem}_narration.json"
            atomic_write_json(json_path, {"slides": items})
            script = ["# Narration Script"]
            for item in items:
                script += ["", f"## {item['title'] or 'Slide ' + str(item['index'])}", "", item["narration"]]
            narration_md = cfg.out_dir / f"{stem}_narration.md"
            atomic_write_text(narration_md, "\n".join(script).rstrip() + "\n")
            outcome.outputs += [json_path, narration_md]
        notes = {self.frame_index(k): v for k, v in self.narrations.items()}

        if self.pres.pptx:
            pptx_path = cfg.out_dir / f"{stem}.pptx"
            try:
                await asyncio.to_thread(deck_to_pptx, deck, pptx_path, notes=notes)
                outcome.outputs.append(pptx_path)
                self.sink.emit("info", f"PowerPoint written: {pptx_path.name}")
            except Exception as exc:  # noqa: BLE001 - reported, the run exits 1
                outcome.export_failed = f"PPTX export failed: {exc}"
                self.sink.emit("info", outcome.export_failed, level="warning")

        if self.pres.tts:
            self._write_audio(stem, outcome)

        if cfg.tex_output:
            tex_path = cfg.out_dir / f"{stem}.tex"
            try:
                await asyncio.to_thread(deck_to_beamer, deck, tex_path, settings=settings, language=self.language)
                outcome.outputs.append(tex_path)
                self.sink.emit("latex", f"Beamer LaTeX written: {tex_path.name}")
            except LatexError as exc:
                outcome.pdf_failed = str(exc)
                self.sink.emit("latex", f"Beamer export failed: {exc}", level="warning")
                return outcome
            if cfg.pdf_output:
                pdf_path = cfg.out_dir / f"{stem}.pdf"
                try:
                    result = await asyncio.to_thread(compile_pdf, tex_path, pdf_path, log_dir=self.paths.logs)
                except LatexError as exc:
                    outcome.pdf_failed = str(exc)
                    self.sink.emit("pdf", f"PDF export failed: {exc}", level="warning")
                    return outcome
                if result.ok:
                    outcome.outputs.append(pdf_path)
                    self.sink.emit("pdf", f"PDF written: {pdf_path.name}")
                    if result.errors:
                        self.sink.emit("pdf", f"LuaLaTeX reported {len(result.errors)} problem(s); first: {result.errors[0]}", level="warning")
                else:
                    outcome.pdf_failed = "; ".join(result.errors[:3])
                    self.sink.emit("pdf", f"PDF compilation failed: {outcome.pdf_failed}", level="warning")
        return outcome

    def _write_audio(self, stem: str, outcome: AssemblyOutcome) -> None:
        keys = [k for k in self.frames() if k in self.clips]
        audio_dir = self.cfg.out_dir / "audio"
        keep = {self.clips[k].path.name for k in keys}
        if audio_dir.is_dir():
            for stale in audio_dir.iterdir():
                if stale.is_file() and stale.name not in keep:
                    stale.unlink()
        if not keys:
            self.sink.emit("info", "No narration audio to assemble", level="warning")
            return
        clips = [self.clips[k] for k in keys]
        extension = clips[0].path.suffix.lstrip(".")
        combined = self.cfg.out_dir / f"{stem}_audio.{extension}"
        if extension == "mp3":
            combined.write_bytes(join_mp3([c.path.read_bytes() for c in clips]))
        else:
            join_wav([c.path for c in clips], combined, gap_s=0.5)
        subtitles = self.cfg.out_dir / f"{stem}.srt"
        # The combined WAV has 0.5 s gaps between clips; subtitles follow it.
        gap = 0.5 if extension == "wav" else 0.0
        entries = [(self.narrations[k], c.seconds + (gap if i < len(keys) - 1 else 0.0)) for i, (k, c) in enumerate(zip(keys, clips))]
        atomic_write_text(subtitles, srt(entries))
        outcome.outputs += [c.path for c in clips] + [combined, subtitles]
        total = sum(c.seconds for c in clips)
        self.sink.emit("info", f"Audio: {len(clips)} clip(s), {total:.0f}s -> {combined.name}, {subtitles.name}")


def _without_citations(text: str, run: PresentationRun) -> str:
    matches = find_citations(text, run.index)
    out, pos = [], 0
    for match in matches:
        out.append(text[pos : match.start].rstrip())
        pos = match.end
    out.append(text[pos:])
    return "".join(out).strip()


async def run_presentation(ctx) -> PipelineOutcome:  # noqa: ANN001
    return await PresentationRun(ctx).run()
