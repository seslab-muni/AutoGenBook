"""Retrieval benchmark: recall@k and MRR per retriever on the benchmark KBs.

Usage (from the repo root):

    # the old engine's KB (rag_kb.KnowledgeBase, lexical BM25) - the baseline
    python scripts/bench_retrieval.py --retriever old

    # every retriever this machine can run, on every benchmark KB
    python scripts/bench_retrieval.py --retriever all

    # one KB, a subset of retrievers, a different cut-off
    python scripts/bench_retrieval.py --kb input/bench/cs_book --retriever old,bm25-lemma,hybrid --k 6

    # (re)generate question sets with the mini model (needs an LLM endpoint)
    python scripts/bench_retrieval.py generate-questions --kb input/bench/en_book --lang cs --n 40

Retrievers (`--retriever`, comma separated, or `all`):

    old                  rag_kb.KnowledgeBase (pypdf, 1800-char windows, accent-folded BM25)
    bm25-plain           engine chunking + BM25 with the old tokeniser (isolates chunking)
    bm25-lemma           engine chunking + lemmatised bm25s (simplemma)
    dense[:MODEL]        embeddings only (remote /v1/embeddings; MODEL defaults to
                         AUTOGENBOOK_EMBED_MODEL or qwen3-embedding-4b; `local` = multilingual-e5-small)
    hybrid[:MODEL]       BM25 + dense fused with reciprocal rank fusion
    hybrid-rerank[:MODEL]  hybrid + remote reranker (AUTOGENBOOK_RERANK_MODEL, default qwen3-reranker-4b)
    hybrid-llmrerank[:MODEL]  hybrid + listwise LLM reranking with the mini model

Remote models use `AUTOGENBOOK_LLM_BASE_URL` / `AUTOGENBOOK_LLM_API_KEY` (or the
`AUTOGENBOOK_EMBED_*` / `AUTOGENBOOK_RERANK_*` overrides). `--fake-llm` serves
the deterministic fake from tests/engine/fake_llm.py instead, which proves the
script end to end but produces meaningless dense/rerank numbers.

Relevance: an item is relevant when its excerpt (what an agent would see, at
most 1500 characters) contains the question's answer span, compared case-,
accent-, whitespace- and hyphenation-insensitively. Output: a Markdown table
and JSON under output/bench/retrieval-<timestamp>/.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import re
import sys
import tempfile
import time
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Protocol

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

DEFAULT_KBS = ("input/bench/cs_book", "input/bench/en_book")
EXCERPT_CHARS = 1500


# ------------------------------------------------------------------ relevance
def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.replace("￾", "").replace("­", "")
    text = re.sub(r"(\w)-\s+(\w)", r"\1\2", text)
    text = re.sub(r"[‐-―]", "-", text).replace("’", "'")
    return re.sub(r"\s+", " ", text).strip().casefold()


def is_relevant(excerpt: str, answer: str) -> bool:
    return normalize(answer) in normalize(excerpt)


# ----------------------------------------------------------------- retrievers
class BenchRetriever(Protocol):
    name: str

    def build(self, kb_dir: Path, work_dir: Path) -> None: ...

    def search(self, question: str, k: int) -> list[str]: ...


class OldRetriever:
    """The old engine's KB through its own public API, unchanged."""

    name = "old"

    def build(self, kb_dir: Path, work_dir: Path) -> None:
        from rag_kb import KnowledgeBase  # old engine, read-only use

        # A fresh index cache every time (so the index is really rebuilt) but a
        # shared extraction cache, so the second build measures a warm cache.
        self._builds = getattr(self, "_builds", 0) + 1
        with contextlib.redirect_stdout(sys.stderr):
            self.kb = KnowledgeBase.build_from_directory(
                kb_dir, cache_dir=work_dir / f"old_kb_cache_{self._builds}",
                extract_cache_dir=work_dir / "old_extract_cache",
            )

    def search(self, question: str, k: int) -> list[str]:
        from autogenbook.retrieval.sanitize import sanitize_context_text

        return [
            sanitize_context_text(chunk.text.strip())[:EXCERPT_CHARS]
            for chunk, _score in self.kb.retrieve(question, k=k)
        ]


class EngineRetriever:
    """Adapter over `engine.retrieval` (phase 3, #152)."""

    def __init__(self, name: str, mode: str, embed_model: str | None, transport: Any = None) -> None:
        self.name = name
        self.mode = mode
        self.embed_model = embed_model
        self.transport = transport

    def build(self, kb_dir: Path, work_dir: Path) -> None:
        from engine.retrieval.bench import build_bench_retriever

        self._loop = asyncio.new_event_loop()
        self.impl = self._loop.run_until_complete(
            build_bench_retriever(
                kb_dir, work_dir, mode=self.mode, embed_model=self.embed_model, transport=self.transport
            )
        )

    def search(self, question: str, k: int) -> list[str]:
        items = self._loop.run_until_complete(self.impl.search([question], k=k))
        return [item.excerpt(EXCERPT_CHARS) for item in items]

    def close(self) -> None:
        with contextlib.suppress(Exception):
            self._loop.run_until_complete(self.impl.aclose())
        self._loop.close()


