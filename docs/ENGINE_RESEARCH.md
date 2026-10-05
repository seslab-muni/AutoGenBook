# Engine improvement research: retrieval, generation, grounding, evaluation and serving

Status: research report, 28 September 2026, branch `feat/158-engine-rewrite` (commit `1071ec4` plus
the uncommitted reasoning-effort changes). Companion to `docs/ENGINE_REWRITE.md` (design) and
`docs/ENGINE_COMPARISON.md` (measurements). Nothing in this report has been implemented. It
proposes work and gives the evidence for it.

Constraints applied to every proposal: the stack stays as it is. Python 3.12 and asyncio, the
e-INFRA CZ gateway for chat, embeddings and reranking, the CERIT-SC Kubernetes deployment, the
frozen contract of `docs/ENGINE_REWRITE.md` section 3, and no changes to `api/` or `app/`. No new
services, no vector database, no own GPU servers, no fine-tuning, no rewrite in another language.

## 1. Summary

### 1.1 Main conclusions

1. **The engine's weakest point is grounding, not retrieval recall.** It verifies that a cited key
   exists. It does not verify that the passage supports the sentence. The literature reports that
   even the best models lack full citation support about half the time [C1]. In our own three
   benchmark runs "grounding, major" is the most frequent major review issue, and the review loop
   does not clear it (section 3, F7).
2. **More self-review will not fix it.** Unaided self-critique does not reliably improve output
   and can lower it [G11] [G12] [G13]. Review helps when it is fed objective signals. The
   proposal is a deterministic and entailment-based verification step, a reviewer from another
   model family, and one revision round instead of two.
3. **The gateway allows four requests in flight per API key, across chat, embeddings and
   reranking together.** Every recorded HTTP 429 says so (F1). Five worker pods share one key.
   Wall-clock time is therefore bound by the number of chat calls, and each added call costs
   time almost linearly. Removing calls matters more than adding parallelism.
4. **The writer often sees three or four passages, not six.** The context cap stops at the first
   passage that does not fit (F4). The retrieval benchmark measures six.
5. **Cross-lingual retrieval needs English queries.** The lexical leg, the reranker and the
   excerpt window all receive a Czech query against English text. The literature is consistent
   that rerankers and lexical search fail in that condition [R2] [R3] [R4].
6. **The current benchmarks cannot measure further progress.** The retrieval benchmark has 17 to
   32 chunks and the reranker sees almost all of them. The engine comparison lets each engine
   write its own outline, and three runs of the same input gave 11, 12 and 14 sections. The judge
   in the published comparison was the writer model [E1].
7. **Benchmarking on e-INFRA needs prior agreement.** The operator's documentation says so
   explicitly [S1].

### 1.2 Recommended work, in order

| Package | Content | Effort | Why first |
|---|---|---|---|
| WP0 Robustness | Treat the gateway limit as a concurrency cap. Stop single failures from disabling dense retrieval or the reranker for a whole run. Stream chat calls with per-role output limits. Batch query embeddings. Guard against corrupted LaTeX. Record the resolved model. | 1 to 3 days | No prompt changes, low risk, removes silent quality loss |
| WP1 Evaluation harness | Same outline for both arms. Development set of three books. Judge from another model family. 100 hand-labelled citation pairs. Settings profile for web runs. Agreement with CERIT-SC on volume. | 1 to 3 days plus labelling | Every later package is measured with it |
| WP2 Retrieval benchmark v2 | Larger confusable corpus, question-type quotas, unanswerable items, brief-style queries, scores stored once so that ablations run offline. | About a week | Needed to tune fusion and the relevance floor |
| WP3 Retrieval core | Deliver every selected passage. English information need per section. Language-aware score fusion. Relevance floor before diversification. | 1 to 3 days | Largest retrieval gain for the Czech use case |
| WP4 Grounding | Citation support verification with repair, before the section file is written. | About a week | Largest quality gap |
| WP5 Review rework | One revision round. Reviewer from another family, fed objective check results. Sufficiency check. | 1 to 3 days | Pays for WP4 in calls |
| WP6 Output format | Prose outside JSON. Closing restatement of constraints. | 1 to 3 days | Removes a corruption class |
| WP7 Coherence | Draft chaining inside a chapter. Paragraph-level redundancy detection. Bilingual glossary with compliance check. | 1 to 3 days | Addresses the known cost of parallel writing |
| WP8 Planning | Evidence-first section plan with paragraph budgets. | 1 to 3 days | Builds on WP4 and WP5 |
| WP9 Structure stage | Document summary layer for outline planning. | 1 to 3 days | Outline coverage for Czech specs |

Expected call budget after WP0, WP4 and WP5: chat calls per section stay at about four, because
verification adds about 1.8 and the review rework removes about 1.9. Query-embedding requests fall
from about five per section to about two. Wall-clock time should stay within ten percent of today
while grounding improves. This is an estimate from the hardening review, to be confirmed on the
WP1 harness.

### 1.3 What not to do

- Multi-agent debate, extra review rounds, persona prompts.
- HyDE or query2doc on the dense leg, semantic chunking, proposition indexing, late chunking.
- GraphRAG or HippoRAG for knowledge bases of 4 to 50 documents.
- Raising `k`, the context cap or the rerank depth.
- Separate concurrency pools per endpoint. The gateway counts all endpoints against one key.
- Hedged chat requests, a learned model router, a self-hosted verifier or evaluator.
- Any method that needs fine-tuning or token log-probabilities.

## 2. Method, scope and limits

**How the research was done.** Three research agents reviewed the literature on retrieval, on the
generation pipeline and grounding, and on evaluation and serving. They were instructed to prefer
peer-reviewed venues, to open every paper's record before citing it, to quote numbers only when
read in the paper, and to separate what a paper shows from what is inferred for this engine. They
returned about 300 verified entries, with some overlap between the three reviews.

This report cites the subset that carries a recommendation
(section 14).

**Verification.** Venues were confirmed against ACL Anthology, OpenReview, publisher, Crossref or
arXiv records. The author of this report re-checked the numbers of the most consequential
citations against the papers themselves: the LongWriter parallel ablation [G5], the
self-correction and debate tables of Huang et al. [G11], and the abstracts of [C1], [R1], [R3] and
[R4]. The benchmarking policy of the gateway operator was confirmed on the CERIT-SC page [S1].

**Technical hardening.** A separate Opus agent reviewed every proposal against the code, read-only
and without calling the gateway. Its findings about the code were then re-verified by running the
checks again (section 3). Where its line references or counts differed from the re-check, this
report uses the re-checked values.

**Limits.**

- Most evidence on passage count, distractors and citation quality comes from English
  short-answer or long-answer question answering, not from book writing.
- No study covers Czech queries over English sources with current embedders or rerankers, and
  none covers Czech sentences verified against English passages.
- Qwen3 embedding and reranker results come from the authors' preprint and model card.
- No gateway requests were made for this report. Everything about gateway behaviour comes from
  documentation and from the three benchmark runs already recorded under `output/bench/`.
- Benefit and effort estimates are engineering judgement, not measurements.
## 3. Findings in the current engine

Verified on the branch by reading the code and by analysing the three recorded new-engine runs in
`output/bench/engines-en_book*/new_c4/out/`. Line numbers refer to the working tree of
28 September 2026.

