# Engine rewrite: design and plan

Status: decided (September 2026). Owner: Patrik Procházka. Tracking: epic #158 (sub-issues #150 to #157)
on `seslab-muni/AutoGenBook`, milestone "Engine rewrite".

## 1. Decision

We are rewriting the AutoGenBook generation engine from scratch as a **new Python package that
lives next to the current CLI**, so both engines can be run on the same inputs and compared. The
**external contract stays frozen** (section 3): the FastAPI service and the web UI must not need
any change to switch engines beyond pointing `CLI_ENTRYPOINT` at the new entrypoint.

The current CLI is a fork of `pkonas/AutoGenBook`. Upstream has a single commit (June 2026) and no
activity since, so keeping the CLI mergeable with it is no longer a goal. Once the new engine wins
the side-by-side benchmark, the old engine is deleted and the GitHub fork relationship is detached
(section 9).

Non-goals for the first milestone:

- Changing the API or the frontend. Anything the new engine wants to expose beyond the contract goes
  into *additional* files or flags that the old engine simply does not produce.
- Scientist, proposal and reviewer modes. They are dropped; the old CLI stays on a git tag.
- API and frontend support for paper and presentation. The web stack only invokes `--mode book`
  today; paper and presentation are ported as CLI output types first (section 8) and wired into the
  web stack in later issues.
- Any change to `api/` or `app/` before the switch. The engine writes `events.jsonl` and supports
  streaming, but the API adopts them in a follow-up issue after the switch.

## 2. Why the current engine is slow, and what else is wrong with it

Facts, with the code they come from. These drive the design in section 4.

**Wall-clock time is dominated by strictly sequential LLM round trips.**

- Every leaf section runs, in order: writer, reviewer, reviser, reviewer again, up to two
  length-control passes, and the context-memory agent (`book_builder.py:generate_contents`,
  lines ~938-1114). That is four to seven calls per section with no concurrency anywhere.
- Sections are serialised by two data dependencies: the previous section's full text is an input to
  the writer (`n_previous_sections = 1`), and the context-memory update produced after section N is
  an input to section N+1. A forty-leaf book is therefore ~200 sequential network calls.
- The LLM client is the synchronous `openai` SDK with a 300 s timeout and a retry loop
  (`openrouter_llm.py:_chat_once`). There is no streaming, no JSON mode, and no structured
  outputs; JSON is scraped from free text and repaired with extra LLM calls (`agents/base.py`,
  up to three parse attempts plus two schema repairs per agent call).
- JSON/TXT outline generation and the "redundancy" revision pass are two more sequential calls on
  two separate client instances before any section is written.

**Quality and correctness problems that a rewrite should not carry over.**

- Usage accounting records only the *last* LLM call of each agent run; repair and retry calls are
  not itemised in `llm_usage.jsonl` (`agents/base.py:run`).
- The reviser receives the review as a Python `repr()` of a dict, not JSON (`book_builder.py:1035`).
- Final Markdown output leaves `\cite{...}` and `\footnote{Source: ...}` raw; citations are only
  resolved into a bibliography on the LaTeX path (`_apply_iso690_citations_v3`).
- The API imports citations from section Markdown by matching `[cite_key]` tokens
  (`api/application/graph_import.py:_CITATION_TOKEN_RE`), but the writer prompt asks for
  `\cite{cite_key}`. Citation import therefore silently finds nothing today.
- On `--resume`, the "previous section" list is not rebuilt from already-generated sections, so the
  first regenerated section sees `previous_sections="(none)"`.
- Agent I/O logs are keyed by a second-resolution timestamp and overwrite each other.
- `main.py` hardcodes token prices at import time, bypassing the OpenRouter pricing lookup.
- Prompts live in a process-global registry that must be set before agents are constructed;
  unknown `{placeholders}` are silently left in the prompt.
- Several code paths still call `input()`; the API works around this with environment flags.
- `book_builder.py` (4.8k lines) and `proposal_pipeline.py` (4.8k lines) are single-file monoliths;
  each mode duplicates graph, retrieval, assembly and PDF logic.

## 3. The frozen contract

This is what `api/` actually depends on today. It was derived from
`api/infrastructure/cli/{book_command,stdout_parser,subprocess_runner,artifacts}.py`,
`api/application/{runs,graph_import,book_spec}.py` and `tests/api/fake_cli.py`. The new engine
must honour every item in 3.1 to 3.5. Anything not listed here is free to change.

### 3.1 Invocation

`<CLI_PYTHON> <CLI_ENTRYPOINT> --mode book -i <work_dir>/book_input.txt -o <work_dir>/out` plus:

| Flag | When the API sends it |
|---|---|
| `-j book_structure.json --use-json` | outline mode "project" (`-j` is relative to `-o`) |
| `--use-txt` | outline mode "generate" |
| `--kb-dir <work_dir>/kb` | when the directory exists; one sub-directory per project source |
| `--no-tex --no-pdf` / `--export-tex --no-pdf` / `--export-tex` | output format markdown / latex / pdf |
| `--resume` | retries, per-node regenerate, exports |
| `--rebuild-kb`, `--enable-web-rag`, `--audit-book [--audit-book-mode off|strict]`, `--legacy-tex`, `--fail-fast-schema` | per-run options |

