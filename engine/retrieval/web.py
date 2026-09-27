"""Web retrieval (Tavily) and reference verification.

Web search is a second `Retriever`, used only with `--enable-web-rag` and
never scoped. For papers, a web reference is emitted only when its DOI (via
doi.org) or URL resolves at generation time (`verify_reference`).
"""

from __future__ import annotations

import hashlib
import re
from typing import Any, Sequence
from urllib.parse import urlparse

import httpx

from engine.retrieval.types import RetrievalItem

TAVILY_URL = "https://api.tavily.com/search"
_DOI_RE = re.compile(r"\b(10\.\d{4,9}/[^\s\"<>]+)", re.IGNORECASE)


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.strip().lower()).strip("_")[:64] or "ref"


def web_rid(seed: str) -> str:
    return f"RID:web:tavily:{hashlib.sha1(seed.encode('utf-8', errors='ignore')).hexdigest()[:12]}"


def web_cite_key(title: str, url: str) -> str:
    digest = hashlib.sha1(url.encode("utf-8", errors="ignore")).hexdigest()[:6]
    return f"web_tavily_{_slug(title)}_{digest}"


def find_doi(*texts: str) -> str | None:
    for text in texts:
        match = _DOI_RE.search(text or "")
        if match:
            return match.group(1).rstrip(".,;)")
    return None


class TavilyRetriever:
    name = "tavily"

    def __init__(self, http: httpx.AsyncClient, api_key: str | None, *, item_chars: int = 1500) -> None:
        self.http = http
        self.api_key = api_key
        self.item_chars = item_chars

    @property
    def available(self) -> bool:
        return bool(self.api_key)

    async def search(self, queries: Sequence[str], *, k: int = 5, kb_sources: Sequence[str] | None = None) -> list[RetrievalItem]:
        if not self.api_key:
            return []
        items: list[RetrievalItem] = []
        seen: set[str] = set()
        for query in queries[:2]:
            try:
                resp = await self.http.post(
                    TAVILY_URL,
                    json={"api_key": self.api_key, "query": query[:400], "max_results": k, "search_depth": "basic",
                          "include_answer": False, "include_raw_content": False},
                    timeout=20,
                )
                if resp.status_code != 200:
                    continue
                results = resp.json().get("results") or []
            except (httpx.HTTPError, ValueError):
                continue
            for result in results:
                url = str(result.get("url") or "")
                if not url or url in seen:
                    continue
                seen.add(url)
                title = str(result.get("title") or url)
                content = str(result.get("content") or "")
                items.append(
                    RetrievalItem(
                        rid=web_rid(url), kind="web", source="Tavily Search", loc=urlparse(url).netloc,
                        score=float(result.get("score") or 0.0), cite_key=web_cite_key(title, url),
                        text=content[: self.item_chars], url=url, title=title, doi=find_doi(url, content),
                    )
                )
        items.sort(key=lambda it: -it.score)
        return items[:k]

    async def aclose(self) -> None:
        return None


async def url_resolves(http: httpx.AsyncClient, url: str, timeout: float = 10.0) -> bool:
    try:
        resp = await http.head(url, timeout=timeout, follow_redirects=True)
        if resp.status_code in {405, 403} or resp.status_code >= 500:
            resp = await http.get(url, timeout=timeout, follow_redirects=True)
        return 200 <= resp.status_code < 400
    except httpx.HTTPError:
        return False


async def verify_reference(http: httpx.AsyncClient, item: RetrievalItem) -> bool:
    """True when the item's DOI resolves at doi.org, or else its URL resolves."""
    if item.doi and await url_resolves(http, f"https://doi.org/{item.doi}"):
        return True
    if item.url and await url_resolves(http, item.url):
        return True
    return False


def as_dict(item: RetrievalItem) -> dict[str, Any]:
    return {
        "cite_key": item.cite_key, "rid": item.rid, "title": item.title, "url": item.url, "doi": item.doi,
        "source": item.source, "verified": item.verified,
    }
