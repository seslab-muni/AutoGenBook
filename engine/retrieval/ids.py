"""Stable KB identifiers, byte-for-byte the old engine's (`rag_kb.py`,
`autogenbook/retrieval/kb_citations.py`), because citations in existing
sections, the API's `ragCitations` and `kb_sources.json` consumers key on them:

- `source_id = <cleaned relpath, <= 48 chars>_<sha256(relpath)[:8]>`
- `rid       = RID:kb:<source_id>:<loc_key>:<j>` (loc_key `chunk`, `page_N`, `slide_N`)
- `cite_key  = kb_<source_id>_<loc_key>_<j>`
- `loc       = "chunk j"` | `"page N, chunk j"` | `"slide N, chunk j"`
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path


def clean_key(text: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]+", "_", text.strip().lower()).strip("_")


def sanitize_key(text: str) -> str:
    return clean_key(text) or "unknown"


def sanitize_loc(loc: str) -> str:
    return clean_key(loc) or "loc"


def source_id_from_path(path: Path, root: Path | None = None, max_len: int = 48) -> str:
    rel = path
    if root is not None:
        try:
            rel = path.relative_to(root)
        except ValueError:
            rel = path
    rel_str = rel.as_posix()
    base = clean_key(rel_str)
    if max_len > 0 and len(base) > max_len:
        base = base[:max_len].rstrip("_")
    digest = hashlib.sha256(rel_str.encode("utf-8", errors="ignore")).hexdigest()[:8]
    return f"{base or 'source'}_{digest}"


def make_rid(source_id: str, loc: str, index: int) -> str:
    return f"RID:kb:{source_id}:{sanitize_loc(loc)}:{index}"


def make_cite_key(source_id: str, loc: str, index: int) -> str:
    return f"kb_{source_id}_{sanitize_key(loc)}_{index}"


def page_key(source_path: str, loc: str) -> str:
    """`kb_sources.json:page_keys` key (old `kb_citations.kb_cite_key`: stem-based
    source id hashed on the full path, plus the loc label)."""
    stem = Path(source_path).stem or "source"
    base = clean_key(stem) or "ref"
    if len(base) > 48:
        base = base[:48].rstrip("_")
    digest = hashlib.sha256(source_path.encode("utf-8", errors="ignore")).hexdigest()[:8]
    source_id = f"{base}_{digest}" if base else f"source_{digest}"
    label = re.sub(r"\s+", " ", (loc or "").strip())
    return (clean_key(f"{source_id}_{label}") or "ref") if label else (clean_key(source_id) or "ref")