The process is started with `cwd = repo root`, stderr merged into stdout, in its own session;
cancel is SIGTERM then SIGKILL after 15 s; the run timeout is SIGKILL after 6 h. Exit code 0 is
success, anything else is failure. The engine must therefore be **fully non-interactive** and must
flush stdout line by line.

Environment reaching the child (allow-listed by the API): `OPENROUTER_API_KEY`,
`AUTOGENBOOK_LLM_BASE_URL`, `AUTOGENBOOK_LLM_API_KEY`, `AUTOGENBOOK_LLM_MODEL`,
`AUTOGENBOOK_LLM_MINI_MODEL`, `AUTOGENBOOK_FORCE_MINI_MODEL`, `AUTOGENBOOK_KB_OCR`,
`AUTOGENBOOK_KB_OCR_LANG`, `AUTOGENBOOK_KB_EXTRACT_CACHE_DIR`, `AUTOGENBOOK_BOOK_AUTHOR`,
`TAVILY_API_KEY`, the `OPENROUTER_*` client knobs, proxy/SSL/`PATH`/`HOME`/`LANG`, and the forced
`AUTOGENBOOK_NONINTERACTIVE=1`, `MCP_GATEWAY_ENABLE=0`, `PYTHONUNBUFFERED=1`, `PYTHONUTF8=1`.

### 3.2 Inputs the API writes

- `book_input.txt`: `Title:`, `Summary:`, `Target readers:`, `Total pages:`, optional
  `Additional requirements:`; in project mode also `##`-style headings `<title> (N pages)` with
  `- ` bullets. The engine hashes this file (`input_sha256`).
- `out/book_structure.json` (project mode): top-level `title, summary, n_pages, target_readers,
  equation_frequency_level, do_consider_outline, do_consider_previous_sections,
  additional_requirements, max_depth, max_output_pages, childs[]`; per child `title, summary
  (may end with a "Writing instructions: ..." block), n_pages, needsSubdivision, childs,
  structure_locked, content_locked, content_file, kb_scope, kb_sources`.
- `out/locked_sections/<uuid>.md`: bodies of content-locked leaves, referenced by `content_file`.
- `kb/<source_id>/<filename>`: project sources. `kb_sources` entries are paths relative to `kb/`.

### 3.3 Stdout protocol

Lines are classified by prefix with `str.startswith`: `[KB]`, `[JSON]`, `[SUBDIVIDE]`, `[GEN]`,
`[MD]`, `[LATEX]`, `[PDF]`, `[RESUME]`, `[WARN]`, `[INFO]`, `[TOKENS]`, `[COST]`; anything else is
a plain log line. Python traceback shapes are promoted to error level. `[TOKENS]`/`[COST]` are
displayed only, never parsed.

Section progress is **not** taken from stdout. The API polls `out/structure_graph.json` once a
second and emits a `section` event for every node whose `content_file_path` becomes non-empty,
then uploads `sections/<key>.md` and `section_reviews/<key>*.json` for that node.

### 3.4 Files in `out/` the API reads or edits

| File | Fields the API depends on |
|---|---|
| `structure_graph.json` | `graph.input_sha256`; `nodes{key}.title/summary/n_pages/content_file_path/kb_scope/kb_sources/content_locked/structure_locked/content_file`; `edges` as `[parent, child]` rooted at `"book"`; keys `"1"`, `"1-2"`, ... in DFS order. The API **writes** into this file before regenerate/retry (clears `content_file_path`, rewrites `summary`, syncs scopes and locks). |
| `sections/<key>.md` | section body; word count and citation tokens `[cite_key]` are extracted from it |
| `section_reviews/<key>.json`, `<key>_revised.json` | `issues[] {severity, type, description, required_fix}` |
| `kb_sources.json` | `cite_keys{}` and `rids{}` mapping to `{source_path, loc, excerpt}`; `chunks[].source_path` (parent directory = source id, used for per-source chunk counts) |
| `run_meta.json` | `finished_at` (ISO, must be after the run started), `token_totals{}` and `cost_totals_usd{}` (values summed), `error` (failure text). `status` is ignored. |
| `regen_history/` | written by the API for rollback; the engine must not touch it |
| `logs/cli_stdout.log` | written by the API |

Artifact upload walks `out/` (skipping `.kb_cache/` and `*.bak`) and classifies `sections/*.md`,
`section_reviews/*.json`, `logs/*`, the known top-level JSON files, `*.bib`, `*.md`, `*.tex`,
`*.pdf`. The final book is found **by extension**, so its file name is free. The `**Author:**` line
of the final `.md` is rewritten by the API.

`llm_usage.jsonl`, `context_memory.json`, `agent_logs/` and `audit_report.json` are uploaded but
never parsed. Their formats are ours to change.

### 3.5 Run kinds and resume semantics

- **Full run**: fresh work dir, no `--resume`.
- **Retry**: same work dir, `--resume`, inputs re-rendered; must skip every leaf whose section file
  exists and whose `input_sha256` matches.
- **Regenerate one node**: same work dir, `--resume`, the API has deleted `sections/<key>.md`,
  cleared that node's `content_file_path`, and possibly appended `Writing instructions: ...` to its
  `summary`. The engine must regenerate exactly that leaf, with full context from its neighbours.