def make_retrievers(spec: str, transport: Any) -> list[BenchRetriever]:
    names: list[str] = []
    for name in (s.strip() for s in spec.split(",") if s.strip()):
        expanded = ["old", "bm25-plain", "bm25-lemma", "dense", "hybrid", "hybrid-rerank"] if name == "all" else [name]
        names += [n for n in expanded if n not in names]
    out: list[BenchRetriever] = []
    for name in names:
        base, _, model = name.partition(":")
        if base == "old":
            out.append(OldRetriever())
        elif base in {"bm25-plain", "bm25-lemma", "dense", "hybrid", "hybrid-rerank", "hybrid-llmrerank"}:
            out.append(EngineRetriever(name, base, model or None, transport))
        else:
            raise SystemExit(f"unknown retriever: {name}")
    return out


# ------------------------------------------------------------------ evaluation
@dataclass
class SetResult:
    kb: str
    set_name: str
    retriever: str
    n: int
    recall: float
    mrr: float
    build_s: float
    query_s: float
    recall_at_1: float = 0.0
    recall_at_3: float = 0.0
    build_warm_s: float = 0.0
    misses: list[str] = field(default_factory=list)


def evaluate(retriever: BenchRetriever, kb: Path, k: int, work_dir: Path) -> list[SetResult]:
    questions = json.loads((kb / "questions.json").read_text(encoding="utf-8"))
    t0 = time.perf_counter()
    retriever.build(kb / "kb", work_dir)
    build_s = time.perf_counter() - t0
    close = getattr(retriever, "close", None)
    if close:
        close()
    t0 = time.perf_counter()
    retriever.build(kb / "kb", work_dir)  # warm extraction (and vector) cache, index rebuilt
    build_warm_s = time.perf_counter() - t0
    results: list[SetResult] = []
    for set_name, items in questions["sets"].items():
        hits = hits1 = hits3 = 0
        rr = 0.0
        misses: list[str] = []
        t1 = time.perf_counter()
        for item in items:
            excerpts = retriever.search(item["question"], k)
            rank = next((i for i, ex in enumerate(excerpts[:k], 1) if is_relevant(ex, item["answer"])), None)
            if rank is None:
                misses.append(item["id"])
            else:
                hits += 1
                hits1 += rank == 1
                hits3 += rank <= 3
                rr += 1.0 / rank
        n = len(items)
        results.append(
            SetResult(
                kb=kb.name, set_name=set_name, retriever=retriever.name, n=n,
                recall=hits / n if n else 0.0, mrr=rr / n if n else 0.0,
                build_s=build_s, query_s=time.perf_counter() - t1, misses=misses,
                recall_at_1=hits1 / n if n else 0.0, recall_at_3=hits3 / n if n else 0.0, build_warm_s=build_warm_s,
            )
        )
    return results


