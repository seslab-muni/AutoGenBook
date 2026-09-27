"""Lexical retrieval: bm25s over lemmatised, accent-insensitive tokens.

Czech inflection ("učitel", "učitele", "učitelům") collapses to one lemma
with simplemma (dictionary-based, no models) before accents are folded, so a
Czech query matches every form of the word. The old tokeniser (accent fold +
`[a-z0-9]+`, no lemmatisation) is kept as `mode="plain"` for the benchmark.
"""

from __future__ import annotations

import re
import unicodedata
from functools import lru_cache
from typing import Sequence

import numpy as np

_WORD_RE = re.compile(r"\w+", re.UNICODE)
_PLAIN_RE = re.compile(r"[a-z0-9]+")
STOPWORDS = {
    "en": set(
        "a an the and or but if of to in on at by for with from as is are was were be been being this that these those "
        "it its into than then there their they them he she we you i not no do does did so such can could may might will "
        "would should which who whom whose what when where why how all any each more most other some own same very".split()
    ),
    "cs": set(
        "a i o u v ve z ze s se na do od po pro při za je jsou byl byla bylo byli být jak že to ten ta tu ty tím této "
        "tohoto který která které kteří jako ale nebo ani aby by jen již už tak také i k ke co kdo kde kdy proč jejich "
        "jeho její jsem jsi jsme jste nás vás mu mi ho jí".split()
    ),
}


def fold(text: str) -> str:
    normalized = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in normalized if not unicodedata.combining(ch)).casefold()


def plain_tokens(text: str) -> list[str]:
    """The old engine's tokeniser (`rag_kb._tokenize`)."""
    return _PLAIN_RE.findall(fold(text))


@lru_cache(maxsize=200_000)
def _lemma(word: str, lang: str) -> str:
    try:
        import simplemma

        langs = (lang, "en") if lang != "en" else ("en",)
        return simplemma.lemmatize(word, lang=langs)
    except Exception:  # noqa: BLE001 - unknown language code etc.
        return word


def lemma_tokens(text: str, lang: str = "en") -> list[str]:
    stop = STOPWORDS.get(lang, set()) | STOPWORDS["en"]
    out: list[str] = []
    for word in _WORD_RE.findall(text.casefold()):
        if word in stop or (len(word) == 1 and not word.isdigit()):
            continue
        lemma = _lemma(word, lang).casefold()
        token = fold(lemma)
        if token and token not in stop:
            out.append(token)
    return out


def detect_lang(text: str, default: str = "en") -> str:
    from engine.spec.language import detect_language

    return detect_language(text[:5000], default=default)


class LexicalIndex:
    """BM25 over a fixed corpus; `mode` is `lemma` (default) or `plain`."""

    def __init__(self, texts: Sequence[str], langs: Sequence[str], *, mode: str = "lemma") -> None:
        import bm25s

        self.mode = mode
        corpus = [self.tokenize(text, lang) for text, lang in zip(texts, langs)]
        self.size = len(corpus)
        self._bm25 = bm25s.BM25(k1=1.5, b=0.75)
        if self.size:
            self._bm25.index(corpus, show_progress=False)

    def tokenize(self, text: str, lang: str = "en") -> list[str]:
        return plain_tokens(text) if self.mode == "plain" else lemma_tokens(text, lang)

    def scores(self, query: str, lang: str = "en") -> np.ndarray:
        if not self.size:
            return np.zeros(0, dtype=np.float32)
        tokens = self.tokenize(query, lang)
        if not tokens:
            return np.zeros(self.size, dtype=np.float32)
        return np.asarray(self._bm25.get_scores(tokens), dtype=np.float32)

    def search(self, query: str, *, lang: str = "en", top: int = 30, mask: np.ndarray | None = None) -> list[tuple[int, float]]:
        scores = self.scores(query, lang)
        if scores.size == 0:
            return []
        if mask is not None:
            scores = np.where(mask, scores, -np.inf)
        order = np.argsort(-scores, kind="stable")[:top]
        return [(int(i), float(scores[i])) for i in order if np.isfinite(scores[i]) and scores[i] > 0]