- **Export**: same work dir, `--resume --export-tex [--no-pdf]`, nothing deleted; the engine must
  generate nothing and only assemble LaTeX/PDF from existing sections.
- Resume is refused (and the outline regenerated) when `graph.input_sha256` differs from the current
  input hash. This guard is relied on by the API's drift checks; keep it.

## 4. Architecture of the new engine

### 4.1 Package and entrypoint

```
engine/                      new package (python -m engine)
  cli.py                     argparse; accepts the full contract surface plus new flags
  config.py                  RunConfig: argv + env resolved once, immutable, no globals
  events.py                  EventSink: contract stdout prefixes + structured out/events.jsonl
  spec/                      book_input.txt parser; pydantic models for book_structure.json
  graph/                     DocGraph (tree + node attrs), structure_graph.json reader/writer
  llm/                       async client, structured output, retries, usage ledger, pricing
  prompts/                   own prompt pack (rewritten) + strict typed renderer
  retrieval/                 extraction (with the existing content-hash cache), chunking,
                             BM25 index, scope filters, context formatting, kb_sources.json
  agents/                    typed Agent[In, Out]: outline, subdivide, writer, reviewer,
                             reviser, length, glossary, consistency
  pipeline/                  plan (task DAG), scheduler (asyncio), book stages, resume rules
  assemble/                  citations resolver, Markdown builder, pandoc -> LuaLaTeX, audit
run_engine.py                two-line shim so CLI_ENTRYPOINT can point at a file
```

`engine/` is the working name. When the old CLI is removed the package can take over the
`autogenbook` name and `main.py` becomes the shim (section 9).

### 4.2 Concurrency model

The core is `asyncio` with the `AsyncOpenAI` client. The pipeline builds an explicit **task DAG**
per run and a scheduler executes it under a global semaphore (`--concurrency N`, env
`AUTOGENBOOK_CONCURRENCY`, default 4) plus adaptive backoff: 429/503 responses halve the effective
concurrency for a cooldown window and it recovers gradually, instead of every worker sleeping and
retrying at once. The production provider is the e-INFRA CZ endpoint (section 4.3), which
publishes no rate limits, so the cluster default is set from the concurrency sweep in the
benchmark harness (section 6), not guessed.

Task types for book mode, in dependency order:

1. `kb.build` (CPU-bound, runs in a thread; extraction is per-file parallel).
2. `outline.generate` (only in TXT mode; the redundancy revision is folded into the same prompt
   and the result is a single structured object).
3. `subdivide(node)` for every node that needs it, level by level, siblings in parallel.
4. `glossary` (new): one call that reads the whole outline and produces the book-level
   terminology sheet, notation conventions, and audience/tone guide. This replaces the incremental
   context memory as the primary consistency mechanism and is available to every writer from the
   start.
5. `draft(leaf)`: writer with outline, glossary, sibling summaries, retrieved context. **No
   dependency on other leaves**, so all leaves run in parallel up to the concurrency limit.
6. `review(leaf)` then `revise(leaf)` then `length(leaf)`: per-leaf chain, still independent across
   leaves. Review and revision are one round by default; a second round only when the first revision
   still has a major issue.
7. `consistency` (new, sequential and cheap): reads section summaries, defined terms and citations
   from all leaves, flags duplicated coverage, contradicting definitions and dangling
   cross-references, and emits targeted patches for at most a configurable number of sections.
   This is where the old context-memory agent's value is recovered, at O(1) calls instead of O(N).
8. `assemble.markdown`, then optionally `assemble.latex` and `assemble.pdf`.

Each task persists its result the moment it finishes (section file, graph node update, review
JSON) and the graph file is written atomically. The scheduler is therefore checkpointed at task
granularity, which is what makes `--resume` and single-node regenerate correct by construction:
a resumed run rebuilds the DAG, marks tasks whose outputs exist as done, and only runs the rest.

