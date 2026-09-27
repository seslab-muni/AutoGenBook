"""Output-language resolution. Prompts are English; the document language is a
rendered variable: `--language` > the spec's `Language:` label > detection on
the spec text > English."""

from __future__ import annotations

import re

LANGUAGE_NAMES = {
    "cs": "Czech",
    "sk": "Slovak",
    "en": "English",
    "de": "German",
    "pl": "Polish",
    "fr": "French",
    "es": "Spanish",
    "it": "Italian",
    "pt": "Portuguese",
    "nl": "Dutch",
    "hu": "Hungarian",
    "uk": "Ukrainian",
}
_ALIASES = {
    "czech": "cs", "čeština": "cs", "cestina": "cs", "cz": "cs", "česky": "cs",
    "slovak": "sk", "slovenčina": "sk", "slovencina": "sk",
    "english": "en", "angličtina": "en", "anglictina": "en",
    "german": "de", "deutsch": "de", "němčina": "de",
    "polish": "pl", "french": "fr", "spanish": "es", "italian": "it",
    "portuguese": "pt", "dutch": "nl", "hungarian": "hu", "ukrainian": "uk",
}
_DETECTABLE = ("cs", "sk", "en", "de", "pl", "fr", "es", "it")


def normalize_language(value: str | None) -> str | None:
    if not value:
        return None
    lowered = value.strip().casefold()
    lowered = re.split(r"[\s_\-(]", lowered)[0] if lowered not in _ALIASES else lowered
    if lowered in LANGUAGE_NAMES:
        return lowered
    return _ALIASES.get(lowered)


def language_name(code: str) -> str:
    return LANGUAGE_NAMES.get(code, code)


def detect_language(text: str, default: str = "en") -> str:
    sample = (text or "")[:20000]
    if not sample.strip():
        return default
    try:
        import simplemma

        scores = simplemma.langdetect(sample, lang=_DETECTABLE)
        best, score = scores[0]
        if best != "unk" and score >= 0.3:
            return best
    except Exception:  # noqa: BLE001 - detection is best effort
        pass
    czech = len(re.findall(r"[ěščřžýáíéůúťďň]", sample.casefold()))
    return "cs" if czech > max(5, len(sample) // 200) else default
