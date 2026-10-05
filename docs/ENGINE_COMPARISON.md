# Old engine vs new engine: differences and measured results

Status: measured on 27 September 2026 on branch `feat/158-engine-rewrite` (commit `4877035` plus the
reranker fix described in section 5.3). Companion to `docs/ENGINE_REWRITE.md` (the design and plan);
this file records what is different and what was actually measured, so the numbers can be quoted.

All LLM, embedding and reranking calls went to the e-INFRA CZ gateway
(`https://llm.ai.e-infra.cz/v1/`). Nothing here is a fake-LLM smoke number; the fake-LLM figures in
the PR description of #159 are superseded by this file.

## 1. Summary

| Question | Answer | Evidence |
|---|---|---|
| Is the new engine faster? | Yes: 1.6 to 2.3 times faster wall-clock on the English benchmark book at concurrency 4 over three runs, despite the endpoint throttling every run | section 6 |
| Is it better? | Yes on this book: two blind pairwise judges from different model families preferred the new engine in 23 of 24 (gpt-oss-120b) and 24 of 24 (kimi-k3, on two further runs) judgements; sections are on average 9 to 18% over their length budget versus 94% | section 6 |
| Is retrieval better? | Yes: hybrid BM25 + embeddings + reranker reaches recall@6 of 1.00 on all four question sets; the old KB is at 0.51 to 0.57 on the Czech-question sets | section 5 |
| Is the rewrite complete? | No: phases 1 to 4, 6 and 7 of the plan are implemented and tested; phase 5 (parity on all inputs, concurrency sweep, cluster switch) is partly done by this measurement; phase 8 (delete the old engine) has not started | section 8 |

## 2. What is different

### 2.1 Scope and size

| | Old engine | New engine |
|---|---|---|
| Location | `main.py`, `book_builder.py`, `rag_kb.py`, `openrouter_llm.py`, `utils.py`, `prompts.py`, `mcp_gateway.py`, `autogenbook/` | `engine/`, entrypoint `run_engine.py` |
| Document types | book, paper, presentation, proposal, reviewer, scientist | book, paper, presentation (the other three are dropped; the old CLI stays on a git tag) |
| Python source | 26,139 lines in 110 files | 10,565 lines in 65 files |
| Prompt files | 104 Markdown files in 6 mode packs, Czech/English mixed, `_md` variants per output path | 24 files in 3 type packs plus `common`, all English, output language is a rendered variable |
| Tests | `python -m unittest` suite (123 tests) | `pytest tests/engine`: 25 files, 5,328 lines, 240 tests, including contract tests against the API's own command builder and process runner |
| Origin | fork of `pkonas/AutoGenBook` | written from scratch, own prompts |
| Interface | CLI only | typed async API `engine.run(config, sink) -> RunResult`; the CLI is a thin adapter |
| External contract | argv, stdout prefixes, `structure_graph.json`, `sections/*.md`, `kb_sources.json`, `run_meta.json` | identical; the web stack switches with one setting, `CLI_ENTRYPOINT=run_engine.py` (`docker-compose.engine.yml`); `api/`, `app/` and `k8s/` are untouched |

### 2.2 Execution model

| | Old engine | New engine |
|---|---|---|
| Concurrency | none; every LLM call is sequential (`book_builder.py:generate_contents`) | `asyncio` task DAG with a scheduler under a global semaphore (`--concurrency`, default 4) |
| Per-section chain | writer, reviewer, reviser, reviewer again, up to two length passes, context-memory agent: 4 to 7 calls per section, each waiting for the previous section | draft, review, revise, length per leaf; leaves are independent, so all drafts run in parallel up to the limit |
| Cross-section consistency | incremental context memory updated after every section (O(N) sequential calls) | one glossary call before drafting (terms, notation, tone) plus one consistency pass at the end that patches at most 3 sections (O(1)) |
| Rate limiting | fixed retry loop, 300 s timeout | transient-only retries honouring `Retry-After`; 429/503 halves the effective concurrency and it recovers gradually (observed in the benchmark: "concurrency 4 -> 2") |
| Checkpointing | section files; resume rebuilds state ad hoc, and the first regenerated section sees no previous text | every task persists its result on completion, the graph is written atomically; resume rebuilds the DAG and skips tasks whose outputs exist |
| Interactivity | several `input()` calls; the API works around them with environment flags | none |