A `--context-mode chained` option keeps the old behaviour (each leaf depends on the previous
leaf's text) so the benchmark can separate "better prompts" from "parallelism".

Expected effect: a forty-leaf book goes from ~200 sequential calls to roughly
`3 + ceil(40 / concurrency) * 3 + 2` sequential rounds, i.e. five to eight times faster
wall-clock at concurrency 4 with the same number of tokens, and fewer tokens once repair loops are
gone.

### 4.3 LLM client and structured output

- **Production provider: e-INFRA CZ** (`https://llm.ai.e-infra.cz/v1/`), an OpenAI-compatible
  Open WebUI gateway authenticated with a bearer key from `chat.ai.e-infra.cz`, hosting open models
  (gpt-oss-120b, Kimi K2.6, DeepSeek R1, Qwen 3 and others; list them via `/v1/models`). It
  publishes no rate limits or quotas and does not document structured-output support. OpenRouter
  and LM Studio remain supported through the same OpenAI-compatible client.
- One `AsyncOpenAI` client per run; base URL, key and model resolution keep the current env
  precedence (`AUTOGENBOOK_LLM_*` over `OPENROUTER_*`, `openai/gpt-5-mini` default, mini-model
  override).
- Every agent output is a pydantic model. The client asks for it with
  `response_format={"type": "json_schema", ...}` generated from the model; if the provider rejects
  that, it falls back to `json_object` mode; if that fails too, to prompt-only JSON. The chosen
  level is probed once per run and model and cached, so e-INFRA models that lack schema support do
  not pay a failed request per call. A single repair call is the last resort, and it is itemised in
  the usage ledger like any other call.
- Reasoning effort: `AUTOGENBOOK_LLM_REASONING_EFFORT` (`none`, `minimal`, `low`, `medium`, `high`,
  `xhigh`; unset by default) is sent as the OpenAI `reasoning_effort` field with every chat
  request. A model that rejects the field has it dropped for the rest of the run. On e-INFRA,
  gpt-oss-120b reasons by default (about 1,500 hidden tokens per call, reported in
  `reasoning_content` and not counted as reasoning tokens); `low` is the recommended setting.
- Cost: provider-reported cost when present; OpenRouter list prices only when the base URL is
  OpenRouter; otherwise cost is reported as unknown (null), never as a made-up number.
- Retries: transient errors only, exponential backoff with jitter, honouring `Retry-After`.
  Per-request timeout is configurable and defaults to 300 s as today.
- Streaming is supported by the client from day one so section text can be surfaced live later,
  but the first milestone does not depend on it.
- The usage ledger records **every** request (label, model, tokens, provider-reported cost or
  estimated cost) to `llm_usage.jsonl` and aggregates into `run_meta.json` with the contract keys.
  Prices come from the OpenRouter pricing endpoint with a cached fallback; no hardcoded rates.

### 4.4 Prompts

- A new prompt pack under `engine/prompts/<type>/`, written from scratch in our own words (see
  section 9 on licensing), one file per agent role, Markdown with a small YAML header naming its
  required placeholders.
- **All prompts are English; the output language follows the spec.** The writer is told the
  document language (detected from `book_input.txt`, overridable with `--language`) and every
  agent is instructed to keep it. Open models behave better on English instructions than on mixed
  Czech/English ones, and it keeps one prompt pack per document type.
- The renderer is strict: a missing or unknown placeholder is an error at load time, not a silent
  `{cite_key}` in the prompt. Global policy blocks are composed explicitly, not injected by magic.
- Prompt tests: every pack is loaded and rendered with sample inputs in the unit suite (replacing
  `smoke_prompts`).

### 4.5 Retrieval

Retrieval is where the new engine gains the most quality. The current KB collapses whitespace and
cuts fixed 1800-character windows (mid-sentence, across page breaks, headers and footers in every
chunk), extracts PDFs with `pypdf`, tokenises without lemmatisation (Czech inflection splits one
concept into many BM25 terms) and is lexical only, so a Czech section query against English sources
shares almost no tokens. That last case is the project's main real use.

Decided design, all behind a `Retriever` protocol:

- **Extraction**: `pypdfium2` for PDF text with block information, `pdfplumber` for tables (kept
  whole), running headers/footers removed, line-break hyphenation repaired; OCR knobs unchanged.
  PyMuPDF is not used (AGPL). Extraction reuses the existing content-hash cache directory so a
  warm `KB_EXTRACT_CACHE_DIR` stays warm.
- **Chunking**: paragraph and sentence boundaries to a token budget (default 400 tokens), never
  inside a sentence, heading path prefixed to the indexed text. Small-to-big: the retrieval unit is
  the chunk, the context handed to agents is the enclosing paragraph or section up to the budget.
- **Lexical**: `bm25s` over `simplemma`-lemmatised, accent-insensitive tokens.
- **Dense**: multilingual embeddings from the OpenAI-compatible `/v1/embeddings` endpoint. e-INFRA
  serves `qwen3-embedding-4b`, `multilingual-e5-large-instruct`, `nomic-embed-text-v2-moe`,
  `nomic-embed-text-v1.5` and `mxbai-embed-large` on vLLM. Default is `qwen3-embedding-4b`
  (strongest multilingual, 32k context, instruction-aware); the e5 and nomic-v2 models are
  benchmarked as alternatives, the two English-centric ones are not defaults. A local
  `multilingual-e5-small` is the fallback without an endpoint. Vectors are cached per content hash
  and model; brute-force cosine in NumPy, no vector database.
- **Fusion and reranking**: reciprocal rank fusion of both top-30 lists, then e-INFRA's
  `qwen3-reranker-4b` through vLLM's rerank or score endpoint (whichever the gateway proxies),
  down to `k` (default 6); listwise LLM reranking with the mini model is the fallback. The gateway
  serves the Qwen3 reranker as a bare classifier, so the client applies the model's own
  `<Instruct>/<Query>/<Document>` template (without it the reranker scored below fused order on
  every benchmark set; with it, above). Source diversification and the 6000-char context cap stay.
- **Queries**: the per-section query drops the book summary; the pipeline supplies one to three
  focused queries (section summary, glossary terms, writer/reviewer-generated queries) whose results
  are fused.
- **Unchanged observable outputs**: `rid`/`cite_key` naming, `kb_sources.json` shape,
  `kb_scope`/`kb_sources` inheritance, the `[<rid>] ... cite_key="..."` context block format, and
  the per-fingerprint index persisted under `out/.kb_cache/`.
- Web retrieval (Tavily) is a second `Retriever`; the MCP gateway is dropped.
- **Evaluation**: `scripts/bench_retrieval.py` reports recall@6 and MRR per retriever on generated
  question sets per benchmark KB, including Czech questions against English sources. Hybrid plus
  rerank must beat the old KB on every set before phase 3 merges.

### 4.6 Citations and assembly

- Section Markdown uses **`[cite_key]`** as the inline citation marker. That is proper Markdown,
  it is what `graph_import.py` already parses, and it fixes the silent import bug in section 2.
  For compatibility the resolver also accepts `\cite{...}` and `\footnote{Source: RID:...}`.
- One citation resolver serves both outputs: the final Markdown gets numbered references and a
  bibliography section; the LaTeX path gets the same numbering. Unknown keys are reported as audit
  findings, never silently dropped.
- LaTeX is produced by pandoc from the Markdown with our own template, then compiled with
  LuaLaTeX. `pylatex` and `latex2markdown` are not used.
- The audit (unknown citations, missing figures, unsupported numeric claims) runs on the Markdown
  and writes `audit_report.json`; strict mode blocks PDF emission exactly as today.
- **The outline is the only structure.** Section bodies carry no headings of their own: the
  writer and reviser prompts say so, and `normalize_body` rewrites whatever a model
  still emits (`#` headings, standalone `**Title**` / `***Title***` lines, setext headings,
  `---` rules) into one canonical form: a run-in bold lead-in ending with a period at the start
  of the paragraph it introduces (`**Resource integration.** Value emerges ...`; `.:!?` already
  present is kept, a period is added otherwise; before a list, equation, table or code block the
  lead-in stays a paragraph of its own; rules are dropped). It runs both when the draft is
  cleaned and again at assembly, so the app's outline, the Markdown and the PDF table of
  contents always show the same hierarchy. `--body-headings` (env `AUTOGENBOOK_BODY_HEADINGS=1`)
  restores sub-headings, shifted one level below the node heading and capped at `######`.
  Slides keep the older ATX-only rule (`lead_ins=False`): headings become standalone `**label**`
  lines and `slide_body` drops rules.

### 4.7 Events

The stdout prefixes in 3.3 are produced by one `EventSink`, so the protocol lives in one file.
The same sink writes `out/events.jsonl` with structured records (`ts, stage, level, node_key,
message, payload`) that the API can adopt later to replace stdout parsing and graph polling.

### 4.8 Configuration and interactivity

All settings resolve once into an immutable `RunConfig` from argv and env. There is no `input()`
anywhere; `AUTOGENBOOK_NONINTERACTIVE` and `AUTOGENBOOK_ASSUME_YES` are accepted and ignored.

## 5. Testing strategy

- **Unit tests** (`tests/engine/`, pytest, no network): spec parsing, graph keys and DFS order,
  DAG construction and resume marking, scope resolution, chunking, citation resolution, event
  formatting, prompt rendering.
- **Fake LLM**: a deterministic in-process LLM that returns schema-valid objects from fixtures and
  records calls. Every pipeline test runs against it, so the whole book pipeline is exercised in
  CI in seconds.
- **Contract tests**: run the engine end to end with the fake LLM into a temp work dir and assert
  the file set, JSON fields and stdout prefixes of section 3, for each run kind (full, retry,
  regenerate, export, markdown/latex/pdf). These are the tests that let the API switch engines
  without its own suite noticing. `tests/api/fake_cli.py` stays as the API's own fixture.
- **Golden runs**: a small real book input plus a two-file KB, run with a recorded-response LLM,
  compared against committed outputs to catch accidental prompt or assembly drift.

## 6. Benchmark harness (first deliverable)

**Switch bar (decided):** the new engine must be *not worse in quality* on the benchmark books,
meaning a blind pairwise judge win rate not significantly below 50% and no regression on the
deterministic metrics, with zero contract-test failures and a green API end-to-end suite. Speed is
the expected bonus, not a gate.

`scripts/bench_engines.py` runs both engines on the same input, KB and model, and writes a
comparison table:

- Wall-clock time, number of LLM requests, prompt/completion tokens, cost.
- Deterministic quality metrics: page-budget adherence per section, share of citation tokens that
  resolve, unknown-citation count, duplicated-paragraph rate across sections, heading structure
  matching the outline.
- LLM-as-judge rubric (pairwise, blind, both orders) on a sample of sections: grounding,
  coherence with neighbours, pedagogy, adherence to the section summary.

Benchmark inputs: `input/book/book_input.txt` (Czech, explicit outline) plus one English
TXT-only spec. The new engine runs a **concurrency sweep** (1, 2, 4, 8) against e-INFRA to
record throughput and error rate per level; the cluster default is taken from that table. The
harness is written before the engine so parity can be measured from the first end-to-end run.

## 7. Phases

Each phase is one sub-issue of the epic and one or more PRs against `seslab-muni/AutoGenBook`;
no phase changes `api/` or `app/`.

1. **Harness and contract**: `scripts/bench_engines.py`, `tests/engine/` skeleton with the fake
   LLM and the contract test list (initially skipped).
2. **Core**: `engine/{config,events,spec,graph,llm,prompts}` with unit tests. The CLI parses the
   full contract and can run `--export-tex` on an existing work dir (assembly only), which
   already exercises graph reading, citation resolution and pandoc.
3. **Retrieval**: structure-aware extraction and chunking, lemmatised BM25 plus e-INFRA embeddings
   with reranking, scopes, `kb_sources.json`; must beat the old KB on the retrieval eval.
4. **Book pipeline**: outline, subdivide, glossary, draft, review/revise, length, consistency,
   scheduler, resume rules. Contract tests go green. First benchmark run.
5. **Parity and switch**: fix gaps found by the benchmark; concurrency sweep on e-INFRA; run the
   API's e2e suite against the new engine via `CLI_ENTRYPOINT=run_engine.py`; deploy to the
   cluster with the new entrypoint (one config change, instant rollback by reverting it).
6. **Paper type** (section 8).
7. **Presentation type** (section 8).
8. **Cleanup**: delete the old engine, rename the package, update `README.md` and `docs/`,
   detach the fork (section 9). Only after phases 6 and 7 are merged, so there is no period
   without paper or presentation generation.

## 8. Paper and presentation types

Decided: the engine keeps **three document types, book, paper and presentation**, because each
has a genuinely different structure. Scientist, proposal and reviewer are dropped. The core is
type-agnostic by construction (spec, graph, scheduler, agents, assembly), so a type is a spec
parser, a prompt pack, a stage list and an assembler.

**Paper.** Academic structure (abstract, introduction, related work, method, results, discussion,
conclusion) with a BibTeX bibliography and a `--citation-style` option, produced through the same
graph and scheduler as book. Citations are **KB first**: by default every reference comes from
the uploaded sources. `--enable-web-rag` adds web hits (Tavily) only for items whose DOI or URL
resolves at generation time; unverified references are never emitted. The related-work section
is built from those verified items.

**Presentation.** Full parity with the current mode: slide deck as structured Markdown, exported
to **PPTX and Beamer PDF**, plus **narration text per slide and TTS audio** (OpenRouter TTS model
or local Coqui XTTS/VITS as today). Slides are leaves in the graph, so drafting is parallel like
book sections; narration is a per-slide task that depends on the slide, and TTS a task that
depends on the narration. Media generation runs in a thread pool, not on the LLM semaphore.

API and frontend support for paper and presentation is out of scope for this epic and gets its
own issues once the CLI types exist.

## 9. Removing the old CLI and detaching the fork

Order of operations, after phase 5 is deployed and stable:

1. Delete `main.py`, `book_builder.py`, `rag_kb.py`, `mcp_gateway.py`, `openrouter_llm.py`,
   `autogenbook/`, `prompts/`, `src/autogenbook/`, the old `tests/test_*.py`, and the old smoke
   modules. Trim `requirements.txt` (drop `pylatex`, `latex2markdown`, `networkx`, `matplotlib`,
   `pandas`, `scikit-learn` unless a ported mode needs them).
2. Rename `engine/` to `autogenbook/` and make `main.py` the shim so `CLI_ENTRYPOINT` can return
   to its default.
3. Licensing: upstream is Apache 2.0 and `LICENSE` already exists in the repo. A clean-room rewrite
   with its own prompts owes upstream nothing beyond that. Add a short `NOTICE` file stating that
   the project originated as a fork of `pkonas/AutoGenBook` (Apache 2.0) and keep it after the code
   is gone; git history retains the original commit, which is fine.
4. Detach on GitHub: repository Settings, Danger Zone, "Leave fork network". This is irreversible
   and keeps history, issues and pull requests. Then `git remote remove upstream` locally. Do this
   last, so the upstream remote stays available for reference until nothing depends on it.

## 10. Decisions log

Settled in the September 2026 review:

| Topic | Decision |
|---|---|
| Package name | `engine/` during side-by-side; renamed to `autogenbook/` at cleanup |
| Document types | book, paper, presentation; scientist/proposal/reviewer dropped |
| Presentation outputs | full parity: Markdown slides, PPTX, Beamer PDF, narration, TTS |
| Paper citations | KB first; web opt-in with DOI/URL verification; no unverified references |
| Consistency pass | patches at most three sections automatically, reports the rest |
| Concurrency | default 4 with adaptive backoff; cluster value from the e-INFRA sweep |
| Provider | e-INFRA CZ endpoint in production; OpenRouter and LM Studio still supported |
| Prompt language | English prompts; output language follows the spec |
| Switch bar | not worse in quality (blind judge, deterministic metrics), contract and e2e green; speed is a bonus |
| Deleting the old CLI | only after book, paper and presentation all run on the new engine |
| API scope | `api/` and `app/` frozen until the switch; `events.jsonl` and streaming adopted afterwards |
| Retrieval | hybrid from the start: lemmatised BM25 + e-INFRA `qwen3-embedding-4b` + e-INFRA `qwen3-reranker-4b`; structure-aware chunking; no PyMuPDF |
| Python | 3.12, matching the Docker image |

## Appendix A. Running the tests and benchmarks locally

Everything below runs from a fresh clone on Linux or macOS with Python 3.12. Commands are run
from the repository root unless a step says otherwise.

### A.1 Clone and virtualenv

```bash
git clone https://github.com/seslab-muni/AutoGenBook.git
cd AutoGenBook
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt -r api/requirements-dev.txt   # engine, old CLI, API and pytest
```

Optional system tools. Tests that need a missing tool skip cleanly instead of failing:

- `pandoc` for the LaTeX, Beamer and paper `.tex` tests.
- `lualatex` and `bibtex` for the PDF tests. On Debian/Ubuntu, install `texlive-luatex`, `texlive-latex-extra`, `texlive-lang-czechslovak` and `texlive-bibtex-extra`.

Optional Python extras are imported only when used (`pip install '.[local-embeddings]'`,
`pip install '.[tts-local]'`).

### A.2 Test suites

```bash
pytest tests/engine                              # engine: contract, golden, unit tests; fake LLM, no network
pytest tests/engine --bench -m bench             # benchmark harness checks and retrieval evals only (off by default)
python -m unittest discover -s tests -p "test_*.py"   # the old CLI's suite (unchanged)
AUTH_JWT_SECRET="$(openssl rand -hex 32)" pytest tests/api   # the API's suite (uses tests/api/fake_cli.py)
python -m autogenbook.smoke_prompts              # old prompt packs
```

`tests/engine/test_contract_*` is the frozen contract of section 3: argv, stdout, `structure_graph.json`, sections, reviews, `kb_sources.json`, `run_meta.json` and run kinds, for book, paper and presentation.

The golden runs (`test_golden_{book,paper,presentation}.py`) replay recorded LLM replies. After an intentional prompt or assembly change, re-record them with `ENGINE_UPDATE_GOLDEN=1 pytest tests/engine/test_golden_*.py`.

`ENGINE_TEST_COQUI=1` enables the single test that loads a real Coqui model. It is off by default because loading a model may download it.

Tests marked `bench` (`test_bench_scripts.py`, the "new BM25 is not worse than the old KB" eval in
`test_retrieval.py`) are measurement, not regression checks: `pytest tests/engine` deselects them
so the CI job stays inside its 15-minute limit. `--bench` includes them, `--bench -m bench` runs
only them. **Benchmarks are run locally only**, by hand, when a change is to be measured: the
`bench` tests with `--bench`, and `scripts/bench_engines.py` / `scripts/bench_retrieval.py` as in
sections A.3 and A.4. There is no CI job for them, by design.

### A.3 Retrieval benchmark: old KB vs new hybrid (e-INFRA)

```bash
export AUTOGENBOOK_LLM_BASE_URL=https://llm.ai.e-infra.cz/v1/
export AUTOGENBOOK_LLM_API_KEY=...            # your e-INFRA CZ API token
unset OPENROUTER_API_KEY                      # it takes precedence over AUTOGENBOOK_LLM_API_KEY (API rule)
# Embedding/reranker models default to qwen3-embedding-4b / qwen3-reranker-4b on the same
# endpoint; override with AUTOGENBOOK_EMBED_MODEL / AUTOGENBOOK_RERANK_MODEL if the names differ
# (curl -s -H "Authorization: Bearer $AUTOGENBOOK_LLM_API_KEY" "$AUTOGENBOOK_LLM_BASE_URL"models).
# hybrid-llmrerank additionally needs a chat model: export AUTOGENBOOK_LLM_MINI_MODEL=<model id>

python scripts/bench_retrieval.py --retriever old,bm25-plain,bm25-lemma,dense,hybrid,hybrid-rerank --k 6   # = --retriever all
python scripts/bench_retrieval.py --retriever hybrid-llmrerank,dense:local --k 6   # LLM listwise rerank; local e5 (needs the extra)
```

Both benchmark KBs (`input/bench/cs_book`, `input/bench/en_book`) and both question languages run by default. The script writes a Markdown table of recall@1/3/k, MRR and cold/warm build time, plus JSON, under `output/bench/retrieval-<timestamp>/`.

Reranked rows are strict: if the reranker is unavailable or fails, the row is reported under "Failed runs" and the script exits 1, instead of silently reporting fused-order numbers.

`--fake-llm` proves the script works without a key, but its dense and rerank numbers are meaningless.

### A.4 Engine benchmark: old vs new at concurrency 1 and 4, and the sweep

Both engines see the same environment. Set the endpoint as in A.3, then:

```bash
export AUTOGENBOOK_LLM_MODEL=...          # chat model id on the endpoint (same for both engines)
export AUTOGENBOOK_LLM_MINI_MODEL=...     # smaller model for reference formatting and the fallback reranker
export AUTOGENBOOK_LLM_REASONING_EFFORT=low   # optional; sent by the new engine only
export AUTOGENBOOK_JUDGE_MODEL=...        # judge model (or --judge-model); use another family than the writer

# Old (sequential) vs new at concurrency 1 and 4, with the blind pairwise judge (both orders)
python scripts/bench_engines.py --compare --input input/bench/en_book --concurrency 1,4 --judge
python scripts/bench_engines.py --compare --input input/bench/cs_book --concurrency 1,4 --judge

# Concurrency sweep of the new engine: throughput, errors and 429s per level
python scripts/bench_engines.py --engine new --input input/bench/en_book --sweep 1,2,4,8

# Paper and presentation types
python scripts/bench_engines.py --compare --input input/bench/en_paper --concurrency 1,4 --judge
python scripts/bench_engines.py --compare --input input/bench/en_presentation --concurrency 1,4

# Reuse an old-engine run instead of repeating it (it is the slow one)
python scripts/bench_engines.py --compare --old-run output/bench/<ts>/old --input input/bench/en_book --concurrency 4 --judge
```

Every run starts through the API's own `build_command` and `subprocess_runner`. The script writes `report.md`, `report.json`, every work dir and every stdout log under `output/bench/<timestamp>/`.

Append `--fake-llm` to any command to smoke-test the harness without a key. Those numbers are **fake-LLM smoke numbers**: timings, token counts and quality metrics measure the harness, not a model.

### A.5 API end to end against the new engine

The switch is a single setting: `CLI_ENTRYPOINT=run_engine.py` for the `api` and `worker` services (`docker-compose.engine.yml`). To exercise the web stack with the deterministic fake LLM, with no key and no network, add `docker-compose.engine-fake.yml`:

```bash
cp .env.example .env
echo "AUTH_JWT_SECRET=$(openssl rand -hex 32)" >> .env
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.engine.yml -f docker-compose.engine-fake.yml"
$COMPOSE up -d --wait --build
$COMPOSE exec -T -e AUTOGENBOOK_USER_PASSWORD='E2ePassw0rd!' api \
  python -m api.scripts.users create --email e2e@example.com --name "E2E User"

AUTH_JWT_SECRET="$(openssl rand -hex 32)" pytest tests/api   # API suite (host venv from A.1)
pytest tests/engine/test_contract_api_e2e.py                 # API adapter -> run_engine.py, no Docker

cd app
pnpm install
pnpm exec playwright install --with-deps chromium   # once per machine
pnpm e2e                                            # Playwright smoke + a11y against http://127.0.0.1:8080
```

To run the stack against a real endpoint instead, drop `docker-compose.engine-fake.yml` and set `AUTOGENBOOK_LLM_BASE_URL`, `AUTOGENBOOK_LLM_API_KEY` and `AUTOGENBOOK_LLM_MODEL` in `.env`. Rolling back means removing `docker-compose.engine.yml`, so the services run `main.py` again.

## Appendix B. Contract notes from the implementation

These are places where section 3 and the current API code disagree or are silent. Where they disagree, the engine follows the API code.

- **API key precedence.** `OPENROUTER_API_KEY` wins over `AUTOGENBOOK_LLM_API_KEY` when both are set (`api/core/settings.py`, and the old client). Unset the OpenRouter key when targeting another endpoint.
- **Citation tokens.** Section files store one `[cite_key]` bracket per key (`[a] [b]`). The API's importer (`graph_import._CITATION_TOKEN_RE`) only reads single-key brackets. `\cite{}`, `\footnote{Source: ...}` and `[a; b]` written by a model are rewritten outside code; the final document renders adjacent markers as `[1, 2]`.
- **Writing instructions.** The API strips only a trailing `\n\nWriting instructions: ...` paragraph. TXT outline bullets (`- Writing instructions: ...`) are therefore moved into that shape when the spec is parsed.
- **Resume.** Refused when `input_sha256`, `input_path` or `doc_type` differ. A refused resume regenerates the outline from the TXT, unless `--use-json`, when the content changed or cannot be proven unchanged. A graph without a stored hash is accepted and stamped, as `tests/api/fake_cli.py` does. A graph this engine saved before subdivision finished (`subdivision_complete: false`) is subdivided on resume.
- **`run_meta.json` `run_kind`.** The values are `full`, `resume` and `export` (informational; the API keeps its own kind).
- **Engine state.** Engine state lives under `out/.kb_cache/engine/`, which the API does not upload. A full run clears it along with stale section and review files, keeping content-lock sources.
- **Web references.** Cited web references are added to `kb_sources.json` `cite_keys`/`rids` (never `chunks`), with extra `kind`/`title`/`url`/`doi` fields that the API ignores.
- **Graph root.** The root is `book` for every document type. The old presentation mode used `presentation`, and its slides lived in `slides/<key>.md`; here slides are `sections/<key>.md`.
- **Strict audit.** It exits 4 whenever it finds errors, including Markdown-only runs.
- **PDF output.** A PDF produced by a nonstop LuaLaTeX run with errors is kept, and the errors are reported as `[WARN]`. Failing explicitly requested LaTeX (`--export-tex`, `--presentation-tex`) fails the run; a paper's default `.tex` failing under `--no-pdf` is only a warning.
- **`kb_sources.json` `page_keys`.** These stay path-dependent, as in the old engine.
- **Engine-only settings.** `AUTOGENBOOK_CONCURRENCY`, `AUTOGENBOOK_LLM_REASONING_EFFORT`, `AUTOGENBOOK_EMBED_*`, `AUTOGENBOOK_RERANK_*`, `AUTOGENBOOK_DENSE` and `AUTOGENBOOK_TTS_*` are not on the API's environment allow-list. Under the web stack the engine uses its defaults: concurrency 4, no reasoning effort sent (the model's own default), and embeddings and reranking on the LLM base URL with the e-INFRA model names. Setting a reasoning effort for web runs needs `AUTOGENBOOK_LLM_REASONING_EFFORT` added to `ENV_ALLOWLIST` in `api/infrastructure/cli/book_command.py`, which is part of the switch (phase 5), not of this PR.
- **Flags not ported.** `--presentation-video`, `--presentation-image-model`, `--no-image` and `--presentation-citations` (slide images and video) are rejected with exit 2. `--paper-input` is new, and `-i` still works for every mode.
