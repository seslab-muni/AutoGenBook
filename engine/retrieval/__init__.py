"""Structure-aware hybrid retrieval (phase 3, #152).

Extraction (pypdfium2 + pdfplumber tables, header/footer removal,
dehyphenation, shared content-hash cache) -> sentence/paragraph chunking with
heading paths -> lemmatised BM25 (bm25s + simplemma) and multilingual dense
embeddings fused by reciprocal rank fusion -> reranking (remote vLLM
`/rerank` or `/score`, listwise mini-model fallback) -> source
diversification -> the `[<rid>] kind=kb ... cite_key="..."` context block.
"""