### 2.3 LLM client and structured output

| | Old engine | New engine |
|---|---|---|
| Client | synchronous `openai` SDK | `AsyncOpenAI`, one client per run, streaming-capable |
| JSON output | scraped from free text; up to 3 parse attempts plus 2 schema-repair LLM calls per agent call | `json_schema` response format from the pydantic model, falling back to `json_object`, then prompt-only JSON; the working level is probed once per model and cached; one itemised repair call at most |
| Usage accounting | only the last call of each agent run is recorded | every request is recorded in `llm_usage.jsonl` (label, model, tokens, cost) and aggregated into `run_meta.json` |
| Cost | token prices hardcoded in `main.py` at import time | provider-reported cost, else OpenRouter list price when the base URL is OpenRouter, else `null` (never invented) |
| Prompt rendering | process-global registry; unknown `{placeholders}` are silently left in the prompt | strict renderer with a YAML header per prompt; a missing or unknown placeholder is a load-time error |
| Reviser input | the review as a Python `repr()` of a dict | typed JSON |

### 2.4 Retrieval

| | Old engine (`rag_kb.py`) | New engine (`engine/retrieval/`) |
|---|---|---|
| PDF extraction | pypdf | pypdfium2 plus pdfplumber tables, header/footer removal, dehyphenation, shared content-hash cache; per-file parallel |
| Chunking | fixed 1,800-character windows | sentence/paragraph chunks with heading paths (about 400 tokens) |
| Lexical index | `rank_bm25` over accent-folded tokens | `bm25s` over `simplemma` lemmas, with guards so Czech questions still match English sources (acronyms are not lemmatised; non-English words keep their surface form next to the lemma) |
| Dense retrieval | none | `/v1/embeddings` (`qwen3-embedding-4b`, 2,560 dimensions) or local `multilingual-e5-small`; vectors cached per document content and model |
| Fusion | n/a | reciprocal rank fusion of the top-30 lexical and dense lists |
| Reranking | none | `qwen3-reranker-4b` through `/v1/rerank` (or `/v1/score`), with a listwise LLM reranker as fallback |
| Context | 6,000-character cap, source diversification | same cap and diversification, small-to-big excerpts, identical `[RID:...] cite_key="..."` block format |

### 2.5 Citations and assembly

| | Old engine | New engine |
|---|---|---|
| Markdown output | leaves `\cite{...}` and `\footnote{Source: ...}` raw; bibliography only on the LaTeX path | one citation resolver for every output; adjacent markers render as `[1, 2]` |
| API citation import | the writer prompt asks for `\cite{key}` but the API's importer matches `[key]`, so the import silently finds nothing | section files store `[key]` brackets, one per key, which the API's importer reads |
| LaTeX/PDF | LaTeX-first legacy path or pandoc conversion | pandoc templates and a LuaLaTeX build in a temporary directory; audit |
| Paper references | web references may be unverified | KB first; web references only after their DOI or URL resolves; rejected ones recorded in `related_work.json` |
| Presentation | slides in `slides/`; image and video generation | slides are graph leaves in `sections/`; PPTX with narration as speaker notes, Beamer, narration JSON/MD, per-slide TTS, combined track and SRT; slide image and video flags are not ported (exit 2) |

## 3. Environment used for the measurements

| Item | Value |
|---|---|
| Endpoint | e-INFRA CZ, `https://llm.ai.e-infra.cz/v1/`, bearer key |
| Chat models available | agentic, all-proxy-models, auto-llm, auto-llm-heuristic, coder, command-a, deepseek, deepseek-thinking, deepseek-v4.1-flash, deepseek-v4.1-flash-thinking, gemma4, glm, glm-5, glm-5.3, gpt-oss-120b, kimi, kimi-k3, mini, mistral-medium-3.5, nrp, qwen3.5, qwen3.5-int4, qwen3.8-27b, qwen3.8-flash-next, thinker |
| Embedding models available | qwen3-embedding-4b, multilingual-e5-large-instruct, nomic-embed-text-v2-moe, nomic-embed-text-v1.5, mxbai-embed-large:latest |
| Reranker | qwen3-reranker-4b via `POST /v1/rerank` (Cohere/Jina style); `POST /v1/score` answers 404 |
| Other | whisper-large-v3 |
| Rate limit | undocumented; 4 parallel rerank requests produced HTTP 429, sequential requests never did |
| Machine | Linux workstation, Python 3.12.14 in `.venv`, no pandoc or LuaLaTeX installed |