| ID | Finding | Evidence | Consequence |
|---|---|---|---|
| F1 | The gateway limit is a concurrency cap of four per API key, shared by chat, embeddings and rerank. The limiter answers a 429 by halving its limit. | Nine recorded 429 bodies read "Limit type: max_parallel_requests. Current limit: 4". `engine/llm/limiter.py:80`. `k8s/worker.yaml:15` and `:49`: five replicas, one secret. | The whole deployment shares four requests in flight. Halving wastes capacity that is known to exist. |
| F2 | One failed query embedding disables dense retrieval for the rest of the run. | `engine/retrieval/kb.py:228` | Czech sections fall back to BM25, which reached recall 0.54 to 0.64 on the Czech question sets. |
| F3 | Three consecutive failed rerank requests disable the remote reranker for the rest of the run. The fallback is the listwise LLM reranker. | `engine/retrieval/rerank.py:49` and `:102` | The fallback is 30 to 50 times slower and uses chat slots. Transient 429s can trigger it. |
| F4 | The context cap stops at the first passage that does not fit. | `engine/retrieval/context.py:118`. Reproduced: six passages of 1,200 characters deliver four, six of 1,500 deliver three. | The writer sees fewer passages than were selected. The benchmark's recall@6 overstates what reaches the prompt. |
| F5 | The reranker and the excerpt window use the first query only, which is the title and summary in the document language. | `engine/retrieval/kb.py:251`, `_item`, `context.py:best_window` | For a Czech brief over English chunks the lexical overlap is near zero, so the excerpt is the first 1,500 characters, not the relevant part. |
| F6 | Queries are searched one after another, and each dense search makes its own embedding request. | `engine/retrieval/kb.py:243`, `engine/retrieval/dense.py:162`. 56 query-embedding requests for 11 sections. | About five embedding requests per section occupy slots of the shared cap. |
| F7 | The review loop does not converge (table below). | `engine/pipeline/book.py:81` and `:904`, review files of the three runs | The second round costs calls and rarely clears major issues. |
| F8 | The length pass receives no evidence, and nothing reviews its output. | `engine/pipeline/book.py`, `task_length` | Expanded text is ungrounded by construction. |
| F9 | In a full run, writers see no text of neighbouring sections. `snapshot` is filled only for locked sections and on resume. | `engine/pipeline/book.py:604` and `:613` | This is deliberate, for determinism. It is also the known coherence cost of parallel writing [G5] [G6]. |
| F10 | LaTeX inside a JSON string is silently corrupted when the model writes single backslashes. `\frac`, `\beta`, `\times`, `\nabla` and `\rho` become control characters. `\alpha` fails to parse. | Reproduced with `engine.llm.structured.extract_json` | Schema-constrained decoding does not prevent this, because `\f`, `\b`, `\t`, `\n` and `\r` are valid JSON escapes. |
| F11 | Agent calls set no output limit, and non-streamed requests wait under a 300-second timeout. | `engine/agents/base.py`, `engine/config.py:92` | A slow model or a runaway generation is retried in full. |
| F12 | The resume fingerprint of a section ignores the model, the prompt pack and the knowledge base. | `engine/pipeline/book.py:713` | A resumed run can reuse intermediate results produced under other conditions. |
| F13 | Outline and subdivision see the knowledge base through BM25 only, with a document-language query. | `engine/pipeline/book.py:403` | A Czech spec plans almost blind to English sources. |
| F14 | Consistency patches are written without review or verification. | `engine/pipeline/book.py:1064` | Up to three sections change after their last check. |
| F15 | The benchmark knowledge base has 17 chunks (English book) and the candidate list is 30. | `kb_sources.json` of the recorded runs | The reranker sees the whole corpus. Recall 1.0 is trivial. |
| F16 | Three runs of the same input produced 11, 12 and 14 sections. | Recorded runs | Engine comparisons are confounded by the outline. |
| F17 | The API passes only allow-listed environment variables to the engine. New engine settings never reach web runs. | `api/infrastructure/cli/book_command.py:49` | Per-role models and reasoning effort need another route. |
| F18 | The usage ledger records the requested model name, not the one the gateway resolved. | `engine/llm/client.py:173` and `:197` | A silent model change behind an alias is invisible. |
| F19 | The whole glossary, up to 4,000 characters and cut mid-entry, goes into every writer, reviewer and reviser prompt. | `engine/pipeline/text.py:83` | Tokens are spent on irrelevant terms. |
| F20 | The report of the run in `engines-en_book-run2-default-effort` states reasoning effort `low`. | `report.md` line 5 against the directory name | Check the benchmark script before quoting that run. |

Review loop in the recorded runs:

| Run | Sections | Needed revision after the first review | Got two rounds | Still carried a major issue after round two |
|---|---:|---:|---:|---:|
| Default effort, run 1 | 11 | 7 | 4 | 3 |
| Reasoning effort low | 12 | 10 | 8 | 5 |
| Default effort, run 2 | 14 | 11 | 9 | 6 |

The last column counts every major issue in the final review file, including issues merged later
by the consistency pass and by the removal of unknown citation keys.

Requests of run 1 (11 sections, 397 seconds):

| Kind | Requests | Mean latency |
|---|---:|---:|
| Chat | 58 | 14.5 s |
| Embeddings | 58 | 0.9 s |
| Rerank | 24 | 0.8 s |

Chat labels: writer 12, reviewer 23, reviser 14, length 6, outline, glossary and consistency one
each. With reasoning effort `low`, the mean chat latency fell to 7.2 seconds, but the run made 92
chat calls, of which 23 were length passes. Wall-clock time per section did not improve.
Structured output needed no repair call in any of the three runs.
## 4. Retrieval

### 4.1 What the literature says

| Topic | Finding | Source (status) |
|---|---|---|
| Fusion | A convex combination of normalised scores beats RRF in and out of domain. RRF is sensitive to its parameters. The single weight can be tuned on a small labelled set. | Bruch et al., ACM TOIS 2023 [R1] (peer-reviewed) |
| Fusion, cross-lingual | On cross-lingual MKQA, Recall@100 is 39.9 for BM25, 75.1 for dense and 75.3 for dense plus sparse. The lexical leg adds almost nothing when query and document languages differ. | BGE-M3, Findings of ACL 2024 [R2] (peer-reviewed) |
| Cross-lingual reranking | "Without MT, current state-of-the-art rerankers fall severely short when directly applied in CLIR." Rerankers do not improve first-stage rankings from multilingual bi-encoders. | Zuo et al., Findings of EMNLP 2025 [R3] (peer-reviewed) |
| Reranker language bias | Rerankers systematically favour English and the language of the query. | Wang et al., ACL 2026 [R4] (peer-reviewed) |
| Query vs document translation | For European-language queries over English documents, translating the query beat translating the documents. | Saleh and Pecina, ACL 2020 [R5] (peer-reviewed) |
| Query expansion | Gains from HyDE and query2doc style expansion correlate negatively with retriever strength. Strong embedders lose several nDCG points. The exception is long queries, where rewriting to short queries helps. | Weller et al., Findings of EACL 2024 [R6] (peer-reviewed) |
| Query expansion, private KB | LLM expansion degrades retrieval when the LLM does not know the topic. | Abe et al., SIGIR 2025 [R7] (peer-reviewed) |
| Rerank depth | With a strong first stage, reranking depth 20 is enough. Deeper lists often reduce recall@10. | Meng et al., SIGIR 2024 [R8] (peer-reviewed); Jacob et al., ReNeuIR 2025 [R9] (workshop) |
| Distractors | Passages that score high but do not contain the answer reduce answer accuracy. Related but irrelevant content is the most misleading kind. | Cuconasu et al., SIGIR 2024 [R10]; Wu et al., COLM 2024 [R11] (peer-reviewed) |
| Number of passages | Output quality rises and then falls as passages are added. Hard negatives from stronger retrievers hurt more. | Jin et al., ICLR 2025 [R12] (peer-reviewed) |
| Passage order | Position effects exist in controlled tests [R13]. In realistic pipelines reordering is no better than random shuffling. | Liu et al., TACL 2024 [R13]; Cuconasu et al., EMNLP 2025 [R14] (peer-reviewed) |
| Sufficiency | A prompted "is this context sufficient" rater reached 93% accuracy. Prompted retrieval-quality judges were much weaker than a trained one in an earlier study. | Joren et al., ICLR 2025 [R15] (peer-reviewed); CRAG [R16] (preprint) |
| Chunking | Semantic chunking gives no consistent gain over fixed-size chunking. Proposition indexing adds only +2.7 Recall@20 for supervised retrievers. | Qu et al., Findings of NAACL 2025 [R17]; Dense X, EMNLP 2024 [R18] (peer-reviewed) |
| Chunk context | Vendor-reported failure rate falls from 5.7% to 3.7% with LLM-written chunk context. An independent comparison found NDCG@5 of 0.312, 0.309 and 0.317 for plain, late chunking and contextual retrieval. | Anthropic blog [R19] (vendor); Merola and Singh, ECIR 2025 workshop [R20] |
| Hierarchical summaries | Summary nodes indexed next to leaf chunks help long documents. About 4% of sampled summaries had minor hallucinations. | RAPTOR, ICLR 2024 [R21] (peer-reviewed) |
| Graph methods | No consistent winner. Plain RAG is better on single-hop detail queries, graph methods on multi-hop. | Han et al., KDD 2026 [R22] (peer-reviewed) |
| Parsing | Even the best parsers lose at least 14% end to end against ground-truth text. HTML tables retrieve worse than Markdown or LaTeX tables. | OHRBench, ICCV 2025 [R23] (peer-reviewed) |
| Synthetic test sets | A simple generation prompt produced 95% single-fact questions. Synthetic queries are systematically easier than real ones. LLM judges over-assign relevance when query words appear in a passage. | Know Your RAG, COLING 2025 Industry [R24]; Rahmani et al., SIGIR 2024 [R25]; Alaofi et al., SIGIR-AP 2024 [R26] (peer-reviewed) |
| Retrieval vs downstream quality | Relevance-label metrics correlate only weakly with downstream RAG quality. | Salemi and Zamani, SIGIR 2024 [R27] (peer-reviewed) |

Evidence gaps. No study evaluates Czech queries over English documents with current LLM-based
embedders or rerankers. Qwen3 embedding and reranker results come from the authors' preprint and
model card [R28]. Almost all evidence on distractors and passage count comes from short-answer QA,
not from section writing. Multi-query reranking and passage deduplication have no dedicated study.

### 4.2 Proposals

The verdict column is the result of the technical hardening review (section 10).

