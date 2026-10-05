"""Command-line adapter over `engine.run` (the frozen argv contract, 3.1).

Accepts every flag `api/infrastructure/cli/book_command.py` can emit, the
paper/presentation flags of the old CLI that were ported, and the new
`--concurrency`, `--context-mode` and `--language`. Unknown flags exit 2
(argparse), a missing input exits 2, strict-audit errors exit 4, any other
failure exits 1, SIGTERM exits 143 after persisting what was finished.
`--legacy-tex` is accepted and ignored (the engine is Markdown-first);
`AUTOGENBOOK_NONINTERACTIVE`/`AUTOGENBOOK_ASSUME_YES` are accepted and ignored
because nothing here ever reads stdin.
"""

from __future__ import annotations

import argparse
import asyncio
import io
import os
import signal
import sys
from typing import IO, Sequence

import httpx

from engine.config import DEFAULT_TTS_MODEL, MODES, RunConfig
from engine.errors import EXIT_CANCELLED, EngineError
from engine.events import CompositeSink, JsonlSink, StreamSink


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="run_engine.py",
        description="AutoGenBook engine: generate a book, paper or presentation from a TXT spec.",
    )
    p.add_argument("--mode", choices=MODES, default="book")
    p.add_argument("-i", "--input", default=None, help="input TXT spec (default: <mode>_input.txt)")
    p.add_argument("-o", "--out-dir", default="out", help="output directory (default: ./out)")
    p.add_argument("-j", "--json", dest="json_path", default=None,
                   help="structure JSON; relative paths resolve against --out-dir")
    p.add_argument("--kb-dir", default=None, help="knowledge base directory (one sub-directory per source)")
    p.add_argument("--rebuild-kb", action="store_true", help="ignore cached KB extraction/index")
    p.add_argument("--resume", action="store_true", help="continue from the saved structure in --out-dir")
    group = p.add_mutually_exclusive_group()
    group.add_argument("--use-json", action="store_true", help="use the existing structure JSON")
    group.add_argument("--use-txt", action="store_true", help="(re)generate the structure from the TXT spec")
    p.add_argument("--no-md", action="store_true")
    p.add_argument("--no-tex", action="store_true")
    p.add_argument("--no-pdf", action="store_true")
    p.add_argument("--export-tex", action="store_true", help="book: also export LaTeX (and PDF unless --no-pdf)")
    p.add_argument("--legacy-tex", action="store_true", help="accepted for compatibility; ignored")
    p.add_argument("--audit-book", action="store_true", help="book: audit the assembled document")
    p.add_argument("--audit-book-mode", choices=["off", "warn", "strict"], default="warn")
    p.add_argument("--audit", action="store_true", default=None, help="paper: audit (default on)")
    p.add_argument("--audit-mode", choices=["off", "warn", "strict"], default="warn")
    p.add_argument("--fail-fast-schema", action="store_true", help="abort the run on the first schema failure")
    p.add_argument("--enable-web-rag", action="store_true", help="add web retrieval (Tavily)")
    p.add_argument("--web-rag-k", type=int, default=5)
    p.add_argument("--llm-base-url", default=None, help="OpenAI-compatible base URL override")
    # New in the rewrite.
    p.add_argument("--concurrency", type=int, default=None, help="max parallel LLM requests (env AUTOGENBOOK_CONCURRENCY, default 4)")
    p.add_argument("--context-mode", choices=["parallel", "chained"], default="parallel",
                   help="parallel: leaves drafted independently; chained: leaf N sees leaf N-1 (old behaviour)")
    p.add_argument("--body-headings", action="store_true", default=False,
                   help="allow sub-headings inside section bodies (default off: the outline is the only structure; "
                        "env AUTOGENBOOK_BODY_HEADINGS)")
    p.add_argument("--language", default=None, help="output language code (default: detected from the spec)")
    # Paper.
    p.add_argument("--paper-input", default="paper_input.txt")
    p.add_argument("--paper-venue", default="arXiv")
    p.add_argument("--citation-style", choices=["bibtex", "footnote", "numeric"], default="bibtex")
    # Presentation.
    p.add_argument("--presentation-input", default="presentation_input.txt")
    p.add_argument("--presentation-tex", action="store_true", help="export Beamer LaTeX/PDF")
    p.add_argument("--presentation-pptx", action="store_true", help="export PowerPoint")
    p.add_argument("--presentation-narration", action="store_true", help="narration text per slide")
    p.add_argument("--presentation-narration-model", default=None)
    p.add_argument("--presentation-tts", action="store_true", help="synthesize narration audio (implies narration)")
    p.add_argument("--presentation-tts-mode", choices=["openrouter", "local"], default="openrouter")
    p.add_argument("--presentation-tts-model", default=None, help=f"TTS model (default {DEFAULT_TTS_MODEL})")
    p.add_argument("--presentation-exclude-slides", default="", help="slides to skip for audio, e.g. 2,5,10-12")
    p.add_argument("--disable-general-knowledge-citation", action="store_true")
    return p


def _utf8_line_stream(stream: IO[str]) -> IO[str]:
    """stdout as UTF-8 and line buffered regardless of PYTHONUNBUFFERED/locale."""
    reconfigure = getattr(stream, "reconfigure", None)
    if reconfigure is not None:
        try:
            reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
            return stream
        except (ValueError, io.UnsupportedOperation):
            pass
    return stream


def main(
    argv: Sequence[str] | None = None,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    stdout: IO[str] | None = None,
    env: dict[str, str] | None = None,
) -> int:
    args = build_parser().parse_args(argv)
    out = _utf8_line_stream(stdout or sys.stdout)
    stream_sink = StreamSink(out)
    try:
        config = RunConfig.from_args(args, env if env is not None else dict(os.environ))
    except EngineError as exc:
        stream_sink.emit("log", f"ERROR: {exc}", level="error")
        return exc.exit_code
    config.out_dir.mkdir(parents=True, exist_ok=True)
    sink = CompositeSink(stream_sink, JsonlSink(config.out_dir / "events.jsonl"))
    try:
        return asyncio.run(_run(config, sink, transport))
    except KeyboardInterrupt:
        return EXIT_CANCELLED
    finally:
        sink.close()


async def _run(config: RunConfig, sink: CompositeSink, transport: httpx.AsyncBaseTransport | None) -> int:
    from engine.runner import run

    task = asyncio.ensure_future(run(config, sink, transport=transport))
    loop = asyncio.get_running_loop()
    installed: list[int] = []
    if threading_is_main():
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, task.cancel)
                installed.append(sig)
            except (NotImplementedError, RuntimeError, ValueError):
                pass
    try:
        result = await task
        return result.exit_code
    except asyncio.CancelledError:
        return EXIT_CANCELLED
    finally:
        for sig in installed:
            loop.remove_signal_handler(sig)


def threading_is_main() -> bool:
    import threading

    return threading.current_thread() is threading.main_thread()


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