def render_markdown(results: list[SetResult], k: int, note: str) -> str:
    lines = [
        f"# Retrieval benchmark ({datetime.now(timezone.utc).isoformat(timespec='seconds')})",
        "",
        note,
        "",
        f"| KB | set | retriever | n | recall@1 | recall@3 | recall@{k} | MRR@{k} | build cold s | build warm s | query s |",
        "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for r in results:
        lines.append(
            f"| {r.kb} | {r.set_name} | {r.retriever} | {r.n} | {r.recall_at_1:.3f} | {r.recall_at_3:.3f} | "
            f"{r.recall:.3f} | {r.mrr:.3f} | {r.build_s:.2f} | {r.build_warm_s:.2f} | {r.query_s:.2f} |"
        )
    return "\n".join(lines) + "\n"


@contextlib.contextmanager
def maybe_fake_llm(enabled: bool) -> Iterator[Any]:
    if not enabled:
        yield None
        return
    sys.path.insert(0, str(REPO_ROOT / "tests" / "engine"))
    from fake_llm import FakeLLM  # type: ignore

    fake = FakeLLM()
    with fake.serve() as base_url:
        os.environ["AUTOGENBOOK_LLM_BASE_URL"] = base_url
        os.environ.setdefault("AUTOGENBOOK_LLM_API_KEY", "fake")
        yield None


def cmd_run(args: argparse.Namespace) -> int:
    kbs = [Path(p) if Path(p).is_absolute() else REPO_ROOT / p for p in (args.kb or DEFAULT_KBS)]
    out_dir = Path(args.out) if args.out else REPO_ROOT / "output" / "bench" / (
        "retrieval-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    )
    out_dir.mkdir(parents=True, exist_ok=True)
    results: list[SetResult] = []
    with maybe_fake_llm(args.fake_llm):
        for retriever in make_retrievers(args.retriever, None):
            for kb in kbs:
                with tempfile.TemporaryDirectory(prefix="bench_retrieval_") as tmp:
                    print(f"[bench] {retriever.name} on {kb.name} ...", file=sys.stderr, flush=True)
                    try:
                        results.extend(evaluate(retriever, kb, args.k, Path(tmp)))
                    finally:
                        close = getattr(retriever, "close", None)
                        if close:
                            close()
    note = (
        "Fake-LLM smoke run: dense and rerank numbers are meaningless (hashed bag-of-words "
        "embeddings, lexical-overlap reranker)."
        if args.fake_llm
        else "Real run."
    )
    md = render_markdown(results, args.k, note)
    (out_dir / "report.md").write_text(md, encoding="utf-8")
    (out_dir / "report.json").write_text(
        json.dumps([r.__dict__ for r in results], ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(md)
    print(f"[bench] report written to {out_dir}", file=sys.stderr)
    return 0


# -------------------------------------------------------- question generation
GEN_PROMPT = """You write evaluation questions for a retrieval system.
Passage (from the file {source}):
<<<
{passage}
>>>
Write {n} questions in {language} that this passage answers. For each question copy
an answer span of 4 to 15 words VERBATIM from the passage (same language as the passage,
exact characters). Return JSON: {{"questions": [{{"question": "...", "answer_span": "..."}}]}}"""

LANG_NAMES = {"cs": "Czech", "en": "English", "de": "German", "sk": "Slovak"}


def cmd_generate(args: argparse.Namespace) -> int:
    import openai

    kb = Path(args.kb) if Path(args.kb).is_absolute() else REPO_ROOT / args.kb
    with maybe_fake_llm(args.fake_llm):
        base_url = os.environ.get("AUTOGENBOOK_LLM_BASE_URL") or "https://openrouter.ai/api/v1"
        api_key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("AUTOGENBOOK_LLM_API_KEY") or "local"
        model = os.environ.get("AUTOGENBOOK_LLM_MINI_MODEL") or os.environ.get("AUTOGENBOOK_LLM_MODEL") or "openai/gpt-5-mini"
        client = openai.OpenAI(base_url=base_url, api_key=api_key)
        with tempfile.TemporaryDirectory() as tmp:
            old = OldRetriever()
            old.build(kb / "kb", Path(tmp))
            chunks = [c for c in old.kb.chunks if len(c.text) > 400]
        step = max(1, len(chunks) // max(1, args.n // 2))
        picked = chunks[::step][: max(1, args.n // 2)]
        out: list[dict[str, Any]] = []
        for chunk in picked:
            rel = Path(chunk.source_path).resolve().relative_to((kb / "kb").resolve()).as_posix()
            resp = client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": GEN_PROMPT.format(
                    source=rel, passage=chunk.text[:2500], n=2, language=LANG_NAMES.get(args.lang, args.lang))}],
                response_format={"type": "json_object"},
            )
            text = resp.choices[0].message.content or "{}"
            match = re.search(r"\{.*\}", text, re.DOTALL)
            try:
                data = json.loads(match.group(0)) if match else {}
            except ValueError:
                data = {}
            for q in data.get("questions") or []:
                span = str(q.get("answer_span") or "")
                if span and is_relevant(chunk.text, span):
                    out.append({"question": str(q.get("question") or ""), "answer": span, "source": rel})
    path = kb / "questions.json"
    data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"sets": {}}
    existing = data["sets"].get(args.lang, []) if args.append else []
    merged = existing + out
    for i, item in enumerate(merged, 1):
        item["id"] = f"{args.lang}-{i:02d}"
    data["sets"][args.lang] = merged
    if args.dry_run:
        print(json.dumps(out, ensure_ascii=False, indent=1))
    else:
        path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"[bench] {len(out)} verified questions ({args.lang})", file=sys.stderr)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd")
    gen = sub.add_parser("generate-questions", help="generate question sets with the mini model")
    gen.add_argument("--kb", required=True)
    gen.add_argument("--lang", default="en")
    gen.add_argument("--n", type=int, default=40)
    gen.add_argument("--append", action="store_true")
    gen.add_argument("--dry-run", action="store_true")
    gen.add_argument("--fake-llm", action="store_true")
    parser.add_argument("--retriever", default="old")
    parser.add_argument("--kb", action="append", help="benchmark dir (repeatable); default: all under input/bench")
    parser.add_argument("--k", type=int, default=6)
    parser.add_argument("--out", default=None)
    parser.add_argument("--fake-llm", action="store_true", help="serve the deterministic fake LLM locally")
    args = parser.parse_args(argv)
    if args.cmd == "generate-questions":
        return cmd_generate(args)
    return cmd_run(args)


if __name__ == "__main__":
    raise SystemExit(main())