| ID | Proposal | Verdict | Benefit | Extra calls | Evidence |
|---|---|---|---|---|---|
| R-A | **Benchmark v2.** 30 to 50 confusable documents per set, including real PDFs. Quotas for single-fact, summary, reasoning and unanswerable questions. Multi-evidence items. Queries that look like real section briefs. Czech questions written from a summary of the passage. Human check of gold labels on a sample. Metrics split by language condition: recall@30 before reranking, nDCG@6, MRR, recall@1 and @3, recall within the delivered context, distractor rate, abstention accuracy. | Adopt, top retrieval priority | High | None at run time | [R24] [R25] [R26] [R27], F15 |
| R-B | **Deliver every selected passage.** Give each selected passage a share of the cap instead of stopping at the first that does not fit. Shorten the block header. Keep six passages and 6,000 characters. | Adopt | High | None | F4 |
| R-C | **English information need per section.** A new planning task writes, for each leaf, one or two English sentences stating the information need and up to three short English queries. It runs on the small model, in batches of about 25 leaves, next to the glossary call. The reranker and the excerpt window use the statement. BM25 uses the English queries. The dense leg uses all queries in one batched embedding request. | Adopt with changes | High | One small call per 25 leaves | [R3] [R4] [R5] [R6], F5, F6 |
| R-D | **Language-aware score fusion.** Replace rank fusion with a convex combination of normalised full-corpus scores. Route the lexical weight per chunk by language. Combine several queries by the per-chunk maximum. Tune the weight per language condition on R-A. Keep rank fusion behind a setting. | Adopt with changes | High | None | [R1] [R2] |
| R-E | **Relevance floor first, diversity second.** Order: rerank, floor, deduplication, diversification by source, cut to `k`. Apply the floor only to calibrated reranker probabilities, never to fallback scores. Deduplicate by cosine similarity and by overlap of expanded excerpts. With two or fewer survivors, tell the writer that evidence is thin and record a review issue. | Adopt with changes | Medium to high | None | [R10] [R11] [R12] |
| R-F | **Sufficiency check with one corrective round.** The reviewer reports whether the evidence is sufficient and what is missing. One additional retrieval at most. | Adopt with changes | Medium | None, inside the review call | [R15] [R29] |
| R-G | **Summary layer for planning.** One summary per document at index time, cached by content hash and model. The outline, subdivision and glossary steps read all summaries. Summaries never enter the chunk list, `kb_sources.json` or citations. Small knowledge bases can be read whole. | Adopt with changes | Medium to high | One per document, once | [R21] [G1], F13 |
| R-H | **Parsing audit.** A parse-quality report per knowledge base. Caption and nearest heading attached to table chunks. Long tables cut at a row boundary with the header row repeated. | Adopt with changes | Medium on affected documents | None | [R23] |
| R-I | **Batched query embeddings** with a per-run cache of query vectors. | Adopt | Medium for throughput | About three fewer per section | F6 |
| R-J | **Dimension truncation and float16 storage.** | Defer | Low | None | [R28]. Memory is not a constraint: 50,000 chunks take about 0.5 GB. |
| R-K | **Persistent rerank-score cache.** | Reject in production, adopt inside the R-A harness | Low | None | Production queries rarely repeat. |
| R-L | **LLM-written chunk context.** | Defer until R-A discriminates | Low to medium | One per chunk at index time | [R19] [R20] |

### 4.3 What not to do in retrieval

- Do not add HyDE or query2doc to the dense leg [R6] [R7].
- Do not raise `k` or the context cap "to be safe" [R10] [R12]. The current six passages and 6,000 characters are in line with the evidence.
- Do not increase rerank depth beyond 20 to 30 [R8] [R9].
- Do not invest in semantic chunking, proposition indexing or late chunking [R17] [R18]. Late chunking needs token-level embeddings, which the embeddings endpoint does not return.
- Do not build GraphRAG or HippoRAG indexes for 4 to 50 documents [R22].
- Do not machine-translate the corpus into Czech [R5].
- Do not make the listwise LLM reranker the default. It is 30 to 50 times slower in our own measurement, and it uses chat slots of the shared cap.
- Do not assume the reranker helps in the cross-lingual condition. Measure it per language condition [R3] [R4].
## 5. Generation pipeline

### 5.1 What the literature says

| Topic | Finding | Source (status) |
|---|---|---|
| Research before outlining | Asking questions after reading retrieved answers is what improves outlines. Without it, heading recall fell from 86.26 to 77.97 and unique sources from 99.83 to 39.56. Removing the outline stage collapsed article quality. | STORM, NAACL 2024 [G1] (peer-reviewed) |
| Outline detail | A more detailed hierarchical outline with adherence control beat the earlier plan-and-revise system on coherence and relevance in human evaluation. | DOC, ACL 2023 [G2] (peer-reviewed) |
| Outline exemplars | Outline quality rose from 81.78 to 86.67 when comparable human outlines were given as structural exemplars. | SurveyForge, ACL 2025 [G3] (peer-reviewed) |
| Reflection rounds | Removing the reflection stage barely changed scores (content 4.57 vs 4.56). Removing retrieval dropped citation recall from 83.48 to 60.11. | AutoSurvey, NeurIPS 2024 [G4] (peer-reviewed) |
| Parallel writing | Writing paragraphs in parallel scored lower than writing them in sequence with prior text in context (quality 88.8 vs 91.5, coherence 88.5 vs 93.3). | LongWriter, ICLR 2025 [G5] (peer-reviewed) |
| Parallel writing | Parallel expansion of a skeleton improves diversity and hurts coherence. | Skeleton-of-Thought, ICLR 2024 [G6] (peer-reviewed) |
| Output length | Models rarely exceed about 2,000 words in one call. Paragraph word budgets in a plan raised the length score from 65.3 to 86.6. | LongWriter [G5] |
| Length control without training | Target adjustment, sample filtering and automated revision improve compliance. Adherence differs by unit (words, characters, tokens). | Retkowski and Waibel, Findings of NAACL 2025 [G7] (peer-reviewed) |
| Planning and attribution | Selecting evidence first, then planning sentences, then writing gives more concise and accurate citations. | Slobodkin et al., ACL 2024 [G8]; Fierro et al., ACL 2024 [G9] (peer-reviewed) |
| Planning and hallucination | Plan-based prompting reduced hallucination cases in human evaluation from 29.6% to 11.6% for GPT-4 and from 58.6% to 32.7% for Llama-2. | LitLLMs, TMLR 2024 [G10] (peer-reviewed) |
| Self-critique | Without an external signal, self-correction lowers accuracy. Stating the requirement in the first prompt scored 81.8 in one call against 75.1 after a seven-call self-correct loop. | Huang et al., ICLR 2024 [G11] (peer-reviewed) |
| Self-critique | Self-correction works with reliable external feedback. It does not work from prompted feedback alone, except on tasks unusually suited to it. | Kamoi et al., TACL 2024 [G12]; Stechly et al., ICLR 2025 [G13] (peer-reviewed) |
| Self-bias | Self-refinement improves fluency and amplifies self-bias. Models recognise and prefer their own output. | Xu et al., ACL 2024 [G14]; Panickssery et al., NeurIPS 2024 [E1] (peer-reviewed) |
| Refinement with feedback | Specific, actionable feedback beats generic feedback. Most of the gain comes in the first iterations. | Self-Refine, NeurIPS 2023 [G15] (peer-reviewed) |
| Multi-agent debate | Debate does not beat self-consistency at equal budget (83.0 vs 88.2 with nine responses). Voting explains most of the reported gains. | Huang et al. [G11]; Smit et al., ICML 2024 [G16]; Choi et al., NeurIPS 2025 [G17] (peer-reviewed) |
| Format restrictions | JSON mode hurt reasoning tasks and helped classification. A two-step "free text, then convert" approach matched free text. The result is disputed by a matched-prompt benchmark. | Tam et al., EMNLP 2024 Industry [G18] (peer-reviewed); JSONSchemaBench [G19] (preprint) |
| Constrained decoding | Grammar-constrained decoding distorts the output distribution. Decoding that does not align with subword tokens impairs accuracy. | Park et al., NeurIPS 2024 [G20]; Beurer-Kellner et al., ICML 2024 [G21] (peer-reviewed) |
| Prompt sensitivity | Open models vary by up to 76 accuracy points across prompt formats, and the best format transfers poorly between models. | Sclar et al., ICLR 2024 [G22] (peer-reviewed) |
| Personas | 162 personas gave no improvement on factual questions across four model families. | Zheng et al., Findings of EMNLP 2024 [G23] (peer-reviewed) |
| Reasoning | Chain-of-thought helps mainly on mathematics and symbolic reasoning. | Sprague et al., ICLR 2025 [G24] (peer-reviewed) |

Caveats. The LongWriter ablation parallelises paragraphs inside one text. The engine parallelises
whole sections and already gives each writer the outline, the glossary and neighbour summaries, so
the coherence cost is likely smaller than the paper's figure. No peer-reviewed study measures the
quality of long prose emitted inside a JSON string, and none measures reasoning effort against
expository writing quality. Both recommendations below are engineering inferences that need the
evaluation in section 8.

### 5.2 Proposals

