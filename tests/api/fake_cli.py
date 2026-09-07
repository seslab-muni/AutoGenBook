"""Argparse-compatible stand-in for `main.py` (book mode), for tests only.

`subprocess_runner.py` and `book_command.py` are meant to be testable
without an LLM key. Pointing `Settings.cli_entrypoint` at this file (see the
`CLI_ENTRYPOINT` setting) makes `subprocess_runner.run()` drive this script
instead of the real CLI.

This script deliberately only declares the flags `book_command.build_command`
can ever emit. If the argv builder starts sending a flag this script doesn't
know about, argparse rejects it and exits 2 — that's the point: it keeps the
real flag surface and the adapter's assumptions about it from silently
drifting apart.

It fabricates a tiny, deterministic two-chapter book without calling any
LLM, printing the same `[TAG]` progress lines the real CLI prints
(`autogenbook/pipelines/book_pipeline.py`) and writing the same artifact
shapes: `structure_graph.json` (with `content_file_path` populated
incrementally, so `subprocess_runner`'s graph watcher has something to
find), `sections/<key>.md`, `kb_sources.json` (only when `--kb-dir` is
given), `<Title>.md`, `run_meta.json`, and `llm_usage.jsonl`. `--resume`
skips sections whose output file already exists; `--export-tex` writes stub
`.tex`/`.pdf` files.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

# Small but non-zero so tests can observe events streaming in over time
# (ordering, "a section event shows up mid-run", cancellation mid-run)
# without making the suite slow. Overridable for tests that want it to be
# effectively instantaneous or, conversely, long enough to cancel mid-run.
STEP_SLEEP_S = float(os.environ.get("FAKE_CLI_STEP_SLEEP_S", "0.05"))


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="fake_cli")
    p.add_argument("--mode", choices=["book"], default="book")
    p.add_argument("-i", "--input", default="book_input.txt")
    p.add_argument("-o", "--out-dir", default="out")
    p.add_argument("-j", "--json", dest="json_path", default="book_structure.json")
    p.add_argument("--kb-dir", default=None)
    p.add_argument("--rebuild-kb", action="store_true")
    p.add_argument("--resume", action="store_true")

    g = p.add_mutually_exclusive_group()
    g.add_argument("--use-json", action="store_true")
    g.add_argument("--use-txt", action="store_true")

    p.add_argument("--no-tex", action="store_true")
    p.add_argument("--no-pdf", action="store_true")
    p.add_argument("--no-md", action="store_true")
    p.add_argument("--export-tex", action="store_true")
    p.add_argument("--legacy-tex", action="store_true")
    p.add_argument("--audit-book", action="store_true")
    p.add_argument("--audit-book-mode", choices=["off", "warn", "strict"], default="warn")
    p.add_argument("--enable-web-rag", action="store_true")
    p.add_argument("--fail-fast-schema", action="store_true")

    return p.parse_args(argv)


def _default_book_json(input_path: Path) -> dict:
    title = "Fake Book"
    try:
        first_line = input_path.read_text(encoding="utf-8").splitlines()[0].strip()
        if first_line:
            title = first_line
    except OSError:
        pass
    return {
        "title": title,
        "chapters": [
            {"key": "ch1", "title": "Chapter One"},
            {"key": "ch2", "title": "Chapter Two"},
        ],
    }


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    input_path = Path(args.input).expanduser().resolve()
    if not input_path.exists():
        print(f"Chyba: vstupni soubor neexistuje: {input_path}", file=sys.stderr)
        return 2

    out_dir = Path(args.out_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    sections_dir = out_dir / "sections"
    sections_dir.mkdir(parents=True, exist_ok=True)

    if args.kb_dir:
        kb_dir = Path(args.kb_dir).expanduser().resolve()
        print(f"[KB] Buduji/nactivam znalostni databazi z: {kb_dir}")
        time.sleep(STEP_SLEEP_S)
        sources = sorted(p.name for p in kb_dir.glob("*") if p.is_file()) if kb_dir.is_dir() else []
        (out_dir / "kb_sources.json").write_text(
            json.dumps({"sources": sources}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"[KB] Hotovo. Pocet zdroju: {len(sources)}")
    else:
        print("[KB] --kb-dir nebyl zadan. RAG bude vypnut.")

    json_path = Path(args.json_path).expanduser()
    if not json_path.is_absolute():
        # Mirrors book_pipeline.py: a relative -j path resolves against
        # out_dir, not the process cwd.
        json_path = out_dir / json_path

    if args.use_json and json_path.exists():
        print(f"[JSON] Nacitam existujici strukturu: {json_path}")
        book_json = json.loads(json_path.read_text(encoding="utf-8"))
    else:
        print("[JSON] Generuji novou strukturu z TXT vstupu")
        time.sleep(STEP_SLEEP_S)
        book_json = _default_book_json(input_path)
        json_path.parent.mkdir(parents=True, exist_ok=True)
        json_path.write_text(json.dumps(book_json, ensure_ascii=False, indent=2), encoding="utf-8")

    title = book_json.get("title") or "Fake Book"
    chapters = book_json.get("chapters") or [
        {"key": "ch1", "title": "Chapter One"},
        {"key": "ch2", "title": "Chapter Two"},
    ]

    nodes: dict[str, dict] = {"book": {"title": title}}
    edges: list[list[str]] = []
    for chapter in chapters:
        key = chapter["key"]
        nodes[key] = {"title": chapter.get("title", key)}
        edges.append(["book", key])

    graph_path = out_dir / "structure_graph.json"

    def save_graph() -> None:
        graph_path.write_text(
            json.dumps({"graph": {}, "nodes": nodes, "edges": edges}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    save_graph()
    print("[SUBDIVIDE] Trvani: 0.0s")

    total = len(chapters)
    md_parts = [f"# {title}\n"]
    for i, chapter in enumerate(chapters, start=1):
        key = chapter["key"]
        chapter_title = chapter.get("title", key)
        section_path = sections_dir / f"{key}.md"

        if args.resume and section_path.exists():
            print(f"[RESUME] Preskakuji jiz vygenerovanou sekci '{chapter_title}'")
        else:
            print(f"[GEN] Generuji obsah sekci: {chapter_title}")
            time.sleep(STEP_SLEEP_S)
            section_path.write_text(
                f"## {chapter_title}\n\nFake generated content for {key}.\n",
                encoding="utf-8",
            )

        nodes[key]["content_file_path"] = str(section_path)
        save_graph()
        print(f"[GEN] {i}/{total} Generated section '{chapter_title}'")
        md_parts.append(section_path.read_text(encoding="utf-8"))

    print("[MD] Skladam finalni Markdown vystup")
    time.sleep(STEP_SLEEP_S)
    if not args.no_md:
        (out_dir / f"{title}.md").write_text("\n".join(md_parts), encoding="utf-8")

    if args.export_tex:
        print("[LATEX] Exportuji TeX")
        time.sleep(STEP_SLEEP_S)
        (out_dir / f"{title}.tex").write_text(
            "\\documentclass{article}\n\\begin{document}\nFake\n\\end{document}\n",
            encoding="utf-8",
        )
        if not args.no_pdf:
            print("[PDF] Kompiluji PDF")
            time.sleep(STEP_SLEEP_S)
            (out_dir / f"{title}.pdf").write_bytes(b"%PDF-1.4\n% fake pdf for tests\n")

    run_meta = {"status": "ok", "mode": "book", "args": vars(args)}
    (out_dir / "run_meta.json").write_text(
        json.dumps(run_meta, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
    )
    (out_dir / "llm_usage.jsonl").write_text(
        json.dumps({"event": "usage", "tokens": 0, "cost_usd": 0.0}) + "\n",
        encoding="utf-8",
    )

    print("[TOKENS] Celkem spotrebovano tokenu: 0")
    print("[COST] Celkova cena: $0.000000")
    print("Hotovo.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