Generation speed measured with one 250-word prompt (`max_tokens` 800) per model, single request:

| Model | Wall | Completion tokens | of which reasoning | Tokens/s |
|---|---:|---:|---:|---:|
| gpt-oss-120b | 8.6 s | 800 | 0 | 93 |
| qwen3.8-flash-next | 8.2 s | 800 | 801 | 97 |
| glm-5.3 | 14.5 s | 469 | 87 | 32 |
| gemma4 | 44.0 s | 413 | 0 | 9 |
| deepseek-v4.1-flash | 58.1 s | 800 | 800 | 14 |

Behaviour on an engine-style request (one Czech paragraph of about 120 words, `json_schema`
response format, `max_tokens` 1,500 to 3,000), one request per model:

| Model | json_schema result | Wall | Completion tokens | Notes |
|---|---|---:|---:|---|
| gpt-oss-120b, default effort | valid | 9.5 s | 1,802 | reasons about 1,500 tokens per call; the gateway returns them in `reasoning_content` and reports 0 reasoning tokens |
| gpt-oss-120b, `reasoning_effort=low` | valid | 1.5 s | 261 | |
| glm-5.3 | valid | 12.0 s | 350 | 16 reasoning tokens |
| mistral-medium-3.5 | valid | 14.6 s | 244 | no reasoning |
| kimi-k3 | valid | 38.0 s | 1,435 | 999 reasoning tokens; 12.9 s with `enable_thinking=false` |
| gemma4 | valid | 17.9 s | 264 | |
| command-a | valid | 33.2 s | 271 | |
| qwen3.8-27b | valid only with `enable_thinking=false` (2.9 s, 318 tokens) | | | otherwise the whole budget goes to reasoning and the content is empty |
| qwen3.5, qwen3.8-flash-next | empty content, `finish_reason=length` | | | unusable as served |
| deepseek-v4.1-flash, deepseek-thinking | HTTP 500 from the vLLM backend | | | |

This matters for any comparison: a first attempt at the engine benchmark on deepseek-v4.1-flash
(a thinking model on this gateway, two thirds of every reply spent on reasoning) took 2 hours to
produce 3 of 18 sections with the old engine (22 calls, 2.5 to 4.5 minutes each) and was stopped.
The reported runs use gpt-oss-120b for both engines.

## 4. Benchmark inputs

`input/bench/` (committed):

| Input | Content | Question sets |
|---|---|---|
| `en_book` | English spec "How Computers Came to Be", 12 pages, 4 English source documents (Markdown and PDF) | 44 English, 44 Czech |
| `cs_book` | Czech spec, same kind of English sources | 41 English, 41 Czech |
| `en_paper`, `en_presentation` | paper and presentation specs | not measured yet |

Retrieval questions are generated once with an LLM and stored in `questions.json`; each has an
answer span. An item counts as relevant when the excerpt an agent would see (at most 1,500
characters) contains the answer span, compared case-, accent-, whitespace- and
hyphenation-insensitively. The Czech sets over English sources are the project's main
cross-lingual case.

## 5. Retrieval benchmark

Command: `python scripts/bench_retrieval.py --retriever all --k 6`, then
`--retriever hybrid-rerank,hybrid-llmrerank` after the reranker fix. Reports:
`output/bench/retrieval-20260927T064314Z/` and `output/bench/retrieval-20260927T065920Z/`.

### 5.1 Results (recall@6 / MRR@6)

| KB / questions | old KB | bm25-plain¹ | bm25-lemma | dense | hybrid | hybrid-rerank² | hybrid-llmrerank³ |
|---|---:|---:|---:|---:|---:|---:|---:|
| cs_book / en (41) | 0.927 / 0.911 | 1.000 / 0.988 | 1.000 / 0.988 | 1.000 / 0.988 | 1.000 / 0.988 | **1.000 / 0.972** | 0.976 / 0.947 |
| cs_book / cs (41) | 0.512 / 0.363 | 0.415 / 0.298 | 0.537 / 0.391 | 1.000 / 0.919 | 0.902 / 0.750 | **1.000 / 0.963** | 0.976 / 0.932 |
| en_book / en (44) | 0.977 / 0.913 | 1.000 / 0.973 | 1.000 / 0.977 | 1.000 / 0.989 | 1.000 / 0.977 | **1.000 / 0.955** | 1.000 / 0.936 |
| en_book / cs (44) | 0.568 / 0.508 | 0.614 / 0.530 | 0.636 / 0.564 | 1.000 / 0.962 | 1.000 / 0.977 | **1.000 / 0.966** | 1.000 / 0.924 |