| ID | Proposal | Verdict | Benefit | Extra calls per section | Evidence |
|---|---|---|---|---|---|
| G-A | **One revision round.** Set the maximum to one. Replace the informational second review with deterministic checks and the verification of section 6. A second round runs only when an objective check fails. | Adopt | High for cost, neutral or better for quality | About 1.3 to 1.9 fewer | [G4] [G11] [G15], F7 |
| G-B | **Externally grounded review.** The reviewer receives deterministic results: word count against budget, unknown keys, citation-support verdicts, stray-language paragraphs, glossary violations, the thin-evidence flag. It prioritises them. It runs on a different model family than the writer. | Adopt with changes | High | 0 | [G11] [G12] [G13] [G14] [E1] |
| G-C | **Requirements in the writer prompt.** Every criterion the reviewer checks is stated to the writer first. | Adopt | Medium to high | 0 | [G11] |
| G-D | **Prose outside JSON.** Writer, reviser and length steps return Markdown followed by a marker line and a small JSON trailer with summary and key terms. A trailer that fails to parse gets a deterministic fallback, never a repair call. JSON stays for outline, plan, review and consistency. Until then, reject bodies that contain control characters inside formulas. | Adopt with changes | Medium | 0 | F10, [G18] [G20] [G21]; disputed by [G19] |
| G-E | **Draft chaining inside a chapter.** A new context mode adds a dependency from each leaf's draft to the previous leaf's draft in the same chapter. The writer receives the end of that draft. Chapters stay parallel. | Adopt | Medium | 0 | [G5] [G6] [G3], F9 |
| G-F | **Paragraph-level redundancy detection.** Embed paragraphs of finished sections. Flag cross-section pairs by a relative threshold. Pass at most ten flagged pairs to the consistency pass. The limit of three patches stays. | Adopt with changes | Medium | Embeddings only | Inference; [G3] names the problem |
| G-G | **Evidence-first section plan.** A plan step before the draft: per paragraph a claim, cite keys, a quote of at most 25 words and a word budget. Quotes are matched against the delivered excerpt, and unmatched claims are dropped before writing. The plan is in the language of the sources. | Adopt with changes, after section 6 | High | +1, neutral after G-A | [G8] [G9] [G10] [G5] |
| G-H | **Length control by design.** Now: the length pass receives the section's evidence, retrieves more before expanding, and is verified afterwards. Later: paragraph budgets from the plan, targeted edits of named paragraphs, a calibration factor per resolved model. | Adopt with changes | Medium to high | 0 or fewer | [G5] [G7], F8 |
| G-I | **Reasoning effort per role.** Set per role in a settings profile, validated per model family. | Adopt with changes | Unclear, measure | 0 | [S3] [G24]. Global `low` did not shorten the run (section 3). |
| G-J | **Closing restatement.** Repeat output language, citation format and length at the end of the writer prompt, after the English excerpts. | Adopt | Medium for language purity | 0 | [L3] [R13] |
| G-K | **Research before outlining** in the style of STORM. | Defer | High for outline coverage | 10 to 30 per book | [G1]. R-G covers most of the gain at no cost per run. |
| G-L | **Best-of-n drafting selected by citation support.** | Defer, opt-in later | Medium to high | About +3 | [C1]. Expensive under the concurrency cap. |
| G-M | **Per-model prompt regression set**, re-run when the writer model or its alias changes. | Adopt | Medium | Offline | [G22] |
| G-N | **Prompt reordering for prefix caching.** | Defer | Low | 0 | [S2]. Generation time dominates, prompt processing is under half a second. |

### 5.3 What not to do in generation

- Do not add multi-agent debate [G11] [G16] [G17].
- Do not add review rounds beyond the first. Returns diminish and unaided self-critique can lower quality [G4] [G11] [G15].
- Do not ask for very long single outputs. Keep leaf sections at roughly 800 to 1,500 words [G5].
- Do not spend effort on personas [G23].
- Do not assume more reasoning improves prose [G24].
- Do not pad a section to reach its budget without new evidence. Padding invites unsupported content.
## 6. Grounding and citation verification

This is the largest gap in the current engine. It checks that a cited key exists in the knowledge
base. It does not check that the cited passage supports the sentence.

### 6.1 What the literature says

| Finding | Source (status) |
|---|---|
| "Even the best models lack complete citation support 50% of the time" on long-form questions. Open models match closed ones on correctness and lag on citation quality. | ALCE, EMNLP 2023 [C1] (peer-reviewed) |
| Sampling four drafts and keeping the one with the best entailment-based citation score raised citation recall from 51.1 to 69.3. | ALCE [C1] |
| Writing closed-book and attaching citations afterwards gives poor citation quality. | ALCE [C1] |
| In deployed answer engines, 51.5% of sentences were fully supported and 74.5% of citations supported their sentence. | Liu et al., Findings of EMNLP 2023 [C2] (peer-reviewed) |
| Sentence-level entailment checks are about as accurate as atomic-fact decomposition, which costs two to four times more. | MiniCheck, EMNLP 2024 [C3] (peer-reviewed) |
| Decomposition adds its own noise. | Hu et al., NAACL 2025 [C4]; Wanner et al., *SEM 2024 [C5] (peer-reviewed) |
| Zero-shot LLM verifiers reach about 74 to 77% balanced accuracy on the standard grounding benchmark. | LLM-AggreFact leaderboard [C6] (project page) |
| Unsupported sentences come mainly from improper inference and inaccurate paraphrase, not from invented content. | STORM [G1] |
| Error rates are higher for rare entities and for facts later in the text. | FActScore, EMNLP 2023 [C7] (peer-reviewed) |
| Up to 57% of citations were post-rationalised: the passage supports the sentence, but the model did not rely on it. | Wallat et al., ICTIR 2025 [C8] (peer-reviewed) |
| Cross-lingual: up to 50% of exactly correct answers were not attributable to any retrieved passage. Entailment models can detect this across languages. | Muller et al., EMNLP 2023 [C9] (peer-reviewed) |
| No LLM gives a consistent factuality score across languages of different resource levels. | Vu et al., EMNLP 2024 [C10] (peer-reviewed) |
| No LLM rater of faithfulness correlated strongly with humans on book-length input. | FABLES, COLM 2024 [C11] (peer-reviewed) |
| Post-hoc research and revision improves attribution while preserving the text. | RARR, ACL 2023 [C12] (peer-reviewed) |
| Czech claim and evidence data with entailment labels exist. | CsFEVER and CTKFacts, Language Resources and Evaluation 2023 [C13] (peer-reviewed) |

### 6.2 Proposals

| ID | Proposal | Verdict | Benefit | Extra calls per section | Evidence |
|---|---|---|---|---|---|
| C-A | **Support check for every cited sentence.** A new `verify` stage after the length pass, before the section file is written. One batched call lists the section's passages and the cited claim units. Each unit gets a verdict (supported, partial, unsupported) and the keys that support it. The verifier is from another model family than the writer. | Adopt with changes | High | +1 | [C1] [C2] [C3], F7 |
| C-B | **Verify against what the writer saw.** Store the excerpt text per cite key with the draft. Excerpts are expanded with neighbouring chunks, so a check against the bare chunk would reject faithful sentences. | Adopt | Required for C-A | 0 | Code: `context.py:expand_excerpt` |
| C-C | **Repair policy.** First re-cite by splicing the marker to a supporting key. Then one batched targeted rewrite of unsupported units. Then drop the key and record a review issue that quotes the sentence. | Adopt with changes | High | About 0.3 | [C12] |
| C-D | **Verdict cache.** Keyed by unit text, keys, excerpt hash, verifier model and prompt version. A second verification after length changes checks only changed units. | Adopt | Cost | About 0.5 | Inference |
| C-E | **Validation set before trust.** About 100 hand-labelled pairs of Czech sentence and English excerpt from real output. Compare a direct cross-lingual judge with "translate the sentence, then judge". Below a balanced accuracy of 0.8 the verifier runs report-only. | Adopt | High | Offline | [C9] [C10] [C13] |
| C-F | **Prioritised checking.** Numbers, names and dates first, later paragraphs first. | Adopt | Medium | 0 | [C7] |
| C-G | **Citation recall and precision as a benchmark metric**, computed by a different model than the in-pipeline verifier. Otherwise the repairs optimise the metric. | Adopt | High | Benchmark only | [C1] |
| C-H | **Verify consistency patches** and quotes in the plan (G-G). | Adopt | Medium | At most three per book | F14 |

Contract notes. Verdict issues go into `section_reviews/<key>_revised.json` with the four existing
fields and type `grounding`, capped at ten per section. Re-cited markers stay single-key
`[cite_key]`, which is what the API's importer reads. A top-level `citation_support.json` is
uploaded harmlessly. No new top-level Markdown file may be written, because the API finds the
book by extension.

Limits. A support check reduces unsupported claims. It does not prove that the model used the
passage [C8]. Expect the verifier to be wrong on about a quarter of hard cases [C6], so the repair
policy must prefer re-citing and flagging over deleting text.
## 7. Czech books from English sources

### 7.1 What the literature says

| Finding | Source (status) |
|---|---|
| Multilingual models process intermediate representations that decode to English before the output language. | Wendler et al., ACL 2024 [L1] (peer-reviewed) |
| Generated text in other languages shows English-influenced vocabulary and syntax. Czech was not tested. | Guo et al., ACL 2025 [L2] (peer-reviewed) |
| With English documents, models sometimes answer in English. An explicit instruction to reply in the user's language is needed. Code-switching persists. | Chirkova et al., KnowLLM workshop at ACL 2024 [L3] (workshop) |
| Retrievers prefer documents in the query language. Generators prefer the query language. | Park and Lee, Findings of ACL 2025 [L4]; Sharma et al., NAACL 2025 [L5] (peer-reviewed) |
| English to Czech translation by the best systems scores close to the human reference (91.6 and 91.2 against 92.9). | WMT24 findings [L6] (peer-reviewed) |
| Terminology dictionaries in the prompt improve translation quality and terminology recall. | WMT23 terminology task [L7]; Bogoychev and Chen, WMT 2023 [L8] (peer-reviewed) |
| Paragraph-level translation beats sentence-by-sentence translation. Omissions remain. | Karpinska and Iyyer, WMT 2023 [L9] (peer-reviewed) |
| A Czech benchmark with 50 tasks and a maintained leaderboard exists. | BenCzechMark, TACL 2025 [L10] (peer-reviewed) |

No study compares writing directly in the target language with writing in English and then
translating, for grounded long-form text. Nothing is specific to Czech.

### 7.2 Proposals

