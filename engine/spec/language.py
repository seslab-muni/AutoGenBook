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
    # Any other ISO 639-1 code (optionally with a region, "pt-BR"), or a
    # common ISO 639-2 code mapped to it; language_name() keeps the code.
    code = re.fullmatch(r"([a-z]{2,3})(?:[-_][a-z0-9]{2,8})*", value.strip().casefold())
    if not code:
        return None
    tag = code.group(1)
    if tag in ISO_639_2:
        return ISO_639_2[tag]
    return tag if tag in ISO_639_1 else None


ISO_639_1 = frozenset("""
aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es
et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj
kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv
ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti
tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu
""".split())
ISO_639_2 = {
    "ces": "cs", "cze": "cs", "slk": "sk", "slo": "sk", "eng": "en", "deu": "de", "ger": "de", "pol": "pl",
    "fra": "fr", "fre": "fr", "spa": "es", "ita": "it", "por": "pt", "nld": "nl", "dut": "nl", "hun": "hu",
    "ukr": "uk", "rus": "ru", "jpn": "ja", "zho": "zh", "chi": "zh", "kor": "ko", "ara": "ar", "tur": "tr",
    "swe": "sv", "nor": "no", "dan": "da", "fin": "fi", "ell": "el", "gre": "el", "ron": "ro", "rum": "ro",
    "bul": "bg", "hrv": "hr", "srp": "sr", "slv": "sl", "lit": "lt", "lav": "lv", "est": "et", "heb": "he",
    "hin": "hi", "vie": "vi", "tha": "th", "ind": "id", "cat": "ca", "eus": "eu", "baq": "eu", "glg": "gl",
}


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
