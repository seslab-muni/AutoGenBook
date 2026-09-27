"""Book pipeline (phase 2 subset: the assembly-only run kind).

`--resume` on a work dir whose leaves all have section files generates
nothing and only assembles Markdown/LaTeX/PDF. Generation lands with the
task-DAG pipeline (#153).
"""

from __future__ import annotations

from engine.errors import EXIT_AUDIT, EXIT_FAILURE, EngineError
from engine.assemble.markdown import section_path
from engine.pipeline.assembly import assemble_outputs
from engine.pipeline.context import RunContext
from engine.pipeline.resume import decide_resume
from engine.runner import PipelineOutcome
from engine.spec.language import detect_language, normalize_language
from engine.util.fs import sha256_file


async def run_book(ctx: RunContext) -> PipelineOutcome:
    cfg = ctx.config
    input_sha = sha256_file(cfg.input_path)
    decision = decide_resume(cfg, input_sha, ctx.sink)
    if not decision.accepted or decision.graph is None:
        raise EngineError("generation is not implemented yet in this build (assembly-only)")
    graph = decision.graph
    missing = [k for k in graph.leaves() if section_path(cfg.out_dir, k, graph.nodes[k]) is None]
    if missing:
        raise EngineError(f"{len(missing)} section(s) missing; generation is not implemented yet in this build")
    language = normalize_language(cfg.language) or normalize_language(str(graph.attrs.get("language") or "")) or detect_language(
        " ".join(str(graph.nodes[k].get("summary") or "") for k in list(graph.dfs())[:20])
    )
    author = str(graph.attrs.get("author") or cfg.author or "")
    ctx.sink.emit("generate", f"All {len(graph.leaves())} sections exist; assembling only")
    outcome = await assemble_outputs(ctx, graph, language=language, author=author)
    result = PipelineOutcome(outputs=outcome.outputs, run_kind="export")
    if outcome.audit_blocked:
        result.exit_code = EXIT_AUDIT
        result.error = "Book audit failed in strict mode. See audit_report.json for details."
    elif outcome.pdf_failed and cfg.pdf_output:
        result.exit_code = EXIT_FAILURE
        result.error = f"PDF export failed: {outcome.pdf_failed}"
    return result
