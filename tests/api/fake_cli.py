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
find, and `graph.input_path`/`graph.input_sha256` stamped like the real
CLI's own drift check), `sections/<key>.md`, `kb_sources.json` (only when
`--kb-dir` is given), `<Title>.md`, `run_meta.json`, and `llm_usage.jsonl`.

`--resume` mirrors `book_pipeline.py`'s own short-circuit: if a previous
`structure_graph.json` exists and its `input_sha256` still matches, its
`nodes`/`edges` are loaded verbatim instead of re-derived from
`book_structure.json`/TXT - so a `summary` edited directly in that file
(issue #11's regenerate-with-a-prompt-modifier flow) survives into the
fabricated section content instead of being clobbered by a fresh rebuild.
Per leaf, a section whose output file already exists is skipped; `--export-
tex` writes stub `.tex`/`.pdf` files regardless of what was (or wasn't)
regenerated.
"""

from __future__ import annotations

import argparse
import hashlib
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

    # For issue #76's regression test: LuaLaTeX/pandoc routinely write
    # non-UTF-8 bytes to stderr, which `subprocess_runner.py` merges into
    # stdout - simulate exactly that (one bad byte inline with an otherwise
    # normal `[TAG]` line) so tests can assert the reader thread survives
    # it (`errors="replace"`) instead of dying silently and hanging the run.
    if os.environ.get("FAKE_CLI_EMIT_BAD_BYTE") == "1":
        sys.stdout.buffer.write(b"[GEN] non-utf8 byte follows: \xff end\n")
        sys.stdout.buffer.flush()

    input_path = Path(args.input).expanduser().resolve()
    if not input_path.exists():
        print(f"Chyba: vstupni soubor neexistuje: {input_path}", file=sys.stderr)
        return 2
    input_sha256 = hashlib.sha256(input_path.read_bytes()).hexdigest()

    out_dir = Path(args.out_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    sections_dir = out_dir / "sections"
    sections_dir.mkdir(parents=True, exist_ok=True)

    # One chunk per file, shaped like `autogenbook.retrieval.kb_citations.
    # build_kb_index`'s real `kb_sources.json` (`cite_keys`/`rids`/`chunks`),
    # not the CLI's own richer per-chunk splitting - close enough for the API
    # to exercise its `kb_sources.json` parsing (source chunk counts, ragCitations).
    kb_chunks: list[dict] = []
    if args.kb_dir:
        kb_dir = Path(args.kb_dir).expanduser().resolve()
        print(f"[KB] Buduji/nactivam znalostni databazi z: {kb_dir}")
        time.sleep(STEP_SLEEP_S)
        # Sources are downloaded one file per `kb/<source_id>/<filename>`
        # subdirectory (`api.application.runs.GenerationService._download_sources`).
        files = sorted(kb_dir.glob("*/*")) if kb_dir.is_dir() else []
        cite_keys: dict[str, dict] = {}
        rids: dict[str, dict] = {}
        for index, path in enumerate(files, start=1):
            if not path.is_file():
                continue
            rid = f"kb{index}"
            cite_key = f"kb{index}"
            entry = {
                "source_path": str(path),
                "loc": "chunk 1",
                "rid": rid,
                "cite_key": cite_key,
                "excerpt": f"Fake excerpt from {path.name}",
            }
            kb_chunks.append(entry)
            summary_entry = {"source_path": entry["source_path"], "loc": entry["loc"], "excerpt": entry["excerpt"]}
            cite_keys[cite_key] = summary_entry
            rids[rid] = summary_entry
        (out_dir / "kb_sources.json").write_text(
            json.dumps(
                {"cite_keys": cite_keys, "rids": rids, "page_keys": {}, "chunks": kb_chunks},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        print(f"[KB] Hotovo. Pocet chunku: {len(kb_chunks)}")
    else:
        print("[KB] --kb-dir nebyl zadan. RAG bude vypnut.")

    graph_path = out_dir / "structure_graph.json"

    # Mirrors `book_pipeline.py`'s own `--resume` short-circuit: when a
    # previous `structure_graph.json` exists and its `input_sha256` still
    # matches, resume loads that graph's `nodes`/`edges` verbatim (never
    # re-derived from `book_structure.json`/TXT) - the one thing that makes
    # a `regenerate_section` run's edited `summary` (the prompt modifier)
    # actually reach the fabricated section content below instead of being
    # clobbered by a fresh rebuild.
    resumed = False
    nodes: dict[str, dict] = {}
    edges: list[list[str]] = []
    if args.resume and graph_path.exists():
        existing = json.loads(graph_path.read_text(encoding="utf-8"))
        stored_sha256 = str((existing.get("graph") or {}).get("input_sha256") or "").strip()
        if not stored_sha256 or stored_sha256 == input_sha256:
            print(f"[RESUME] Nacitam ulozenou strukturu z: {graph_path}")
            nodes = existing.get("nodes") or {}
            edges = existing.get("edges") or []
            resumed = True
        else:
            print("[RESUME] Preskakuji --resume: vstupni soubor byl zmenen.")

    if resumed:
        title = str(nodes.get("book", {}).get("title") or "Fake Book")
    else:
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
        summary = book_json.get("summary") or ""

        nodes = {"book": {"title": title, "summary": summary}}
        edges = []

        # `childs` (nested, dash-keyed "1", "1-2", ...) is the shape
        # `StructureBuilder.build` produces for `--use-json` runs - mirrors
        # `book_builder.py:build_graph_from_book_json`'s key scheme exactly, so
        # a key here matches the outline's own `assign_positions` cli_key. Falls
        # back to the older flat "chapters" mock shape (`_default_book_json`)
        # when there's no real outline behind this run.
        def add_children(parent_key: str, children: list[dict]) -> None:
            for i, child in enumerate(children, start=1):
                key = str(i) if parent_key == "book" else f"{parent_key}-{i}"
                nodes[key] = {
                    "title": str(child.get("title", key)).strip(),
                    "summary": str(child.get("summary", "")).strip(),
                }
                edges.append([parent_key, key])
                nested = [c for c in (child.get("childs") or []) if isinstance(c, dict)]
                if nested:
                    add_children(key, nested)

        childs = [c for c in (book_json.get("childs") or []) if isinstance(c, dict)]
        if childs:
            add_children("book", childs)
        else:
            chapters = book_json.get("chapters") or [
                {"key": "ch1", "title": "Chapter One"},
                {"key": "ch2", "title": "Chapter Two"},
            ]
            for chapter in chapters:
                key = chapter["key"]
                nodes[key] = {"title": chapter.get("title", key)}
                edges.append(["book", key])

    # Leaves are the only nodes that get generated content - anything else
    # is a parent kept only for the tree shape, exactly like the real CLI.
    parent_keys = {parent for parent, _ in edges}
    leaf_keys = [key for key in nodes if key != "book" and key not in parent_keys]

    def save_graph() -> None:
        graph_path.write_text(
            json.dumps(
                {
                    "graph": {"input_path": str(input_path), "input_sha256": input_sha256},
                    "nodes": nodes,
                    "edges": edges,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    save_graph()
    print("[SUBDIVIDE] Trvani: 0.0s")

    total = len(leaf_keys)
    md_parts = [f"# {title}\n"]
    for i, key in enumerate(leaf_keys, start=1):
        node_title = nodes[key].get("title", key)
        section_path = sections_dir / f"{key}.md"

        if args.resume and section_path.exists():
            print(f"[RESUME] Preskakuji jiz vygenerovanou sekci '{node_title}'")
        else:
            print(f"[GEN] Generuji obsah sekci: {node_title}")
            time.sleep(STEP_SLEEP_S)
            content = f"## {node_title}\n\nFake generated content for {key}.\n"
            section_summary = str(nodes[key].get("summary") or "").strip()
            if section_summary:
                content += f"\n{section_summary}\n"
            if i == 1 and kb_chunks:
                content += f"\nSee [{kb_chunks[0]['cite_key']}] for details.\n"
            section_path.write_text(content, encoding="utf-8")

        nodes[key]["content_file_path"] = str(section_path)
        save_graph()
        print(f"[GEN] {i}/{total} Generated section '{node_title}'")
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