¹ new chunking with the old tokeniser, to isolate the effect of chunking.
² qwen3-reranker-4b with the instruction template (section 5.3).
³ listwise reranking by deepseek-v4.1-flash; needs a chat model.

Recall@1 for hybrid-rerank: 0.951, 0.951, 0.909, 0.932 (same row order). For the old KB: 0.902,
0.268, 0.864, 0.477.

Query latency per question (sequential, remote calls included): old KB and BM25 under 0.05 s;
dense about 0.1 s; hybrid about 0.1 s; hybrid-rerank 0.5 to 0.8 s; hybrid-llmrerank 15 to 29 s.
Index build (cold extraction): old 0.03 to 0.16 s; new 0.3 to 1.8 s including embedding the
corpus once (vectors are cached afterwards).

### 5.2 Findings

- **Chunking alone** (bm25-plain vs old) lifts the same-language sets to recall 1.0. On the
  Czech-question sets lexical search stays at 0.4 to 0.6 for every engine: a Czech question shares
  few surface words with an English text.
- **Lemmatisation** helps slightly (0.54 and 0.64 on the Czech sets) once two guards are in
  place: simplemma turned English "AI" into the stopword "be", and Czech loanwords into Czech
  lemmas ("data" to "datum"), which first made the lemmatised index worse than the old KB.
- **Embeddings** close the cross-lingual gap on their own: qwen3-embedding-4b reaches recall 1.0
  on all four sets.
- **Plain rank fusion can hurt**: on cs_book/cs the weak BM25 list dilutes the dense list
  (0.902 vs 1.000). The reranker repairs that, which is why hybrid plus reranker is the default.
- **The LLM listwise reranker** is a working fallback but slightly worse and 30 to 50 times slower.

### 5.3 The reranker template finding

The first run of hybrid-rerank was worse than plain hybrid on every set:

| KB / questions | hybrid-rerank, raw query | hybrid-rerank, with template |
|---|---:|---:|
| cs_book / en | 0.854 / 0.768 | 1.000 / 0.972 |
| cs_book / cs | 0.585 / 0.502 | 1.000 / 0.963 |
| en_book / en | 0.977 / 0.928 | 1.000 / 0.955 |
| en_book / cs | 0.909 / 0.591 | 1.000 / 0.966 |

Cause: the gateway serves qwen3-reranker-4b as a bare classifier and does not apply the model's
instruction template, so an unrelated passage ("Bananas are yellow" for a question about the
capital of France) still scored 0.88. Four formats were compared on the hybrid top-30 of every
question (MRR@6 after reranking):

| Format | en_book/en | cs_book/cs | en_book/cs | cs_book/en |
|---|---:|---:|---:|---:|
| fused order, no reranking | 0.977 | 0.749 | 0.977 | 0.988 |
| raw query and documents | 0.913 | 0.506 | 0.587 | 0.766 |
| `<Instruct>: ...\n<Query>: q` on the query | 0.982 | 0.835 | 0.739 | 0.915 |
| same plus `<Document>: d` on every passage | 0.943 | **0.963** | **0.966** | **0.972** |
| our own instruction wording instead of Qwen's | 0.849 | 0.683 | 0.528 | 0.860 |

The client now applies Qwen's documented format (`engine/retrieval/rerank.py`,
`rerank_formats_for`) for any model whose id contains "qwen"; other rerankers get raw text. The
fix is covered by `tests/engine/test_retrieval.py::test_qwen_reranker_gets_its_instruction_template`
and required re-recording the golden runs (only the citation order inside sections changed).

## 6. Engine benchmark: old vs new on the English book