| ID | Proposal | Verdict | Benefit | Extra calls | Evidence |
|---|---|---|---|---|---|
| L-A | **Bilingual, enforceable glossary.** Each entry has the source-language term, the approved Czech term and forbidden variants. Only entries relevant to the section are injected. Compliance is checked on lemma n-grams with the lemmatiser of the retrieval stack, with quotations exempt. Violations are minor review issues. The source term also feeds the English queries of R-C. | Adopt with changes | High for terminology | 0 | [L7] [L8], F19 |
| L-B | **Language guard.** Closing restatement of the output language (G-J). Detection of English paragraphs. Detection per sentence is too noisy for short sentences. | Adopt | Medium | 0 | [L3] |
| L-C | **Model choice by Czech quality.** Select writer and reviewer models with the Czech benchmark and our own paired test. | Adopt | Medium to high | Offline | [L10] |
| L-D | **Controlled comparison** on 10 to 20 sections: direct Czech against an English draft with document-level translation and the glossary. Blind judge and one native reader. | Adopt as an experiment | Unknown until measured | +1 in the pivot variant | [L6] [L9] |
| L-E | **Optional Czech polish pass** by the most fluent model, constrained to leave facts, numbers and citation markers unchanged. A diff verifies it, and the support check runs after it. | Defer until L-D is read | Medium | +1 | [L2]; inference |
## 8. Evaluation

The switch bar in `docs/ENGINE_REWRITE.md` rests on a blind pairwise judge and deterministic
metrics. The measured result in `docs/ENGINE_COMPARISON.md` (23 of 24 judgements for the new
engine) is strong, and the document itself lists the caveats. The literature says those caveats
matter.

### 8.1 What the literature says

