"""One citation resolver for every output.

Section Markdown carries `[cite_key]` markers (what the API's
`graph_import._CITATION_TOKEN_RE` imports). For compatibility the resolver
also accepts `\\cite{a,b}` (old writer prompts) and `\\footnote{Source:
RID:...}`. The final document gets numbered references `[n]` in order of
first appearance and a bibliography; LaTeX is produced from that same
Markdown, so both outputs share the numbering. Unknown keys are numbered too,
listed as unresolved in the bibliography and reported by the audit - never
silently dropped.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable

KEY_CHARS = r"A-Za-z0-9_.:\-"
_BRACKET_RE = re.compile(
    rf"(?<![!\w\]\\])\[(?P<body>[{KEY_CHARS}]+(?:\s*[,;]\s*[{KEY_CHARS}]+)*)\](?![(\[])"
)
_LATEX_CITE_RE = re.compile(r"\\cite[pt]?\*?(?:\[[^\]]*\])?\{(?P<body>[^{}]*)\}")
_FOOTNOTE_RE = re.compile(r"\\footnote\{\s*(?:Source|Zdroj)\s*:\s*(?P<body>[^{}]*)\}", re.IGNORECASE)
_FENCE_RE = re.compile(r"(```.*?```|~~~.*?~~~|`[^`\n]+`)", re.DOTALL)
KEY_PREFIXES = ("kb_", "web_", "RID:", "ref_", "doi:", "rw_")


@dataclass
class Reference:
    key: str
    kind: str = "kb"  # kb | web | unknown
    source_path: str = ""
    loc: str = ""
    excerpt: str = ""
    title: str = ""
    url: str = ""
    authors: list[str] = field(default_factory=list)
    year: str = ""
    doi: str = ""
    venue: str = ""
    rid: str = ""
    verified: bool | None = None

    @property
    def file_name(self) -> str:
        return Path(self.source_path.replace("\\", "/")).name if self.source_path else ""


class CitationIndex:
    def __init__(self) -> None:
        self.by_key: dict[str, Reference] = {}
        self.rid_to_key: dict[str, str] = {}

    def add(self, ref: Reference) -> None:
        self.by_key.setdefault(ref.key, ref)
        if ref.rid:
            self.rid_to_key.setdefault(ref.rid, ref.key)

    @classmethod
    def from_kb_sources(cls, data: dict[str, Any] | None) -> "CitationIndex":
        index = cls()
        if not data:
            return index
        for chunk in data.get("chunks") or []:
            key = str(chunk.get("cite_key") or "")
            if not key:
                continue
            index.add(
                Reference(
                    key=key, kind="kb", source_path=str(chunk.get("source_path") or ""),
                    loc=str(chunk.get("loc") or ""), excerpt=str(chunk.get("excerpt") or ""),
                    rid=str(chunk.get("rid") or ""),
                )
            )
        for key, entry in (data.get("cite_keys") or {}).items():
            if key in index.by_key:
                continue
            source = str(entry.get("source_path") or "")
            if entry.get("kind") == "web" or key.startswith("web_") or source.startswith(("http://", "https://")):
                # A web reference cited by a section (added after the KB entries).
                index.add(Reference(key=key, kind="web", title=str(entry.get("title") or ""),
                                    url=str(entry.get("url") or source), doi=str(entry.get("doi") or ""),
                                    loc=str(entry.get("loc") or ""), excerpt=str(entry.get("excerpt") or ""), verified=True))
                continue
            index.add(Reference(key=key, source_path=source,
                                loc=str(entry.get("loc") or ""), excerpt=str(entry.get("excerpt") or "")))
        web_rids = {}
        for key, ref in index.by_key.items():
            if ref.kind == "web":
                web_rids[ref.url] = key
        for rid, entry in (data.get("rids") or {}).items():
            if rid.startswith("RID:web:") and str(entry.get("source_path") or "") in web_rids:
                index.rid_to_key.setdefault(rid, web_rids[str(entry.get("source_path"))])
                continue
            if rid not in index.rid_to_key:
                index.add(Reference(key=rid, source_path=str(entry.get("source_path") or ""),
                                    loc=str(entry.get("loc") or ""), excerpt=str(entry.get("excerpt") or ""), rid=rid))
        return index

    def canonical(self, token: str) -> str:
        token = token.strip()
        if token in self.by_key:
            return token
        if token in self.rid_to_key:
            return self.rid_to_key[token]
        if not token.startswith("RID:") and f"RID:{token}" in self.rid_to_key:
            return self.rid_to_key[f"RID:{token}"]
        return token

    def lookup(self, token: str) -> Reference | None:
        return self.by_key.get(self.canonical(token))

    def known(self, token: str) -> bool:
        return self.lookup(token) is not None


def _looks_like_key(token: str) -> bool:
    return token.startswith(KEY_PREFIXES)


def _split(body: str) -> list[str]:
    return [t.strip() for t in re.split(r"[,;]", body) if t.strip()]


@dataclass
class CitationMatch:
    start: int
    end: int
    keys: list[str]
    form: str  # bracket | cite | footnote


def find_citations(text: str, index: CitationIndex | None = None) -> list[CitationMatch]:
    """Citation markers outside code, in document order."""
    index = index or CitationIndex()
    out: list[CitationMatch] = []
    for seg_start, segment in _prose_segments(text):
        for match in _LATEX_CITE_RE.finditer(segment):
            keys = _split(match.group("body"))
            if keys:
                out.append(CitationMatch(seg_start + match.start(), seg_start + match.end(), keys, "cite"))
        for match in _FOOTNOTE_RE.finditer(segment):
            keys = [k for k in _split(match.group("body")) if _looks_like_key(k) or index.known(k)]
            if keys:
                out.append(CitationMatch(seg_start + match.start(), seg_start + match.end(), keys, "footnote"))
        for match in _BRACKET_RE.finditer(segment):
            keys = _split(match.group("body"))
            if keys and all(index.known(k) or _looks_like_key(k) for k in keys):
                out.append(CitationMatch(seg_start + match.start(), seg_start + match.end(), keys, "bracket"))
    out.sort(key=lambda m: m.start)
    # Drop matches nested in an earlier one (a bracket inside a \footnote).
    kept: list[CitationMatch] = []
    for match in out:
        if kept and match.start < kept[-1].end:
            continue
        kept.append(match)
    return kept


def _prose_segments(text: str) -> Iterable[tuple[int, str]]:
    pos = 0
    for match in _FENCE_RE.finditer(text):
        if match.start() > pos:
            yield pos, text[pos : match.start()]
        pos = match.end()
    if pos < len(text):
        yield pos, text[pos:]


def cited_keys(text: str, index: CitationIndex | None = None) -> list[str]:
    index = index or CitationIndex()
    keys: list[str] = []
    for match in find_citations(text, index):
        for key in match.keys:
            canonical = index.canonical(key)
            if canonical not in keys:
                keys.append(canonical)
    return keys


class Numbering:
    """Document-wide reference numbers in order of first citation.

    `group` maps a canonical key to the unit that gets a number: the identity
    for books (one entry per cited passage, as the old engine did), the source
    document for papers (`document_group`), so several passages of one source
    share one bibliography entry."""

    def __init__(self, index: CitationIndex, group: "Callable[[str], str] | None" = None) -> None:
        self.index = index
        self.group = group or (lambda key: key)
        self.numbers: dict[str, int] = {}
        self.members: dict[str, list[str]] = {}  # group -> canonical keys cited
        self.unknown: dict[str, list[str]] = {}  # key -> node keys citing it

    def number(self, token: str, node_key: str | None = None) -> int:
        key = self.index.canonical(token)
        group = self.group(key)
        if group not in self.numbers:
            self.numbers[group] = len(self.numbers) + 1
        members = self.members.setdefault(group, [])
        if key not in members:
            members.append(key)
        if not self.index.known(key):
            self.unknown.setdefault(key, [])
            if node_key and node_key not in self.unknown[key]:
                self.unknown[key].append(node_key)
        return self.numbers[group]

    def ordered(self) -> list[tuple[int, str, Reference | None]]:
        """(number, group key, a representative reference) in number order."""
        out = []
        for group, n in sorted(self.numbers.items(), key=lambda kv: kv[1]):
            first = (self.members.get(group) or [group])[0]
            out.append((n, group, self.index.lookup(first)))
        return out


def document_group(index: CitationIndex) -> "Callable[[str], str]":
    """Group KB passages by their source document (`kb_<source_id>`)."""

    def group(key: str) -> str:
        ref = index.lookup(key)
        rid = ref.rid if ref is not None else (key if key.startswith("RID:") else "")
        if rid.startswith("RID:kb:"):
            parts = rid.split(":")
            if len(parts) >= 5:
                return f"kb_{parts[2]}"
        return key

    return group


def resolve_numeric(text: str, numbering: Numbering, node_key: str | None = None) -> str:
    """Replace every citation marker with `[n]` / `[n, m]` (a footnote-form
    source becomes a plain bracket reference as well)."""
    matches = find_citations(text, numbering.index)
    if not matches:
        return text
    parts: list[str] = []
    pos = 0
    for match in matches:
        parts.append(text[pos : match.start])
        numbers: list[int] = []
        for key in match.keys:
            n = numbering.number(key, node_key)
            if n not in numbers:
                numbers.append(n)
        rendered = "[" + ", ".join(str(n) for n in numbers) + "]"
        if match.form == "footnote" and parts and parts[-1] and not parts[-1].endswith((" ", "\n")):
            rendered = " " + rendered
        parts.append(rendered)
        pos = match.end
    parts.append(text[pos:])
    return "".join(parts)


REFERENCES_TITLE = {
    "cs": "Použitá literatura",
    "sk": "Použitá literatúra",
    "de": "Literaturverzeichnis",
    "pl": "Bibliografia",
    "fr": "Références",
    "es": "Referencias",
    "it": "Bibliografia",
}
_UNRESOLVED = {
    "cs": "Nedohledaný zdroj",
    "sk": "Nedohľadaný zdroj",
}
_LOCAL_SOURCE = {
    "cs": "lokální zdroj znalostní báze",
    "sk": "lokálny zdroj znalostnej bázy",
}


def references_title(language: str) -> str:
    return REFERENCES_TITLE.get(language, "References")


def format_reference(ref: Reference | None, key: str, language: str = "en") -> str:
    if ref is None:
        label = _UNRESOLVED.get(language, "Unresolved reference")
        return f"{label}: `{key}`."
    if ref.kind == "web" or ref.url:
        authors = ", ".join(ref.authors) if ref.authors else ""
        bits = [b for b in (authors, ref.title or ref.url, ref.venue, ref.year) if b]
        text = ". ".join(bits)
        if ref.doi:
            text += f". doi:{ref.doi}"
        if ref.url:
            text += f". <{ref.url}>"
        return text.rstrip(".") + "."
    name = ref.file_name or ref.title or key
    loc = f", {ref.loc}" if ref.loc else ""
    local = _LOCAL_SOURCE.get(language, "local knowledge-base source")
    return f"*{name}*{loc} ({local})."


def bibliography_lines(numbering: Numbering, language: str) -> list[str]:
    return [f"[{n}] {format_reference(ref, key, language)}" for n, key, ref in numbering.ordered()]