Command: `python scripts/bench_engines.py --compare --input input/bench/en_book --concurrency 4 --judge`
with `AUTOGENBOOK_LLM_MODEL=gpt-oss-120b`, `AUTOGENBOOK_LLM_MINI_MODEL=gpt-oss-120b`
(`.env` sets `AUTOGENBOOK_FORCE_MINI_MODEL=1`, so both engines used the mini model for every
call). Report: `output/bench/engines-en_book/report.md` and `report.json`, with both work
directories and stdout logs. Every run is started through the API's own `build_command` and
`subprocess_runner`, so the argv, environment and stdout handling are the production ones.

### 6.1 Throughput and cost

| | old | new @ concurrency 4 |
|---|---:|---:|
| exit code | 0 | 0 |
| wall clock | 928.6 s (15.5 min) | 397.0 s (6.6 min) |
| LLM requests | 92 | 140 |
| prompt tokens | 263,863 | 215,084 |
| completion tokens | 154,771 | 101,424 |
| total tokens | 418,634 | 316,508 |
| cost (OpenRouter list price for the model) | $0.376 | not reported by the provider (`null`) |
| request errors / HTTP 429 | 0 / 0 | 2 / 2 (retried; the limiter dropped to concurrency 2 for a while) |
| leaf sections generated | 17 of 17 | 11 of 11 |
| sections per minute | 1.1 | 1.7 |

The two engines generate their own outlines from the same TXT spec, so the leaf counts differ.
The new engine makes more, smaller requests (structured outline, glossary, review, revise, length
and consistency as separate calls) but spends fewer tokens in total, because there are no
free-text JSON repair loops and the previous section's full text is not re-sent with every draft.

### 6.2 Deterministic quality metrics

| | old | new @ c4 |
|---|---:|---:|
| sections within ±25% of the page budget | 11.8% | 81.8% |
| mean absolute deviation from the page budget | 0.938 | 0.167 |
| citation markers in the text | 48 | 37 |
| citations resolving to a KB source | 100% | 100% |
| unknown citations | 0 | 0 |
| duplicated paragraphs across sections | 0.0 | 0.0 |
| heading structure matching the outline | 1.0 | 1.0 |

The page-budget rows are the largest measurable difference: the old engine's sections are on
average almost double their budget, the new engine's are within 17%.

### 6.3 Blind pairwise judge

Judge: gpt-oss-120b. Sections are paired by relative position in the book (the outlines differ),
12 pairs sampled, each judged twice with the order swapped (24 judgements). The judge prompt
(`scripts/bench_engines.py:JUDGE_PROMPT`) gives the book title and target readers, the section
title and summary, the neighbouring section titles and both texts (up to 12,000 characters each),
and asks for a winner on grounding (claims supported by cited sources, citations look real and
specific), coherence with the neighbours, pedagogy, and adherence to the summary at the requested
length. It does not see the retrieved sources, so grounding is judged from the text and its
citations, not verified against the KB.

| | new wins | old wins | ties |
|---|---:|---:|---:|
| overall | 23 | 1 | 0 |
| grounding | 20 | 3 | 1 |
| coherence | 23 | 1 | 0 |
| pedagogy | 22 | 2 | 0 |
| adherence to the section brief | 24 | 0 | 0 |

New-engine win rate 0.958, 95% confidence interval 0.798 to 0.993. The switch bar in the plan
is "not significantly below 0.5".

### 6.4 Second judge, repeat run and reasoning effort

Two more runs of the new engine on the same input, both judged by kimi-k3 (a different model
family than the writer) against the same old-engine run. Settings: `AUTOGENBOOK_JUDGE_MODEL=kimi-k3`
and, for the last column, `AUTOGENBOOK_LLM_REASONING_EFFORT=low`. Reports:
`output/bench/engines-en_book-run2-default-effort/` and `output/bench/engines-en_book-effort-low/`.