| Topic | Finding | Source (status) |
|---|---|---|
| Self-preference | Models recognise their own output, and self-recognition correlates linearly with self-preference. | Panickssery et al., NeurIPS 2024 [E1] (peer-reviewed) |
| Position bias | Order alone can flip rankings. One model beat another on 66 of 80 queries by order manipulation. | Wang et al., ACL 2024 [E2] (peer-reviewed) |
| Pairwise vs pointwise | Pairwise is more accurate for mid-size open models. Pairwise verdicts flip in about 35% of cases under distractor features, against 9% for absolute scores. | Liusie et al., EACL 2024 [E3]; Tripathi et al., COLM 2025 [E4] (peer-reviewed) |
| Length bias | Judges prefer longer answers more than humans do. | Saito et al., NeurIPS 2023 workshop [E5] (workshop) |
| Judge panels | A panel of three models from different families agreed with humans better than a single large judge. | Verga et al. [E6] (preprint) |
| Non-English judging | Judge consistency across 25 languages including Czech is low (Fleiss' kappa about 0.3). An ensemble improves it. Judges skew to high scores and need calibration against native speakers. | Fu and Liu, Findings of EMNLP 2025 [E7]; Hada et al., Findings of EACL 2024 [E8] (peer-reviewed) |
| Small samples | Normal-approximation and bootstrap intervals under-cover below a few hundred items. Use Wilson or Bayesian intervals and paired comparisons. | Bowyer et al., ICML 2025 position paper [E9] (peer-reviewed) |
| Clustering | Items from one document are correlated. Clustered standard errors can be three times the naive ones. | Miller [E10] (preprint) |
| Run variance | Accuracy varied by up to 15% across runs at nominally deterministic settings. | Atil et al. [E11] (workshop) |
| Nugget evaluation | Automatic nugget scoring agrees with humans at system level (Kendall tau 0.887) and poorly per topic (0.36 to 0.54). | Pradeep et al., SIGIR 2025 [E12] (peer-reviewed) |
| Proxy questions | A long text can be scored by whether a reader model answers prepared questions from it. | ProxyQA, ACL 2024 [E13] (peer-reviewed) |
| Coherence taxonomy | Eight coherence error types. The metric is the share of sentences free of them. | BooookScore, ICLR 2024 [E14] (peer-reviewed) |
| Length and adherence | Instruction adherence falls as output length grows. | LongGenBench, ICLR 2025 [E15] (peer-reviewed) |

Sample size. With 12 untied pairs a two-sided sign test needs at least 10 wins for p < 0.05. For
80% power at a two-sided 5% level, a true win rate of 70% needs about 47 pairs, 65% needs about 85,
and 60% needs about 194. These figures are our own calculation with the normal approximation.

### 8.2 Proposals

| ID | Proposal | Verdict | Benefit | Effort |
|---|---|---|---|---|
| E-A | **Same outline for both arms.** Both engines, or both variants, run with the same `book_structure.json` and `--use-json`. Sections then pair one to one, and the adherence criterion stops favouring one side. | Adopt | High | Low |
| E-B | **Judge from another model family** than the writer. Both orders. Order-inconsistent verdicts count as ties. A three-model panel only for release decisions. | Adopt with changes | High | Low |
| E-C | **Pointwise rubric next to the pairwise verdict**, with the length difference of each pair recorded. | Adopt | Medium | Low |
| E-D | **Development set for iteration.** Three books with fixed outlines: Czech from English sources, English, and mathematics-heavy. About 30 leaves, paired per leaf, clustered by book. About 90 pairs give a Wilson half-width near 0.1. | Adopt | High | Medium |
| E-E | **Release-gate statistics.** 80 to 100 paired sections over six to eight books and two or three runs per engine. About 25 to 40 gateway hours, to be agreed with CERIT-SC. | Adopt for release gates only | High | Medium |
| E-F | **Grounding metric.** Citation recall and precision (C-G), validated on the hand-labelled set (C-E). | Adopt | High | Medium |
| E-G | **Document-level metrics.** Embedding-based redundancy rate, language purity, recall within the delivered context. Heading recall is already 1.0 and carries no information. | Adopt partly | Medium | Low |
| E-H | **Proxy questions per chapter.** | Defer | Medium | Medium |
| E-I | **One human calibration.** Two native Czech readers judge 30 to 50 pairs. Report agreement with the judge. | Adopt | High | Human time |
| E-J | **Model identity in every record** (S-F). | Adopt | Medium | Low |

### 8.3 Operating constraint

The CERIT-SC Chat AI documentation states: "Running independent benchmarks is not allowed without
prior consultation. Please coordinate with us in advance." [S1]. The same page states that no model
version is guaranteed to stay available and that "an alias keeps your code working, not your
outputs". The remaining phase 5 runs (Czech book, paper, presentation, the concurrency sweep) and
any evaluation at the scale of E-C should be agreed with `k8s@cerit-sc.cz` first. Peak-time numbers
also measure queue wait, not the engine.
## 9. Serving and efficiency on the existing stack

### 9.1 What the sources say

| Topic | Finding | Source (status) |
|---|---|---|
| Prefix caching | vLLM reuses cached blocks only for an identical token prefix. It shortens prompt processing, not generation. Research systems report large gains in time to first token, with control of the server. | vLLM documentation [S2] (vendor); Prompt Cache, MLSys 2024 [S13] (peer-reviewed) |
| Observing the cache | `cached_tokens` is reported only when the operator enabled prompt token details. | vLLM documentation [S2] (vendor) |
| gpt-oss system message | The harmony system message carries the reasoning effort and the current date. Calls with different efforts do not share a prefix. | vLLM source [S3] (vendor) |
| Reasoning levels | gpt-oss accepts low, medium and high. The default is medium. Qwen3 thinking is switched with a chat-template argument. DeepSeek runs without reasoning by default on this gateway. | Model cards and vLLM documentation [S3]; CERIT-SC documentation [S1] (vendor) |
| Structured decoding | With the current grammar backends the per-token overhead is small. Compilation time grows with `minItems`, `maxItems`, enums and arrays. vLLM advises describing the schema in the prompt as well. | XGrammar, MLSys 2025 [S4]; JSONSchemaBench [G19] (preprint); vLLM documentation [S2] |
| Streaming | The gateway recommends streaming. A non-streamed request "may end with an HTTP 408 error". | CERIT-SC documentation [S1] (vendor) |
| Concurrency control | Concurrency limits with loss-based adaptation on the client are the documented practice. A delay signal refines them. | Netflix concurrency-limits [S5] (project documentation) |
| Hedged requests | Hedging after the 95th percentile adds about 5% load. It suits cheap replicated reads, not a shared generation queue. | Dean and Barroso, CACM 2013 [S6] |
| Embedding dimensions | Qwen3-Embedding-4B supports output dimensions from 32 to 2,560. | Qwen3 Embedding paper and model card [R28] (preprint, vendor) |
| Exact search | For a few thousand to a hundred thousand vectors, direct computation is the efficient and exact choice. | Faiss guidelines [S7] (project documentation) |
| Model routing | Cascades and routers cut cost on question answering. None was tested on long-form or non-English writing. | FrugalGPT, TMLR [S9]; RouteLLM, ICLR 2025 [S10]; AutoMix, NeurIPS 2024 [S11] (peer-reviewed) |
| Kubernetes | The default termination grace period is 30 seconds. CERIT-SC containers default to 512 MB of memory when unspecified. | Kubernetes documentation [S12]; CERIT-SC documentation [S1] |

Local measurement (research agent, 14-core workstation, NumPy, one query, top 30): 100,000 vectors
of 2,560 dimensions take 1.0 GB and 32 ms per query in float32. The same matrix in float16 takes
1,338 ms, because float16 has no BLAS path. Store float16, compute float32 [S8].

### 9.2 Proposals

| ID | Proposal | Verdict | Benefit | Effort |
|---|---|---|---|---|
| S-A | **Treat the gateway limit as a concurrency cap.** Keep one limiter for all endpoints. Read the limit from the 429 body and cap the limiter one below it. Answer this 429 with a short jittered retry, not by halving. Keep halving for 503 and other throttling. | Adopt. The draft proposal of one limiter per endpoint was rejected. | Medium to high | Under a day |
| S-B | **Per-request fault isolation.** A failed query embedding falls back to BM25 for that query only. The reranker is disabled only on "endpoint missing" statuses. On 429 or timeout the query keeps its fused order. | Adopt | High | Under a day |
| S-C | **Stream every chat call** with a per-role output limit that includes a reasoning allowance. On a length stop, retry once with a higher limit and do not send a repair call. | Adopt | Medium | 1 to 3 days |
| S-D | **Fewer calls.** See G-A and R-I. | Adopt | High | Under a day |
| S-E | **Cache hardening.** The extraction and vector caches already sit on the shared volume. Add a model fingerprint: embed a fixed sentence once per run and compare by cosine similarity with the stored vector. Add eviction. Cache summaries and verdicts. | Adopt with changes | Medium | 1 to 3 days |
| S-F | **Record the resolved model** and the gateway's model headers per ledger line, and the set of models per run in `run_meta.json`. | Adopt | Medium | Under a day |
| S-G | **Settings profile.** Roles `main`, `mini`, `review`, `verify` and `judge` resolve relative to the writer model of the run, through a family map in a profile file shipped in the image and selected by the gateway host. Reasoning effort per role lives there too. | Adopt with changes | Medium | 1 to 3 days |
| S-H | **Resume fingerprint** includes an engine work version, the prompt-pack hash and the knowledge-base fingerprint. | Adopt | Correctness | Under a day |
| S-I | **Termination grace period.** The engine already handles SIGTERM and exits 143 after persisting. The deployment sets no grace period, so Kubernetes uses 30 seconds. Set 60 to 120 seconds and confirm that the worker forwards the signal on pod eviction. | Operations | High | Under a day |
| S-J | **Per-key capacity.** Ask CERIT-SC whether the limit of four is per key or per user, and whether it can be raised or keys issued per pod. | Operations | High for concurrent runs | Request |

## 10. Technical hardening review

An Opus agent reviewed every proposal against the code. It worked read-only and made no gateway
requests. It analysed the three recorded benchmark runs and ran offline experiments. Its verdicts
are the verdict columns of sections 4 to 9. Its code findings are section 3, after re-verification.
This section records what the review changed.

### 10.1 Proposals that the review changed or rejected

| Draft proposal | Outcome | Reason |
|---|---|---|
| One limiter per endpoint class | Rejected, replaced by S-A | The gateway counts all endpoints against one key (F1). Separate pools would exceed the cap. |
| Raise `k` and the context budget | Rejected | The literature shows an inverted U [R12]. The real defect is that selected passages are dropped (F4). |
| Rerank against all queries | Changed to R-C | One English statement of the information need serves the reranker and the excerpt window. It cannot come from the outline call, which does not run in project mode. |
| Shared cache on the volume | Reduced to S-E | The extraction and vector caches already live there. |
| SIGTERM handling in the engine | Dropped | Already implemented. The grace period of the deployment remains (S-I). |
| Prose outside JSON "to avoid repair calls" | Motivation corrected | The recorded runs needed no repair call. The reasons are formula corruption (F10), streaming and the disputed format effect. |
| Reasoning effort `low` everywhere | Changed to per role, measured | Global `low` halved chat latency and raised the number of calls, so the run was not faster. |
| Two-wave neighbour-aware revision | Replaced by G-E | Draft chaining inside a chapter is deterministic, and it also helps sections that are not revised. |
| Persistent rerank cache | Rejected for production | Queries rarely repeat. It is useful inside the benchmark harness. |
| Settings through environment variables | Replaced by S-G | The API's allow-list drops them (F17). |
| Prompt reordering for prefix caching | Deferred | Generation dominates wall-clock time. Probe P1 decides. |

### 10.2 Interactions between proposals

| Pair | Interaction | Resolution |
|---|---|---|
| Relevance floor and source diversification | Diversifying first promotes passages below the floor. | Floor, then deduplication, then diversification. |
| Relevance floor and reranker failure | Fallback scores are rank-based and small. A probability floor would drop everything. | Tag each score with its kind. Apply the floor to reranker probabilities only. |
| Evidence plan and delivered context | Plan quotes must match what the writer sees. | R-B ships before G-G. |
| Citation re-citing and the API's citation import | The API reads single-key brackets whose key is in `kb_sources.json`. | Re-cite to chunk keys only. Verify before the section file is written. |
| In-pipeline verifier and the grounding metric | The repairs optimise the verifier's own judgement. | The benchmark uses a different model (C-G). |
| Draft chaining and single-section regenerate | The neighbour already exists on disk. | Read it from the section file. No API change. |
| Summary layer and `kb_sources.json` | Summary chunks would become citable. | Keep summaries outside the chunk list. |
| Length calibration and alias drift | The factor goes stale when the model behind an alias changes. | Key it by the resolved model (S-F). |
| Consistency patches and verification | Patches run after the last check. | Verify patched sections (C-H). |
| Per-role reasoning effort and prefix caching | The gpt-oss system message contains the effort. | Immaterial. Prefix sharing across roles is about 200 tokens. |

### 10.3 Transfer to paper and presentation

| Proposal group | Paper | Presentation |
|---|---|---|
| Retrieval (R-B to R-E, R-I) | Transfers through the shared retrieval service. The related-work step uses ten passages and several queries, so the per-chunk maximum matters more. | Transfers |
| Citation verification (C-A to C-D) | Highest value, because citations are KB-first | A lighter check over slide bullets that carry markers |
| Prose outside JSON (G-D) | Transfers | Transfers to the slide writer and the narration |
| Review rework, plan, length (G-A, G-B, G-G, G-H) | Transfers | Not applicable. There is no review stage, and length is a line limit. |
| Draft chaining (G-E), glossary (L-A) | Transfers | Transfers |
## 11. Roadmap

Each package ships on its own and has its own measurement. Effort: S is under a day, M is one to
three days, L is about a week. Every package that changes prompts or retrieval requires
re-recording the golden runs.

| Package | Content (IDs) | Effort | Depends on | Measurement |
|---|---|---|---|---|
| WP0 Robustness | S-A, S-B, S-C, S-F, S-H, R-I, control-character guard from G-D | M | None | Count of 429s and retries, requests per section, wall-clock time on a fixed outline |
| WP1 Evaluation harness | E-A, E-B, E-C, E-D, E-G, G-M, C-E, S-G, agreement with CERIT-SC | M plus labelling | None | Enables all later measurements |
| WP2 Retrieval benchmark v2 | R-A, R-H, stored scores for offline ablations | L | WP1 | nDCG@6, delivered recall and abstention per language condition |
| WP3 Retrieval core | R-B, R-C, R-D, R-E | M | WP2 for tuning. Ships with defaults equal to today's behaviour until tuned. | WP2 metrics, later the support rate |
| WP4 Grounding | C-A, C-B, C-C, C-D, C-F, C-G, C-H, first part of G-H | M to L | WP1 | Citation recall and precision, judge on grounding |
| WP5 Review rework | G-A, G-B, G-C, R-F | M | WP4 | Chat calls per section, remaining major issues, judge |
| WP6 Output format | G-D, G-J | M | WP0 | Corrupted formulas on the mathematics book, language purity |
| WP7 Coherence | G-E, G-F, L-A | M | WP1 | Judge on coherence, redundancy rate |
| WP8 Planning | G-G, second part of G-H | M | WP4, WP5 | Support rate, length compliance |
| WP9 Structure stage | R-G, outline waits for embeddings when the spec language differs from the sources | M | WP3 | Share of source documents cited in the book |
| Deferred | G-K, G-L, G-N, R-J, R-L, L-E, E-H | | After WP2 and WP4 | |

Retrieval benchmark volume. About 300 questions in three query variants are about 900 rerank
requests and about 15 embedding requests, sent one at a time. After that single pass every
fusion, floor and diversification experiment runs offline on the stored scores.

## 12. Open questions and probes

Single requests, to be agreed with CERIT-SC first. They are not benchmarks.

| ID | Probe | Decides |
|---|---|---|
| P1 | Two identical streamed requests of about 3,000 prompt tokens, back to back. Compare `cached_tokens` and time to first token. | Whether prefix caching is active and reachable through the proxy (G-N) |
| P2 | One chat request. Read the response model, the system fingerprint and the gateway's model headers. | What S-F can record |
| P3 | One embeddings request with `dimensions` set to 1,024. Check the vector length. | Whether the gateway honours dimension truncation (R-J) |
| P4 | A question to CERIT-SC, not a request to the endpoint: is the limit of four per key or per user, and can it be raised or keys issued per pod? | Throughput of concurrent runs (S-J) |

Decisions for the project owner:

- Whether the revision maximum drops to one (G-A). It changes the behaviour described in
  `docs/ENGINE_REWRITE.md` section 4.2.
- Whether draft chaining inside a chapter becomes the default context mode (G-E). It lengthens the
  critical path by one draft per leaf of the longest chapter.
- Which model families serve the review and verify roles for each writer model (S-G).
- Who labels the 100 citation pairs and who the two native readers are (C-E, E-I).

## 13. Evidence gaps

- Czech queries over English sources with current embedders and rerankers.
- Verification of Czech sentences against English passages.
- Direct generation in the target language against an English draft followed by translation, for
  grounded long-form text.
- Quality of long prose emitted inside JSON strings.
- Reasoning effort and sampling settings against the quality of expository writing.
- Automatic detection of redundancy across generated sections.
- Reranking with several queries, and passage deduplication.
- Narration and speech synthesis for generated slides.

Each gap is a place where our own measurement on the WP1 and WP2 harnesses is the only evidence
available.
## 14. References

Status labels: PR = peer-reviewed venue, WS = workshop, PP = preprint, DOC = vendor or project
documentation. Venues were confirmed against the ACL Anthology, OpenReview, publisher or Crossref
records, or the arXiv record where noted in section 2.

### Retrieval

| ID | Reference | Status |
|---|---|---|
| R1 | Bruch, Gai, Ingber. An Analysis of Fusion Functions for Hybrid Retrieval. ACM TOIS, 2023. https://arxiv.org/abs/2210.11934 | PR |
| R2 | Chen et al. M3-Embedding (BGE-M3). Findings of ACL 2024. https://arxiv.org/abs/2402.03216 | PR |
| R3 | Zuo et al. Evaluating Large Language Models for Cross-Lingual Retrieval. Findings of EMNLP 2025. https://aclanthology.org/2025.findings-emnlp.612/ | PR |
| R4 | Wang et al. All Languages Matter: Understanding and Mitigating Language Bias in Multilingual RAG. ACL 2026. https://arxiv.org/abs/2604.20199 | PR |
| R5 | Saleh, Pecina. Document Translation vs. Query Translation for Cross-Lingual Information Retrieval in the Medical Domain. ACL 2020. https://aclanthology.org/2020.acl-main.613/ | PR |
| R6 | Weller et al. When do Generative Query and Document Expansions Fail? Findings of EACL 2024. https://aclanthology.org/2024.findings-eacl.134/ | PR |
| R7 | Abe et al. LLM-based Query Expansion Fails for Unfamiliar and Ambiguous Queries. SIGIR 2025. https://arxiv.org/abs/2505.12694 | PR |
| R8 | Meng et al. Ranked List Truncation for Large Language Model-based Re-Ranking. SIGIR 2024. https://arxiv.org/abs/2404.18185 | PR |
| R9 | Jacob et al. Drowning in Documents: Consequences of Scaling Reranker Inference. ReNeuIR at SIGIR 2025. https://arxiv.org/abs/2411.11767 | WS |
| R10 | Cuconasu et al. The Power of Noise: Redefining Retrieval for RAG Systems. SIGIR 2024. https://arxiv.org/abs/2401.14887 | PR |
| R11 | Wu et al. How Easily do Irrelevant Inputs Skew the Responses of Large Language Models? COLM 2024. https://arxiv.org/abs/2404.03302 | PR |
| R12 | Jin et al. Long-Context LLMs Meet RAG. ICLR 2025. https://arxiv.org/abs/2410.05983 | PR |
| R13 | Liu et al. Lost in the Middle: How Language Models Use Long Contexts. TACL 2024. https://aclanthology.org/2024.tacl-1.9/ | PR |
| R14 | Cuconasu et al. Do RAG Systems Really Suffer From Positional Bias? EMNLP 2025. https://aclanthology.org/2025.emnlp-main.1422/ | PR |
| R15 | Joren et al. Sufficient Context: A New Lens on Retrieval Augmented Generation Systems. ICLR 2025. https://arxiv.org/abs/2411.06037 | PR |
| R16 | Yan et al. Corrective Retrieval Augmented Generation. 2024. https://arxiv.org/abs/2401.15884 | PP |
| R17 | Qu, Tu, Bao. Is Semantic Chunking Worth the Computational Cost? Findings of NAACL 2025. https://arxiv.org/abs/2410.13070 | PR |
| R18 | Chen et al. Dense X Retrieval: What Retrieval Granularity Should We Use? EMNLP 2024. https://arxiv.org/abs/2312.06648 | PR |
| R19 | Anthropic. Introducing Contextual Retrieval. 2024. https://www.anthropic.com/news/contextual-retrieval | DOC |
| R20 | Merola, Singh. Reconstructing Context: Evaluating Advanced Chunking Strategies for RAG. Workshop at ECIR 2025. https://arxiv.org/abs/2504.19754 | WS |
| R21 | Sarthi et al. RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval. ICLR 2024. https://arxiv.org/abs/2401.18059 | PR |
| R22 | Han et al. RAG vs. GraphRAG: A Systematic Evaluation and Key Insights. KDD 2026. https://arxiv.org/abs/2502.11371 | PR |
| R23 | Zhang et al. OCR Hinders RAG (OHRBench). ICCV 2025. https://arxiv.org/abs/2412.02592 | PR |
| R24 | Teixeira de Lima et al. Know Your RAG. COLING 2025 Industry Track. https://arxiv.org/abs/2411.19710 | PR |
| R25 | Rahmani et al. Synthetic Test Collections for Retrieval Evaluation. SIGIR 2024. https://arxiv.org/abs/2405.07767 | PR |
| R26 | Alaofi et al. LLMs can be Fooled into Labelling a Document as Relevant. SIGIR-AP 2024. https://arxiv.org/abs/2501.17969 | PR |
| R27 | Salemi, Zamani. Evaluating Retrieval Quality in Retrieval-Augmented Generation. SIGIR 2024. https://arxiv.org/abs/2404.13781 | PR |
| R28 | Zhang et al. Qwen3 Embedding. 2025. https://arxiv.org/abs/2506.05176. Model card: https://huggingface.co/Qwen/Qwen3-Embedding-4B | PP, DOC |
| R29 | Shao et al. Enhancing Retrieval-Augmented LLMs with Iterative Retrieval-Generation Synergy (Iter-RetGen). Findings of EMNLP 2023. https://aclanthology.org/2023.findings-emnlp.620/ | PR |

### Generation pipeline

| ID | Reference | Status |
|---|---|---|
| G1 | Shao et al. Assisting in Writing Wikipedia-like Articles From Scratch with Large Language Models (STORM). NAACL 2024. https://aclanthology.org/2024.naacl-long.347/ | PR |
| G2 | Yang et al. DOC: Improving Long Story Coherence With Detailed Outline Control. ACL 2023. https://aclanthology.org/2023.acl-long.190/ | PR |
| G3 | Yan et al. SurveyForge. ACL 2025. https://aclanthology.org/2025.acl-long.609/ | PR |
| G4 | Wang et al. AutoSurvey: Large Language Models Can Automatically Write Surveys. NeurIPS 2024. https://arxiv.org/abs/2406.10252 | PR |
| G5 | Bai et al. LongWriter: Unleashing 10,000+ Word Generation from Long Context LLMs. ICLR 2025. https://openreview.net/forum?id=kQ5s9Yh0WI | PR |
| G6 | Ning et al. Skeleton-of-Thought. ICLR 2024. https://openreview.net/forum?id=mqVgBbNCm9 | PR |
| G7 | Retkowski, Waibel. Zero-Shot Strategies for Length-Controllable Summarization. Findings of NAACL 2025. https://aclanthology.org/2025.findings-naacl.34/ | PR |
| G8 | Slobodkin et al. Attribute First, then Generate. ACL 2024. https://aclanthology.org/2024.acl-long.182/ | PR |
| G9 | Fierro et al. Learning to Plan and Generate Text with Citations. ACL 2024. https://aclanthology.org/2024.acl-long.615/ | PR |
| G10 | Agarwal et al. LitLLMs, LLMs for Literature Review: Are we there yet? TMLR 2024. https://openreview.net/forum?id=heeJqQXKg7 | PR |
| G11 | Huang et al. Large Language Models Cannot Self-Correct Reasoning Yet. ICLR 2024. https://openreview.net/forum?id=IkmD3fKBPQ | PR |
| G12 | Kamoi et al. When Can LLMs Actually Correct Their Own Mistakes? TACL 2024. https://aclanthology.org/2024.tacl-1.78/ | PR |
| G13 | Stechly et al. On the Self-Verification Limitations of Large Language Models on Reasoning and Planning Tasks. ICLR 2025. https://openreview.net/forum?id=4O0v4s3IzY | PR |
| G14 | Xu et al. Pride and Prejudice: LLM Amplifies Self-Bias in Self-Refinement. ACL 2024. https://aclanthology.org/2024.acl-long.826/ | PR |
| G15 | Madaan et al. Self-Refine: Iterative Refinement with Self-Feedback. NeurIPS 2023. https://proceedings.neurips.cc/paper_files/paper/2023/hash/91edff07232fb1b55a505a9e9f6c0ff3-Abstract-Conference.html | PR |
| G16 | Smit et al. Should we be going MAD? ICML 2024. https://proceedings.mlr.press/v235/smit24a.html | PR |
| G17 | Choi et al. Debate or Vote: Which Yields Better Decisions in Multi-Agent Large Language Models? NeurIPS 2025. https://openreview.net/forum?id=iUjGNJzrF1 | PR |
| G18 | Tam et al. Let Me Speak Freely? EMNLP 2024 Industry Track. https://aclanthology.org/2024.emnlp-industry.91/ | PR |
| G19 | Geng et al. JSONSchemaBench. 2025. https://arxiv.org/abs/2501.10868 | PP |
| G20 | Park et al. Grammar-Aligned Decoding. NeurIPS 2024. https://proceedings.neurips.cc/paper_files/paper/2024/hash/2bdc2267c3d7d01523e2e17ac0a754f3-Abstract-Conference.html | PR |
| G21 | Beurer-Kellner et al. Guiding LLMs The Right Way. ICML 2024. https://proceedings.mlr.press/v235/beurer-kellner24a.html | PR |
| G22 | Sclar et al. Quantifying Language Models' Sensitivity to Spurious Features in Prompt Design. ICLR 2024. https://arxiv.org/abs/2310.11324 | PR |
| G23 | Zheng et al. When "A Helpful Assistant" Is Not Really Helpful. Findings of EMNLP 2024. https://aclanthology.org/2024.findings-emnlp.888/ | PR |
| G24 | Sprague et al. To CoT or not to CoT? ICLR 2025. https://arxiv.org/abs/2409.12183 | PR |

### Grounding and citations

| ID | Reference | Status |
|---|---|---|
| C1 | Gao et al. Enabling Large Language Models to Generate Text with Citations (ALCE). EMNLP 2023. https://aclanthology.org/2023.emnlp-main.398/ | PR |
| C2 | Liu, Zhang, Liang. Evaluating Verifiability in Generative Search Engines. Findings of EMNLP 2023. https://aclanthology.org/2023.findings-emnlp.467/ | PR |
| C3 | Tang, Laban, Durrett. MiniCheck. EMNLP 2024. https://aclanthology.org/2024.emnlp-main.499/ | PR |
| C4 | Hu et al. Decomposition Dilemmas. NAACL 2025. https://aclanthology.org/2025.naacl-long.320/ | PR |
| C5 | Wanner et al. A Closer Look at Claim Decomposition. *SEM 2024. https://aclanthology.org/2024.starsem-1.13/ | PR |
| C6 | LLM-AggreFact leaderboard. https://llm-aggrefact.github.io/ | DOC |
| C7 | Min et al. FActScore. EMNLP 2023. https://aclanthology.org/2023.emnlp-main.741/ | PR |
| C8 | Wallat et al. Correctness is not Faithfulness in RAG Attributions. ICTIR 2025. https://doi.org/10.1145/3731120.3744592 | PR |
| C9 | Muller et al. Evaluating and Modeling Attribution for Cross-Lingual Question Answering. EMNLP 2023. https://aclanthology.org/2023.emnlp-main.10/ | PR |
| C10 | Vu et al. An Analysis of Multilingual FActScore. EMNLP 2024. https://aclanthology.org/2024.emnlp-main.247/ | PR |
| C11 | Kim et al. FABLES. COLM 2024. https://arxiv.org/abs/2404.01261 | PR |
| C12 | Gao et al. RARR. ACL 2023. https://aclanthology.org/2023.acl-long.910/ | PR |
| C13 | Ullrich et al. CsFEVER and CTKFacts. Language Resources and Evaluation, 2023. https://doi.org/10.1007/s10579-023-09654-3 | PR |

### Writing in Czech from English sources

| ID | Reference | Status |
|---|---|---|
| L1 | Wendler et al. Do Llamas Work in English? ACL 2024. https://aclanthology.org/2024.acl-long.820/ | PR |
| L2 | Guo et al. Do Large Language Models have an English Accent? ACL 2025. https://aclanthology.org/2025.acl-long.193/ | PR |
| L3 | Chirkova et al. Retrieval-augmented generation in multilingual settings. KnowLLM at ACL 2024. https://aclanthology.org/2024.knowllm-1.15/ | WS |
| L4 | Park, Lee. Investigating Language Preference of Multilingual RAG Systems. Findings of ACL 2025. https://aclanthology.org/2025.findings-acl.295/ | PR |
| L5 | Sharma et al. Faux Polyglot. NAACL 2025. https://aclanthology.org/2025.naacl-long.411/ | PR |
| L6 | Kocmi et al. Findings of the WMT24 General Machine Translation Shared Task. WMT 2024. https://aclanthology.org/2024.wmt-1.1/ | PR |
| L7 | Semenov et al. Findings of the WMT 2023 Shared Task on Machine Translation with Terminologies. WMT 2023. https://aclanthology.org/2023.wmt-1.54/ | PR |
| L8 | Bogoychev, Chen. Terminology-Aware Translation with Constrained Decoding and Large Language Model Prompting. WMT 2023. https://aclanthology.org/2023.wmt-1.80/ | PR |
| L9 | Karpinska, Iyyer. Large Language Models Effectively Leverage Document-level Context for Literary Translation, but Critical Errors Persist. WMT 2023. https://aclanthology.org/2023.wmt-1.41/ | PR |
| L10 | Fajcik et al. BenCzechMark. TACL 2025. https://aclanthology.org/2025.tacl-1.50/ | PR |

### Evaluation

| ID | Reference | Status |
|---|---|---|
| E1 | Panickssery, Bowman, Feng. LLM Evaluators Recognize and Favor Their Own Generations. NeurIPS 2024. https://arxiv.org/abs/2404.13076 | PR |
| E2 | Wang et al. Large Language Models are not Fair Evaluators. ACL 2024. https://aclanthology.org/2024.acl-long.511/ | PR |
| E3 | Liusie, Manakul, Gales. LLM Comparative Assessment. EACL 2024. https://arxiv.org/abs/2307.07889 | PR |
| E4 | Tripathi et al. Pairwise or Pointwise? COLM 2025. https://arxiv.org/abs/2504.14716 | PR |
| E5 | Saito et al. Verbosity Bias in Preference Labeling by Large Language Models. NeurIPS 2023 workshop. https://arxiv.org/abs/2310.10076 | WS |
| E6 | Verga et al. Replacing Judges with Juries. 2024. https://arxiv.org/abs/2404.18796 | PP |
| E7 | Fu, Liu. How Reliable is Multilingual LLM-as-a-Judge? Findings of EMNLP 2025. https://aclanthology.org/2025.findings-emnlp.587/ | PR |
| E8 | Hada et al. Are Large Language Model-based Evaluators the Solution to Scaling Up Multilingual Evaluation? Findings of EACL 2024. https://arxiv.org/abs/2309.07462 | PR |
| E9 | Bowyer, Aitchison, Ivanova. Position: Don't Use the CLT in LLM Evals With Fewer Than a Few Hundred Datapoints. ICML 2025. https://arxiv.org/abs/2503.01747 | PR |
| E10 | Miller. Adding Error Bars to Evals. 2024. https://arxiv.org/abs/2411.00640 | PP |
| E11 | Atil et al. Non-Determinism of "Deterministic" LLM Settings. 2024. https://arxiv.org/abs/2408.04667 | WS |
| E12 | Pradeep et al. The Great Nugget Recall. SIGIR 2025. https://arxiv.org/abs/2504.15068 | PR |
| E13 | Tan et al. ProxyQA. ACL 2024. https://arxiv.org/abs/2401.15042 | PR |
| E14 | Chang et al. BooookScore. ICLR 2024. https://arxiv.org/abs/2310.00785 | PR |
| E15 | Wu et al. LongGenBench: Benchmarking Long-Form Generation in Long Context LLMs. ICLR 2025. https://arxiv.org/abs/2409.02076 | PR |

### Serving and infrastructure

| ID | Reference | Status |
|---|---|---|
| S1 | CERIT-SC documentation: Chat AI, https://docs.cerit-sc.cz/en/docs/ai-as-a-service/chat-ai ; AI API, https://docs.cerit-sc.cz/en/docs/ai-as-a-service/ai-api ; storage, https://docs.cerit-sc.cz/en/docs/kubernetes/pvc ; quotas, https://docs.cerit-sc.cz/en/docs/rancher/quotas | DOC |
| S2 | vLLM documentation: automatic prefix caching, https://docs.vllm.ai/en/latest/features/automatic_prefix_caching/ ; structured outputs, https://docs.vllm.ai/en/latest/features/structured_outputs/ ; server options, https://docs.vllm.ai/en/latest/cli/serve/ | DOC |
| S3 | gpt-oss-120b model card, https://huggingface.co/openai/gpt-oss-120b ; vLLM reasoning outputs, https://docs.vllm.ai/en/latest/features/reasoning_outputs/ ; vLLM gpt-oss recipe, https://docs.vllm.ai/projects/recipes/en/latest/OpenAI/GPT-OSS.html | DOC |
| S4 | Dong et al. XGrammar. MLSys 2025 (venue per the arXiv record). https://arxiv.org/abs/2411.15100 | PR |
| S5 | Netflix concurrency-limits. https://github.com/Netflix/concurrency-limits | DOC |
| S6 | Dean, Barroso. The Tail at Scale. Communications of the ACM 56(2), 2013. | Magazine |
| S7 | Faiss: guidelines to choose an index. https://github.com/facebookresearch/faiss/wiki/Guidelines-to-choose-an-index | DOC |
| S8 | Local NumPy measurement by the research agent, reported in section 9.1. | Own measurement |
| S9 | Chen, Zaharia, Zou. FrugalGPT. TMLR. https://arxiv.org/abs/2305.05176 | PR |
| S10 | Ong et al. RouteLLM. ICLR 2025. https://arxiv.org/abs/2406.18665 | PR |
| S11 | Aggarwal et al. AutoMix. NeurIPS 2024. https://arxiv.org/abs/2310.12963 | PR |
| S12 | Kubernetes documentation: Pod lifecycle, https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/ | DOC |
| S13 | Gim et al. Prompt Cache. MLSys 2024. https://arxiv.org/abs/2311.04934 | PR |
