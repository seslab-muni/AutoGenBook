"""BibTeX entries (`refs.bib`) for the references a document cites."""

from __future__ import annotations

import re
from pathlib import Path

from engine.assemble.citations import Numbering, Reference

_SPECIAL = {"\\": r"\textbackslash{}", "{": r"\{", "}": r"\}", "&": r"\&", "%": r"\%", "$": r"\$", "#": r"\#", "_": r"\_", "~": r"\textasciitilde{}", "^": r"\textasciicircum{}"}


def escape(value: str) -> str:
    return "".join(_SPECIAL.get(ch, ch) for ch in value)


def bib_key(key: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_:\-.]", "_", key)
    return cleaned or "ref"


_VERBATIM = {"url", "doi"}  # typeset through \url/\doi: escaping would print the backslashes


def field_value(name: str, value: str) -> str:
    if name in _VERBATIM:
        return value.replace("{", "%7B").replace("}", "%7D").replace(" ", "%20")
    return escape(value)


def format_entry(kind: str, key: str, fields: list[tuple[str, str]]) -> str:
    body = ",\n".join(f"  {name} = {{{field_value(name, str(value))}}}" for name, value in fields if value)
    return f"@{kind}{{{bib_key(key)},\n{body}\n}}"


def entry(key: str, ref: Reference | None) -> str:
    fields: list[tuple[str, str]] = []
    if ref is None:
        kind = "misc"
        fields = [("title", f"Unresolved citation: {key}"), ("howpublished", "Unresolved citation")]
    elif ref.kind == "web" or ref.url or ref.doi:
        kind = "article" if ref.venue else "misc"
        fields = [("title", ref.title or ref.url)]
        if ref.authors:
            fields.append(("author", " and ".join(ref.authors)))
        if ref.year:
            fields.append(("year", ref.year))
        if ref.venue:
            fields.append(("journal", ref.venue))
        if ref.doi:
            fields.append(("doi", ref.doi))
        if ref.url:
            fields.append(("url", ref.url))
            fields.append(("howpublished", ref.url.split("/")[2] if "://" in ref.url else ref.url))
    else:
        kind = "misc"
        name = ref.file_name or key
        loc = f" ({ref.loc})" if ref.loc else ""
        fields = [("title", f"{name}{loc}"), ("howpublished", "Local knowledge-base source")]
        note = "; ".join(p for p in (f"RID={ref.rid}" if ref.rid else "", f"loc={ref.loc}" if ref.loc else "") if p)
        if note:
            fields.append(("note", note))
    return format_entry(kind, key, fields)


def write_bib(path: Path, numbering: Numbering) -> Path:
    entries = [entry(key, ref) for _n, key, ref in numbering.ordered()]
    path.write_text("\n\n".join(entries) + ("\n" if entries else ""), encoding="utf-8")
    return path