| | old | new, default effort, run 1 | new, default effort, run 2 | new, effort `low` |
|---|---:|---:|---:|---:|
| wall clock | 928.6 s | 397.0 s | 589.2 s | 428.9 s |
| leaf sections (own outline each run) | 17 | 11 | 14 | 12 |
| LLM requests (chat, embeddings, rerank) | 92 | 140 | 223 | 205 |
| chat requests | 92 | 56 | 87 | 89 |
| prompt tokens | 263,863 | 215,084 | 340,986 | 307,483 |
| completion tokens | 154,771 | 101,424 | 151,505 | 85,577 |
| HTTP 429 | 0 | 2 | 4 | 4 |
| sections within ±25% of the page budget | 2 of 17 | 9 of 11 | 10 of 14 | 2 of 12 |
| typeset lines / budget, mean (min to max) | 1.94 (1.12 to 4.00) | 1.09 (0.73 to 1.40) | 1.18 (0.84 to 1.34) | 1.32 (0.81 to 1.65) |
| mean absolute deviation from the budget | 0.938 | 0.167 | 0.221 | 0.355 |
| citations, all resolving | 48 | 37 | 57 | 44 |
| judge | | gpt-oss-120b | kimi-k3 | kimi-k3 |
| judgements won by new / old / tie | | 23 / 1 / 0 | 24 / 0 / 0 | 24 / 0 / 0 |
| grounding (new / old / tie) | | 20 / 3 / 1 | 22 / 0 / 2 | 19 / 2 / 3 |
| coherence | | 23 / 1 / 0 | 24 / 0 / 0 | 24 / 0 / 0 |
| pedagogy | | 22 / 2 / 0 | 22 / 2 / 0 | 24 / 0 / 0 |
| adherence | | 24 / 0 / 0 | 23 / 0 / 1 | 24 / 0 / 0 |

Mean completion tokens and latency per successful chat call:

| Agent | default effort (run 1 / run 2) | effort `low` |
|---|---:|---:|
| outline | 2,504 / 2,739 tokens, 13.9 / 19.2 s | 1,329 tokens, 7.7 s |
| glossary | 2,260 / 2,226 tokens, 12.8 / 15.7 s | 1,222 tokens, 7.2 s |
| writer | 1,446 / 1,431 tokens, 11.8 / 12.6 s | 1,076 tokens, 7.8 s |
| reviewer | 1,658 / 1,657 tokens, 13.7 / 16.2 s | 670 tokens, 5.4 s |
| reviser | 2,078 / 1,835 tokens, 16.1 / 15.1 s | 1,318 tokens, 10.0 s |
| length pass | 1,590 / 2,396 tokens, 14.3 / 22.3 s | 924 tokens, 6.7 s |
| consistency | 2,541 / 3,542 tokens, 14.2 / 19.9 s | 1,086 tokens, 6.0 s |
| number of length passes in the run | 6 / 8 | 23 |

What this shows:

- **The quality result holds with an independent judge.** kimi-k3 preferred the new engine in
  all 48 judgements across two runs, so the first result was not self-preference of gpt-oss-120b.
- **Run-to-run variance is large.** The two default-effort runs differ by 48% in wall clock
  (397 s and 589 s) because each run writes its own outline (11 and 14 leaves), reviews trigger a
  different number of revisions, and the endpoint throttles differently. A single run supports
  "about 1.6 to 2.3 times faster than the old engine", not a precise factor.
- **`reasoning_effort=low` halves the cost of each call** (latency and completion tokens both
  drop by 25 to 60% depending on the agent; total completion tokens are the lowest of all runs).
- **It does not shorten the run by itself, and it weakens length control.** The word count per
  section is the same as at default effort (about 1.25 times 400 words per budgeted page in all
  three runs), but the text is split into more and shorter paragraphs, so sections typeset to
  1.32 times their budget instead of 1.09 to 1.18. Most sections land just outside the ±25% band,
  which is why the in-budget count drops from 9 or 10 to 2. The engine reacts with 23 length
  passes instead of 6 to 8, and those passes do not bring the sections back into the band. The
  old engine is still far worse on the same measure (1.94).
- **Follow-up worth doing**: a per-agent reasoning effort (low for writer, reviewer and reviser,
  the model default for the length pass and the outline), or a length prompt that states the
  budget in typeset lines. Either should keep the per-call saving without the extra passes.

### 6.5 Caveats

- One book and one writer model; one old-engine run and three new-engine runs. The Czech book, the paper and the presentation inputs are
  not yet compared with real models; each is roughly an hour on gpt-oss-120b.
- In the first run the judge model is the model that wrote both texts. The two later runs were
  judged by kimi-k3 with the same outcome (section 6.4).
- Because the outlines differ, the section title and summary shown to the judge are the new
  engine's. The adherence criterion (24 to 0) therefore favours the new engine by construction
  and should be quoted with that caveat; the other three criteria do not depend on the summary.
