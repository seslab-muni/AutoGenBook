"""Build the `main.py` (book mode) argv/env/cwd for one CLI subprocess run.

This module is the *only* place in the API that knows what command-line
flags the AutoGenBook CLI understands. `RunOptions` (`api/domain/models.py`)
is the API's own vocabulary; everything below translates it into concrete
`main.py` flags. If the CLI's flag surface changes, this is the only file
that should need to change with it.

We always run the CLI as a subprocess and never import/call it in-process,
because `main.py` and the modules it pulls in carry process-wide global
state and side effects that would leak across runs (or hang a server
process) if invoked as a library:

- `autogenbook.prompts.registry` is a single module-level dict swapped by
  `set_prompt_registry()` — concurrent or sequential in-process runs would
  clobber each other's active prompt pack.
- `autogenbook.llm_usage._OPENROUTER_USAGE_TOTALS` is a module-level dict
  that accumulates for the lifetime of the process; it is never reset
  between runs.
- `autogenbook.logging.get_logger` binds a file handler to whichever
  `out_dir` it sees first and keeps it for the life of the process.
- `mcp_gateway._GATEWAY` is a lazily-constructed singleton whose constructor
  can call `input()` when configuration is missing/ambiguous — fine for an
  interactive CLI, fatal for a server event loop.
- `main.py` sets process-wide environment variables at import time
  (`main.py:10-12`) and book-mode progress is communicated exclusively via
  `print()`, not a return value, exception, or callback.

A fresh `python main.py ...` subprocess sidesteps all of the above: it gets
its own process, its own globals, and its own stdout stream that
`subprocess_runner.py` turns into structured `RunEvent`s.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import TYPE_CHECKING

from api.domain.models import RunOptions

if TYPE_CHECKING:  # pragma: no cover - typing only
    from api.core.settings import Settings

# Environment variables forwarded from the parent (API/worker) process into
# the CLI subprocess, if present there. Everything else is dropped: the
# child gets a minimal, explicit environment rather than a full copy of the
# parent's.
ENV_ALLOWLIST: tuple[str, ...] = (
    "OPENROUTER_API_KEY",
    "AUTOGENBOOK_LLM_BASE_URL",
    "AUTOGENBOOK_LLM_API_KEY",
    "AUTOGENBOOK_LLM_MODEL",
    "AUTOGENBOOK_LLM_MINI_MODEL",
    "AUTOGENBOOK_FORCE_MINI_MODEL",
    "TAVILY_API_KEY",
    "PATH",
    "HOME",
    "LANG",
)

# Variables forced regardless of the parent environment, so the child never
# blocks on stdin, never talks to the MCP gateway, and always writes
# UTF-8/unbuffered output that subprocess_runner.py can stream line by line.
FORCED_ENV: dict[str, str] = {
    "AUTOGENBOOK_NONINTERACTIVE": "1",
    # Deliberately NOT `AUTOGENBOOK_ASSUME_YES=1` (issue #79): that makes
    # `_ask_yes_no` answer *yes* everywhere, including
    # `book_pipeline.py`'s "Nahradit puvodni JSON touto revizi?"
    # (default "n") - so an `outline: "generate"` run silently replaces the
    # LLM's generated structure with its own redundancy-revision pass, with
    # no run option exposed for it and no event recording the decision.
    # `AUTOGENBOOK_NONINTERACTIVE` alone already makes every `_ask_yes_no`/
    # `_ask_text`/`_ask_choice` call fall through to its own default
    # instead of blocking on stdin.
    "MCP_GATEWAY_ENABLE": "0",
    "PYTHONUNBUFFERED": "1",
    "PYTHONUTF8": "1",
}

# Layout convention for a run's work directory. book_command owns this
# convention; whatever prepares `work_dir` (project/generation endpoints,
# out of scope for this module) must place inputs at these paths.
INPUT_FILENAME = "book_input.txt"
BOOK_STRUCTURE_FILENAME = "book_structure.json"
OUT_DIRNAME = "out"
KB_DIRNAME = "kb"


def build_command(
    work_dir: str | Path,
    options: RunOptions,
    settings: "Settings",
    *,
    author: str = "",
) -> tuple[list[str], dict[str, str], str]:
    """Build `(argv, env, cwd)` for one book-mode CLI subprocess run.

    `work_dir` holds this run's inputs (`book_input.txt`, an optional
    `kb/` directory) and is where `out/` (passed as `-o`) is created.
    `cwd` is deliberately the repo root, not `work_dir`: book mode resolves
    its prompt pack and audit `project_root` relative to the process's
    current directory (`autogenbook/pipelines/book_pipeline.py:550`), so all
    run-specific paths handed to the CLI must be absolute.
    """

    work_dir = Path(work_dir)
    out_dir = work_dir / OUT_DIRNAME
    input_path = work_dir / INPUT_FILENAME
    kb_dir = work_dir / KB_DIRNAME

    argv: list[str] = [
        str(settings.cli_python),
        str(settings.cli_entrypoint),
        "--mode",
        "book",
        "-i",
        str(input_path),
        "-o",
        str(out_dir),
    ]

    if options.outline == "project":
        argv += ["-j", BOOK_STRUCTURE_FILENAME, "--use-json"]
    elif options.outline == "generate":
        argv += ["--use-txt"]
    else:
        raise ValueError(f"Unknown RunOptions.outline: {options.outline!r}")

    if kb_dir.is_dir():
        argv += ["--kb-dir", str(kb_dir)]

    if options.output_format == "markdown":
        argv += ["--no-tex", "--no-pdf"]
    elif options.output_format == "latex":
        argv += ["--export-tex", "--no-pdf"]
    elif options.output_format == "pdf":
        argv += ["--export-tex"]
    else:
        raise ValueError(f"Unknown RunOptions.output_format: {options.output_format!r}")

    if options.rebuild_kb:
        argv.append("--rebuild-kb")
    if options.resume:
        argv.append("--resume")
    if options.enable_web_rag:
        argv.append("--enable-web-rag")
    if options.audit_book:
        argv.append("--audit-book")
        if options.audit_book_mode != "warn":
            argv += ["--audit-book-mode", options.audit_book_mode]
    if options.legacy_tex:
        argv.append("--legacy-tex")
    if options.fail_fast_schema:
        argv.append("--fail-fast-schema")

    # `options.allow_subdivision` and `options.export_tex_only` have no CLI
    # equivalent today: book mode always subdivides oversized outline nodes
    # (`book_pipeline.py` calls `subdivide_graph` unconditionally), and
    # export-tex-only re-runs are issue #11. Both fields are modeled on
    # `RunOptions` for forward compatibility only and are intentionally
    # no-ops here.

    env: dict[str, str] = {}
    for key in ENV_ALLOWLIST:
        value = os.environ.get(key)
        if value is not None:
            env[key] = value
    env.update(FORCED_ENV)
    # Content-hash-keyed cache of extracted (pre-chunking) document text, shared across
    # every run/project on this deployment; see `rag_kb.py`'s `extract_cache_dir`.
    env["AUTOGENBOOK_KB_EXTRACT_CACHE_DIR"] = settings.kb_extract_cache_dir
    if author.strip():
        # Issue #78: `project.authors` was never reaching the CLI -
        # `book_pipeline.py` only ever reads `g.graph["author"]` (empty for a
        # fresh graph) or falls back to an interactive prompt that
        # `AUTOGENBOOK_NONINTERACTIVE=1` turns into `""`. This env var is a
        # fallback `book_pipeline.py` checks before that prompt, so every
        # generated book/chapter carries the project's authors regardless of
        # `RunOptions.outline` (works for both `--use-json` and `--use-txt`,
        # unlike writing straight into `book_structure.json`, which only the
        # `--use-json` path would ever read).
        env["AUTOGENBOOK_BOOK_AUTHOR"] = author.strip()

    return argv, env, str(settings.repo_root)
