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
def normalize_language(value: str | None) -> str | None:
    if not value:
        return None
    lowered = value.strip().casefold()
    if lowered not in _ALIASES:
        lowered = re.split(r"[\s_\-(]", lowered)[0]
    if lowered in LANGUAGE_NAMES:
        return lowered
    if lowered in _ALIASES:
        return _ALIASES[lowered]
    # Any other ISO 639 code (optionally with a region, "pt-BR") is taken as
    # given; language_name() keeps the code.
    code = re.fullmatch(r"([a-z]{2,3})(?:[-_][a-z0-9]{2,8})*", value.strip().casefold())
    return code.group(1) if code else None


def language_name(code: str) -> str:
    return LANGUAGE_NAMES.get(code, code)


# Stopword profiles: detection must be instant (simplemma's langdetect loads a
# dictionary per candidate language, several seconds for eight languages).
_PROFILES: dict[str, set[str]] = {
    "cs": set("a se na je že v ve to pro s z do jako ale jsou by k o které který která nebo při jak také tak jeho není být jsme byl".split()),
    "sk": set("a sa na je že v vo to pre s z do ako ale sú by k o ktoré ktorý ktorá alebo pri aj tak jeho nie byť sme bol".split()),
    "en": set("the and of to in is that for it with as on are be this by an or from which not at was were".split()),
    "de": set("der die und in den von zu das mit sich des auf für ist im dem nicht ein eine als auch es an".split()),
    "pl": set("i w na z się do nie to że jest o jak po co ale od za dla przez są być".split()),
    "fr": set("le la les de des et en un une du est que pour dans qui par pas sur au avec ce".split()),
    "es": set("el la de que y en los del se las por un para con una es al lo como más".split()),
    "it": set("il di che la e per un in una non sono del della le si con da come al dei".split()),
}
_CS_ONLY = set("ěřů")
_SK_ONLY = set("äôľĺŕ")


def detect_language(text: str, default: str = "en") -> str:
    tokens = re.findall(r"\w+", (text or "")[:20000].casefold())
    if len(tokens) < 3:
        return default
    scores = {lang: sum(1 for t in tokens if t in words) / len(tokens) for lang, words in _PROFILES.items()}
    best = max(scores, key=lambda lang: scores[lang])
    if best in {"cs", "sk"}:
        chars = set((text or "").casefold())
        if chars & _CS_ONLY and not chars & _SK_ONLY:
            best = "cs"
        elif chars & _SK_ONLY and not chars & _CS_ONLY:
            best = "sk"
    return best if scores[best] >= 0.05 else default