- The judge does not see the sources, so "grounding" measures how well-supported the text looks,
  not factual accuracy against the KB. The deterministic citation checks (section 6.2) cover
  whether cited keys exist, not whether the claim matches the source.
- The new engine was throttled in every run (2 to 4 HTTP 429 responses, each halving the
  concurrency for a while), so the measured speed-up is a floor for this endpoint at
  concurrency 4. The plan's concurrency sweep (1, 2, 4, 8) has not been run with a real model.
- The old engine's cost is an OpenRouter list price for a model the gateway serves for free; it
  is there to make old-engine numbers comparable with earlier OpenRouter runs, not a real charge.

## 7. Test status on the branch (this machine)

| Suite | Result |
|---|---|
| `pytest tests/engine` | 230 passed, 12 skipped, 2 failed. Both failures (`test_contract_api_e2e.py::test_artifacts_are_classified_and_citations_imported`, `test_contract_run_kinds.py::test_export_generates_nothing`) need pandoc, which is not installed here; the PR's CI, with pandoc, reports 238 passed, 1 skipped |
| Golden runs (book, paper, presentation at concurrency 1 and 4) | pass after re-recording for the reranker fix |
| Old CLI `python -m unittest` | 123 OK (per the PR description; not re-run today) |
| `pytest tests/api` | 471 passed, 2 skipped (per the PR description; not re-run today) |
| Compose stack plus Playwright e2e against `run_engine.py` | not run (the API adapter to `run_engine.py` is covered in-process by `test_contract_api_e2e.py`) |

## 8. Status against the plan

| Phase (issue) | State |
|---|---|
| 1 harness and contract (#150) | done |
| 2 core (#151) | done |
| 3 retrieval (#152) | done; beats the old KB on every set (section 5), which was the phase's merge condition |
| 4 book pipeline (#153) | done; contract tests green |
| 5 parity and switch (#154) | partly: English book compared with a real model (section 6); Czech book, paper, presentation, the concurrency sweep, the Compose e2e run and the cluster switch remain |
| 6 paper (#155) | done, contract and golden tests |
| 7 presentation (#156) | done, contract and golden tests |
| 8 cleanup (#157) | not started, by design: waits until all three types run on the new engine in production |

Everything is on PR #159, unmerged; all milestone issues are open.

## 9. Reproducing the numbers

```bash
# environment: .env holds the e-INFRA base URL and key, and since 27 September 2026
#   AUTOGENBOOK_LLM_MODEL=gpt-oss-120b  AUTOGENBOOK_LLM_MINI_MODEL=gpt-oss-120b
#   AUTOGENBOOK_LLM_REASONING_EFFORT=low  AUTOGENBOOK_JUDGE_MODEL=kimi-k3  (force-mini unset)
# The runs in sections 5 and 6.1 to 6.3 predate that: no reasoning effort, judge gpt-oss-120b,
# and deepseek-v4.1-flash as mini model for the listwise reranker row.
set -a; . ./.env; set +a; unset OPENROUTER_API_KEY

# retrieval
python scripts/bench_retrieval.py --retriever all --k 6
python scripts/bench_retrieval.py --retriever hybrid-llmrerank --k 6

# engine comparison (about 25 minutes on gpt-oss-120b for en_book)
AUTOGENBOOK_LLM_REASONING_EFFORT= AUTOGENBOOK_JUDGE_MODEL=gpt-oss-120b \
  python scripts/bench_engines.py --compare --input input/bench/en_book --concurrency 4 --judge

# repeat the new engine only and judge against the stored old run (sections 6.4)
AUTOGENBOOK_LLM_REASONING_EFFORT= python scripts/bench_engines.py --compare \
  --old-run output/bench/engines-en_book/old --input input/bench/en_book --concurrency 4 --judge
python scripts/bench_engines.py --compare \
  --old-run output/bench/engines-en_book/old --input input/bench/en_book --concurrency 4 --judge

# still to run for phase 5
python scripts/bench_engines.py --compare --input input/bench/cs_book --concurrency 1,4 --judge
python scripts/bench_engines.py --engine new --input input/bench/en_book --sweep 1,2,4,8
python scripts/bench_engines.py --compare --input input/bench/en_paper --concurrency 1,4 --judge
python scripts/bench_engines.py --compare --input input/bench/en_presentation --concurrency 1,4
```
