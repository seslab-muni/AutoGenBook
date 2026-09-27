"""Engine benchmark: run the old and/or the new engine on the same inputs and compare.

Each run gets a fresh work dir laid out like the API's (`book_input.txt`, or
the bench's `input_file` for a `"mode": "paper"` bench,
`kb/<source_id>/<file>`, optional `out/book_structure.json`) and is started with
the exact argv/env/cwd the API uses (`api/infrastructure/cli/book_command.py:
build_command`) through the API's own process driver
(`api/infrastructure/cli/subprocess_runner.py:run`), so stdout parsing and the
section watcher behave exactly as in production.

Usage (from the repo root; see docs/ENGINE_REWRITE.md appendix A):

    # one engine
    python scripts/bench_engines.py --engine old --input input/bench/cs_book --out output/bench/x
    python scripts/bench_engines.py --engine new --input input/bench/en_book --concurrency 4
    python scripts/bench_engines.py --engine fake --input input/bench/cs_book   # tests/api/fake_cli.py, no key

    # old vs new on the same input, with the blind pairwise judge
    python scripts/bench_engines.py --compare --input input/bench/en_book --concurrency 1,4 --judge

    # concurrency sweep of the new engine (throughput and error/429 rate per level)
    python scripts/bench_engines.py --engine new --input input/bench/en_book --sweep 1,2,4,8

    # smoke-test the whole harness without any key: new engine against the fake LLM
    python scripts/bench_engines.py --engine new --input input/bench/en_book --fake-llm --judge

LLM settings come from the usual environment (`AUTOGENBOOK_LLM_BASE_URL`,
`AUTOGENBOOK_LLM_API_KEY`/`OPENROUTER_API_KEY`, `AUTOGENBOOK_LLM_MODEL`,
`AUTOGENBOOK_LLM_MINI_MODEL`); both engines see the same values. The judge
uses `--judge-model` (default: the mini model).

Output: `report.md` + `report.json` under `--out` (default
`output/bench/<timestamp>/`), plus every run's work dir and stdout log.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import math
import os
import random
import re
import shutil
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

ENTRYPOINTS = {
    "old": REPO_ROOT / "main.py",
    "new": REPO_ROOT / "run_engine.py",
    "fake": REPO_ROOT / "tests" / "api" / "fake_cli.py",
}

# Page budget metric, shared with engine/pipeline/length.py: a page is 40 typeset
# lines of ~90 characters; a Markdown paragraph is one source line, so each
# non-blank line counts as ceil(len / 90) typeset lines.
LINES_PER_PAGE = 40
CHARS_PER_LINE = 90
PAGE_TOLERANCE = 0.25

_CITE_TOKEN_RE = re.compile(r"\[([A-Za-z0-9_.:-]+)\]")
_LATEX_CITE_RE = re.compile(r"\\cite[pt]?\*?(?:\[[^\]]*\])?\{([^}]*)\}")
_RID_RE = re.compile(r"RID:[A-Za-z0-9_.:-]+")
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)
_WORD_RE = re.compile(r"\w+", re.UNICODE)


class _SettingsStub:
    """The four attributes `book_command.build_command` reads from `Settings`."""

    def __init__(self, entrypoint: Path, extract_cache: Path) -> None:
        self.cli_python = sys.executable
        self.cli_entrypoint = str(entrypoint)
        self.repo_root = str(REPO_ROOT)
        self.kb_extract_cache_dir = str(extract_cache)


@dataclass
class RunRecord:
    engine: str
    label: str
    work_dir: str
    exit_code: int
    wall_s: float
    concurrency: int | None = None
    stage_counts: dict[str, int] = field(default_factory=dict)
    usage: dict[str, Any] = field(default_factory=dict)
    quality: dict[str, Any] = field(default_factory=dict)
    fake_llm_requests: int | None = None


# ------------------------------------------------------------------ running
def prepare_work_dir(template: Path, dest: Path) -> dict[str, Any]:
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    bench = json.loads((template / "bench.json").read_text(encoding="utf-8")) if (template / "bench.json").exists() else {}
    input_file = bench.get("input_file", "book_input.txt")
    shutil.copy2(template / input_file, dest / input_file)
    if (template / "kb").is_dir():
        shutil.copytree(template / "kb", dest / "kb")
    if (template / "book_structure.json").exists():
        (dest / "out").mkdir(exist_ok=True)
        shutil.copy2(template / "book_structure.json", dest / "out" / "book_structure.json")
        bench.setdefault("outline", "project")
    return bench


def _mode_argv(argv: list[str], bench: dict[str, Any], work_dir: Path, output_format: str) -> list[str]:
    """The API only builds book argv; other modes reuse it with the old CLI's
    `--mode <mode> -i <input>` (both engines accept that) and that mode's
    output switches (paper writes .tex/.pdf unless told not to)."""
    mode = bench["mode"]
    out = list(argv)
    out[out.index("--mode") + 1] = mode
    out[out.index("-i") + 1] = str(work_dir / bench.get("input_file", f"{mode}_input.txt"))
    out = [a for a in out if a not in {"--export-tex", "--no-tex", "--no-pdf"}]
    out += {"markdown": ["--no-tex", "--no-pdf"], "latex": ["--no-pdf"]}.get(output_format, [])
    return out


def run_one(
    engine: str,
    template: Path,
    work_dir: Path,
    *,
    concurrency: int | None,
    context_mode: str | None,
    output_format: str | None,
    timeout_s: float,
    extra_args: list[str],
) -> RunRecord:
    from api.domain.models import RunOptions
    from api.infrastructure.cli import book_command, subprocess_runner

    bench = prepare_work_dir(template, work_dir)
    options = RunOptions(
        outline=bench.get("outline", "generate"),
        output_format=output_format or bench.get("output_format", "markdown"),
        llm_model=os.environ.get("AUTOGENBOOK_LLM_MODEL") or None,
    )
    settings = _SettingsStub(ENTRYPOINTS[engine], work_dir.parent / "_extract_cache")
    argv, env, cwd = book_command.build_command(
        work_dir, options, settings, author=os.environ.get("AUTOGENBOOK_BOOK_AUTHOR", "Benchmark")
    )
    if bench.get("mode", "book") != "book":
        argv = _mode_argv(argv, bench, work_dir, options.output_format)
    if engine == "new":
        if concurrency is not None:
            argv += ["--concurrency", str(concurrency)]
        if context_mode:
            argv += ["--context-mode", context_mode]
        # Engine-only knobs the API's allow-list would drop; forwarded so a bench
        # run can select embedding/rerank models without touching the API.
        for key, value in os.environ.items():
            if key.startswith(("AUTOGENBOOK_EMBED", "AUTOGENBOOK_RERANK", "AUTOGENBOOK_DENSE")):
                env[key] = value
    argv += extra_args
    stage_counts: dict[str, int] = {}

    def on_event(event: Any) -> None:
        stage_counts[event.stage] = stage_counts.get(event.stage, 0) + 1

    print(f"[bench] {engine}: {' '.join(argv[1:])}", file=sys.stderr, flush=True)
    t0 = time.perf_counter()
    exit_code = subprocess_runner.run(argv, env, cwd, work_dir, on_event, timeout_s=timeout_s)
    wall = time.perf_counter() - t0
    out_dir = work_dir / "out"
    return RunRecord(
        engine=engine,
        label=f"{engine}" + (f"@c{concurrency}" if concurrency else ""),
        work_dir=str(work_dir),
        exit_code=exit_code,
        wall_s=round(wall, 2),
        concurrency=concurrency,
        stage_counts=stage_counts,
        usage=collect_usage(out_dir),
        quality=quality_metrics(out_dir),
    )


# -------------------------------------------------------------------- usage
def collect_usage(out_dir: Path) -> dict[str, Any]:
    """Requests/tokens/cost from `llm_usage.jsonl` (both engines' formats),
    cross-checked with `run_meta.json` totals. The old engine logs only the
    last call of each agent run, so its request count is a lower bound."""
    requests = prompt = completion = total = 0
    cost = 0.0
    cost_known = False
    errors = rate_limited = 0
    path = out_dir / "llm_usage.jsonl"
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if rec.get("event") == "usage":  # fake_cli placeholder line
                continue
            requests += 1
            usage = rec.get("usage") or {}
            p = int(usage.get("prompt_tokens") or 0)
            c = int(usage.get("completion_tokens") or 0)
            t = int(usage.get("total_tokens") or (p + c))
            prompt += p
            completion += c
            total += t
            if isinstance(rec.get("cost_usd"), (int, float)):
                cost += float(rec["cost_usd"])
                cost_known = True
            status = rec.get("status")
            if isinstance(status, int) and status >= 400 or rec.get("error"):
                errors += 1
            if status == 429:
                rate_limited += 1
    meta_tokens = meta_cost = None
    meta_path = out_dir / "run_meta.json"
    if meta_path.exists():
        with contextlib.suppress(ValueError):
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            tv = [v for v in (meta.get("token_totals") or {}).values() if isinstance(v, (int, float))]
            cv = [v for v in (meta.get("cost_totals_usd") or {}).values() if isinstance(v, (int, float))]
            meta_tokens = int(sum(tv)) if tv else None
            meta_cost = float(sum(cv)) if cv else None
    return {
        "requests": requests,
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": total or (meta_tokens or 0),
        "cost_usd": round(cost, 6) if cost_known else meta_cost,
        "errors": errors,
        "rate_limited": rate_limited,
        "run_meta_tokens": meta_tokens,
    }


# ------------------------------------------------------------------ quality
def effective_lines(text: str) -> int:
    return sum(max(1, math.ceil(len(line.strip()) / CHARS_PER_LINE)) for line in text.splitlines() if line.strip())


def _leaves(graph: dict[str, Any]) -> list[str]:
    parents = {p for p, _ in graph.get("edges") or []}
    children: dict[str, list[str]] = {}
    for p, c in graph.get("edges") or []:
        children.setdefault(p, []).append(c)
    order: list[str] = []

    def walk(key: str) -> None:
        for child in children.get(key, []):
            if child in parents:
                walk(child)
            else:
                order.append(child)

    root = "book" if "book" in (graph.get("nodes") or {}) else next(iter(graph.get("nodes") or {"book": 0}))
    walk(root)
    return order


def _dfs(graph: dict[str, Any]) -> list[tuple[str, int]]:
    children: dict[str, list[str]] = {}
    for p, c in graph.get("edges") or []:
        children.setdefault(p, []).append(c)
    out: list[tuple[str, int]] = []

    def walk(key: str, depth: int) -> None:
        for child in children.get(key, []):
            out.append((child, depth))
            walk(child, depth + 1)

    root = "book" if "book" in (graph.get("nodes") or {}) else next(iter(graph.get("nodes") or {"book": 0}))
    walk(root, 1)
    return out


def section_text(out_dir: Path, key: str, node: dict[str, Any]) -> str | None:
    for candidate in (out_dir / "sections" / f"{key}.md", out_dir / "sections" / f"{key}.tex"):
        if candidate.exists():
            return candidate.read_text(encoding="utf-8", errors="replace")
    return None


def citation_tokens(text: str, known: set[str]) -> list[str]:
    tokens: list[str] = []
    for tok in _CITE_TOKEN_RE.findall(text):
        if tok in known or tok.startswith(("kb_", "web_", "RID:")):
            tokens.append(tok)
    for group in _LATEX_CITE_RE.findall(text):
        tokens.extend(k.strip() for k in group.split(",") if k.strip())
    for rid in _RID_RE.findall(text):
        if rid not in tokens:
            tokens.append(rid)
    return tokens


def _paragraphs(text: str) -> list[str]:
    return [p.strip() for p in re.split(r"\n\s*\n", text) if len(_WORD_RE.findall(p)) >= 30]


def _shingles(text: str, n: int = 5) -> set[tuple[str, ...]]:
    words = [w.casefold() for w in _WORD_RE.findall(text)]
    return {tuple(words[i : i + n]) for i in range(max(0, len(words) - n + 1))}


def _lcs(a: list[str], b: list[str]) -> int:
    prev = [0] * (len(b) + 1)
    for x in a:
        cur = [0]
        for j, y in enumerate(b, 1):
            cur.append(prev[j - 1] + 1 if x == y else max(prev[j], cur[j - 1]))
        prev = cur
    return prev[-1]


def _norm_title(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[*_`#]", "", text)).strip().casefold()


def quality_metrics(out_dir: Path) -> dict[str, Any]:
    graph_path = out_dir / "structure_graph.json"
    if not graph_path.exists():
        return {"error": "no structure_graph.json"}
    graph = json.loads(graph_path.read_text(encoding="utf-8"))
    nodes = graph.get("nodes") or {}
    kb = {}
    if (out_dir / "kb_sources.json").exists():
        kb = json.loads((out_dir / "kb_sources.json").read_text(encoding="utf-8"))
    known = set((kb.get("cite_keys") or {}).keys()) | set((kb.get("rids") or {}).keys())

    leaves = _leaves(graph)
    in_budget = 0
    deviations: list[float] = []
    cites_total = cites_resolved = 0
    unknown: set[str] = set()
    paragraphs: list[tuple[str, set[tuple[str, ...]]]] = []
    present = 0
    for key in leaves:
        node = nodes.get(key) or {}
        text = section_text(out_dir, key, node)
        if text is None:
            continue
        present += 1
        target = max(1.0, float(node.get("n_pages") or 1.0) * LINES_PER_PAGE)
        actual = effective_lines(text)
        deviations.append(abs(actual - target) / target)
        if abs(actual - target) <= PAGE_TOLERANCE * target:
            in_budget += 1
        for tok in citation_tokens(text, known):
            cites_total += 1
            if tok in known:
                cites_resolved += 1
            else:
                unknown.add(tok)
        for para in _paragraphs(text):
            paragraphs.append((key, _shingles(para)))
    duplicated = 0
    for i, (key_i, sh_i) in enumerate(paragraphs):
        for key_j, sh_j in paragraphs[:i] + paragraphs[i + 1 :]:
            if key_j == key_i or not sh_i or not sh_j:
                continue
            if len(sh_i & sh_j) / len(sh_i | sh_j) >= 0.5:
                duplicated += 1
                break

    heading_match = None
    finals = [p for p in out_dir.glob("*.md") if p.name not in {"README.md"}]
    if finals:
        final = max(finals, key=lambda p: p.stat().st_size).read_text(encoding="utf-8", errors="replace")
        headings = [_norm_title(h) for _lvl, h in _HEADING_RE.findall(final)]
        expected = [_norm_title(str((nodes.get(k) or {}).get("title") or "")) for k, _d in _dfs(graph)]
        expected = [e for e in expected if e]
        heading_match = round(_lcs(expected, headings) / len(expected), 3) if expected else None

    return {
        "leaves": len(leaves),
        "sections_present": present,
        "page_budget_in_range": round(in_budget / present, 3) if present else None,
        "page_budget_mean_abs_dev": round(sum(deviations) / len(deviations), 3) if deviations else None,
        "citations": cites_total,
        "citation_resolution_rate": round(cites_resolved / cites_total, 3) if cites_total else None,
        "unknown_citations": len(unknown),
        "duplicated_paragraph_rate": round(duplicated / len(paragraphs), 3) if paragraphs else 0.0,
        "heading_structure_match": heading_match,
    }


# -------------------------------------------------------------------- judge
JUDGE_SCHEMA = {
    "type": "object",
    "properties": {
        "winner": {"enum": ["A", "B", "tie"]},
        "grounding": {"enum": ["A", "B", "tie"]},
        "coherence": {"enum": ["A", "B", "tie"]},
        "pedagogy": {"enum": ["A", "B", "tie"]},
        "adherence": {"enum": ["A", "B", "tie"]},
        "reason": {"type": "string"},
    },
    "required": ["winner", "grounding", "coherence", "pedagogy", "adherence", "reason"],
}

JUDGE_PROMPT = """You compare two versions of the same book section written by two different systems.
Judge them blind on four criteria and pick an overall winner:
- grounding: claims are supported by the cited sources, citations look real and specific;
- coherence: the section fits between its neighbours (titles below) without repeating them;
- pedagogy: clear explanations, good examples, appropriate for the target readers;
- adherence: covers what the section summary asks for, at the requested length.
Book: {book_title}. Target readers: {readers}.
Section title: {title}
Section summary: {summary}
Previous section: {prev_title}. Next section: {next_title}.

=== Version A ===
{a}

=== Version B ===
{b}

Answer with JSON only. Schema name: JudgeVerdict
```json
{schema}
```"""


def _section_samples(run: RunRecord) -> list[dict[str, Any]]:
    out_dir = Path(run.work_dir) / "out"
    graph = json.loads((out_dir / "structure_graph.json").read_text(encoding="utf-8"))
    nodes = graph.get("nodes") or {}
    leaves = _leaves(graph)
    samples = []
    for i, key in enumerate(leaves):
        node = nodes.get(key) or {}
        text = section_text(out_dir, key, node)
        if text is None:
            continue
        samples.append(
            {
                "key": key,
                "pos": i / max(1, len(leaves) - 1),
                "title": str(node.get("title") or ""),
                "summary": str(node.get("summary") or ""),
                "prev": str((nodes.get(leaves[i - 1]) or {}).get("title") or "-") if i > 0 else "-",
                "next": str((nodes.get(leaves[i + 1]) or {}).get("title") or "-") if i + 1 < len(leaves) else "-",
                "text": text,
            }
        )
    return samples


def _pair_sections(a: list[dict[str, Any]], b: list[dict[str, Any]]) -> list[tuple[dict, dict]]:
    by_key = {s["key"]: s for s in b}
    pairs = []
    for s in a:
        other = by_key.get(s["key"])
        if other is not None and _norm_title(other["title"]) == _norm_title(s["title"]):
            pairs.append((s, other))
    if len(pairs) >= max(1, min(len(a), len(b)) // 2):
        return pairs
    # Different outlines (TXT-generated): pair by relative position in the book.
    return [(s, min(b, key=lambda o: abs(o["pos"] - s["pos"]))) for s in a] if b else []


def wilson(p: float, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 1.0)
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (round(max(0.0, centre - half), 3), round(min(1.0, centre + half), 3))


def judge(old: RunRecord, new: RunRecord, *, samples: int, model: str, seed: int = 7) -> dict[str, Any]:
    import openai

    base_url = os.environ.get("AUTOGENBOOK_LLM_BASE_URL") or os.environ.get("OPENROUTER_BASE_URL") or "https://openrouter.ai/api/v1"
    api_key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("AUTOGENBOOK_LLM_API_KEY") or "local"
    client = openai.OpenAI(base_url=base_url, api_key=api_key)
    graph = json.loads((Path(new.work_dir) / "out" / "structure_graph.json").read_text(encoding="utf-8"))
    book = (graph.get("nodes") or {}).get("book") or {}
    readers = (graph.get("graph") or {}).get("target_readers") or "-"
    pairs = _pair_sections(_section_samples(old), _section_samples(new))
    random.Random(seed).shuffle(pairs)
    pairs = pairs[:samples]
    wins = ties = losses = 0
    criteria: dict[str, dict[str, int]] = {}
    for old_s, new_s in pairs:
        for order in ("new_first", "old_first"):
            a, b = (new_s, old_s) if order == "new_first" else (old_s, new_s)
            prompt = JUDGE_PROMPT.format(
                book_title=book.get("title", "-"), readers=readers, title=new_s["title"],
                summary=new_s["summary"][:1500], prev_title=new_s["prev"], next_title=new_s["next"],
                a=a["text"][:12000], b=b["text"][:12000], schema=json.dumps(JUDGE_SCHEMA),
            )
            resp = client.chat.completions.create(
                model=model, messages=[{"role": "user", "content": prompt}],
                response_format={"type": "json_object"},
            )
            text = resp.choices[0].message.content or "{}"
            match = re.search(r"\{.*\}", text, re.DOTALL)
            try:
                verdict = json.loads(match.group(0)) if match else {}
            except ValueError:
                verdict = {}

            def who(value: Any) -> str:
                if value == "tie" or value not in {"A", "B"}:
                    return "tie"
                return "new" if (value == "A") == (order == "new_first") else "old"

            overall = who(verdict.get("winner"))
            wins += overall == "new"
            losses += overall == "old"
            ties += overall == "tie"
            for crit in ("grounding", "coherence", "pedagogy", "adherence"):
                bucket = criteria.setdefault(crit, {"new": 0, "old": 0, "tie": 0})
                bucket[who(verdict.get(crit))] += 1
    n = wins + losses + ties
    rate = (wins + 0.5 * ties) / n if n else None
    return {
        "judge_model": model,
        "pairs": len(pairs),
        "judgements": n,
        "new_wins": wins,
        "old_wins": losses,
        "ties": ties,
        "new_win_rate": round(rate, 3) if rate is not None else None,
        "new_win_rate_ci95": wilson(rate, n) if rate is not None else None,
        "criteria": criteria,
    }


# ------------------------------------------------------------------- report
def render_report(runs: list[RunRecord], judgement: dict[str, Any] | None, notes: list[str]) -> str:
    lines = [f"# Engine benchmark ({datetime.now(timezone.utc).isoformat(timespec='seconds')})", ""]
    lines += [f"- {n}" for n in notes] + [""]
    lines += [
        "| run | exit | wall s | requests | prompt tok | completion tok | cost USD | errors | 429 | sections | sec/min |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for r in runs:
        u, q = r.usage, r.quality
        present = q.get("sections_present") or 0
        per_min = round(present / (r.wall_s / 60), 2) if r.wall_s and present else 0
        lines.append(
            f"| {r.label} | {r.exit_code} | {r.wall_s} | {u.get('requests')} | {u.get('prompt_tokens')} | "
            f"{u.get('completion_tokens')} | {u.get('cost_usd')} | {u.get('errors')} | {u.get('rate_limited')} | "
            f"{present}/{q.get('leaves')} | {per_min} |"
        )
    lines += [
        "",
        "| run | page budget in ±25 % | mean abs dev | citations | resolved | unknown | dup. paragraphs | headings vs outline |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for r in runs:
        q = r.quality
        lines.append(
            f"| {r.label} | {q.get('page_budget_in_range')} | {q.get('page_budget_mean_abs_dev')} | {q.get('citations')} | "
            f"{q.get('citation_resolution_rate')} | {q.get('unknown_citations')} | {q.get('duplicated_paragraph_rate')} | "
            f"{q.get('heading_structure_match')} |"
        )
    if judgement:
        lines += [
            "",
            f"## Blind pairwise judge ({judgement['judge_model']}, both orders)",
            "",
            f"- pairs: {judgement['pairs']}, judgements: {judgement['judgements']}",
            f"- new wins {judgement['new_wins']}, old wins {judgement['old_wins']}, ties {judgement['ties']}",
            f"- new win rate: {judgement['new_win_rate']} (95 % CI {judgement['new_win_rate_ci95']})",
            "",
            "| criterion | new | old | tie |",
            "|---|---:|---:|---:|",
        ]
        for crit, b in judgement["criteria"].items():
            lines.append(f"| {crit} | {b['new']} | {b['old']} | {b['tie']} |")
    return "\n".join(lines) + "\n"


@contextlib.contextmanager
def fake_llm_server(enabled: bool) -> Iterator[Any]:
    if not enabled:
        yield None
        return
    sys.path.insert(0, str(REPO_ROOT / "tests" / "engine"))
    from fake_llm import FakeLLM  # type: ignore

    fake = FakeLLM()
    saved = {k: os.environ.get(k) for k in ("AUTOGENBOOK_LLM_BASE_URL", "AUTOGENBOOK_LLM_API_KEY", "OPENROUTER_API_KEY")}
    with fake.serve() as base_url:
        os.environ["AUTOGENBOOK_LLM_BASE_URL"] = base_url
        os.environ["AUTOGENBOOK_LLM_API_KEY"] = "fake"
        os.environ.pop("OPENROUTER_API_KEY", None)
        try:
            yield fake
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v


def _levels(value: str | None) -> list[int | None]:
    if not value:
        return [None]
    return [int(v) for v in value.split(",") if v.strip()]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--engine", choices=sorted(ENTRYPOINTS), default="new")
    parser.add_argument("--compare", action="store_true", help="run old and new on the same input")
    parser.add_argument("--input", required=True, help="benchmark dir, e.g. input/bench/cs_book")
    parser.add_argument("--out", default=None)
    parser.add_argument("--concurrency", default=None, help="new engine: one level or a comma list (e.g. 1,4)")
    parser.add_argument("--sweep", default=None, help="new engine concurrency sweep, e.g. 1,2,4,8")
    parser.add_argument("--context-mode", choices=["parallel", "chained"], default=None)
    parser.add_argument("--format", choices=["markdown", "latex", "pdf"], default=None)
    parser.add_argument("--judge", action="store_true", help="blind pairwise judge (needs an old and a new run)")
    parser.add_argument("--judge-samples", type=int, default=12)
    parser.add_argument("--judge-model", default=None)
    parser.add_argument("--fake-llm", action="store_true", help="serve tests/engine/fake_llm.py for the new engine")
    parser.add_argument("--timeout", type=float, default=6 * 3600)
    parser.add_argument("--old-run", default=None, help="reuse an existing old-engine work dir instead of running it")
    parser.add_argument("extra", nargs="*", help="extra argv appended to every run (after --)")
    args = parser.parse_args(argv)

    template = Path(args.input) if Path(args.input).is_absolute() else REPO_ROOT / args.input
    out_root = Path(args.out) if args.out else REPO_ROOT / "output" / "bench" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_root.mkdir(parents=True, exist_ok=True)
    notes = [f"input: `{template.relative_to(REPO_ROOT) if template.is_relative_to(REPO_ROOT) else template}`"]
    runs: list[RunRecord] = []
    engines = ["old", "new"] if args.compare else [args.engine]
    levels = _levels(args.sweep or args.concurrency)

    with fake_llm_server(args.fake_llm) as fake:
        if fake is not None:
            notes.append("**Fake-LLM smoke numbers** (tests/engine/fake_llm.py): timings, tokens and quality are not real.")
        model = os.environ.get("AUTOGENBOOK_LLM_MODEL") or "openai/gpt-5-mini (default)"
        notes.append(f"model: `{model}`; base URL: `{os.environ.get('AUTOGENBOOK_LLM_BASE_URL') or 'OpenRouter (default)'}`")
        for engine in engines:
            if engine == "old" and args.old_run:
                old_dir = Path(args.old_run)
                runs.append(RunRecord("old", "old (reused)", str(old_dir), 0, 0.0,
                                      usage=collect_usage(old_dir / "out"), quality=quality_metrics(old_dir / "out")))
                continue
            for level in (levels if engine == "new" else [None]):
                label = f"{engine}" + (f"_c{level}" if level else "")
                before = len(fake.calls) if fake is not None else 0
                record = run_one(
                    engine, template, out_root / label,
                    concurrency=level, context_mode=args.context_mode, output_format=args.format,
                    timeout_s=args.timeout, extra_args=list(args.extra),
                )
                if fake is not None:
                    record.fake_llm_requests = len(fake.calls) - before
                runs.append(record)
        judgement = None
        if args.judge:
            old_runs = [r for r in runs if r.engine in {"old", "fake"}]
            new_runs = [r for r in runs if r.engine == "new"]
            if not old_runs and args.fake_llm and new_runs:
                # Smoke mode: judge the new run against itself so the judge path is exercised.
                old_runs = new_runs[:1]
                notes.append("judge ran new-vs-new (smoke): no old run available")
            if old_runs and new_runs:
                judge_model = args.judge_model or os.environ.get("AUTOGENBOOK_LLM_MINI_MODEL") or os.environ.get("AUTOGENBOOK_LLM_MODEL") or "openai/gpt-5-mini"
                judgement = judge(old_runs[0], new_runs[-1], samples=args.judge_samples, model=judge_model)
            else:
                notes.append("judge skipped: needs one old and one new run")

    if args.sweep:
        notes.append("concurrency sweep: sections/min and error/429 counts per level are in the first table")
    report = render_report(runs, judgement, notes)
    (out_root / "report.md").write_text(report, encoding="utf-8")
    (out_root / "report.json").write_text(
        json.dumps({"runs": [r.__dict__ for r in runs], "judge": judgement, "notes": notes}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(report)
    print(f"[bench] report written to {out_root}", file=sys.stderr)
    return 0 if all(r.exit_code == 0 for r in runs) else 1


if __name__ == "__main__":
    raise SystemExit(main())
