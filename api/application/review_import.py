"""Reviewer issues as `kind=review` margin cards (issue #182, phase 3).

`graph_import` hands this module a section's review as the engine wrote it
(`out/section_reviews/<key>_revised.json`, else `<key>.json`)::

    {"ok_to_keep": bool,
     "issues": [{"type", "severity", "description", "required_fix",
                 "quote"?, "start"?, "end"?, "replace_from"?, "replace_to"?}],
     "suggested_edits": [str], "retrieval_queries": [str]}

and the section text it imported into `content_markdown`.

**One `review` row per issue** - author NULL, `thread_id = id`,
`body_markdown` = the description, status `open` (`orphaned` when the quote
cannot be found in the imported text), `anchor` = the issue's quote resolved
against the imported text (`null` for a whole-section issue). `payload`::

    issueKey     stable identity: sha256(type, quote, description)[:32]
    type         the reviewer's issue type ("coverage", "consistency:term", ...)
    severity     "major" | "minor" (critical and its aliases fold into major;
                 the engine's alias table, `engine.agents.models`)
    requiredFix  what to change
    replaceFrom / replaceTo   optional literal replacement ("" when none)
    quote        the quoted text as the engine matched it ("" = whole section)
    okToKeep     the section review's own verdict (same on every issue)
    source       "reviewer" (the LLM reviewer), "consistency" (the cross-
                 section consistency pass; type "consistency:*"),
                 "citation" (the engine's removed-unknown-citations note)
    runId        the run that produced it (null when unknown)
    outdated     true (set by this module) on a row a newer review no longer
                 reports but that a user had replied to: kept as resolved
                 history

The section-level verdict - `okToKeep`, `suggestedEdits`, `retrievalQueries`,
`issueCount`, `runId`, `reviewedAt` - is **node-level**: `outline_nodes.
review_summary` (set by `graph_import` together with the content). It is a
property of the section's latest review, replaced wholesale each time, with no
card lifecycle (nothing to dismiss, no history), and the frontend gets it with
the outline it loads anyway; a section-level review row would be one more kind
of card to special-case everywhere.

**Idempotency** (`sync_node_reviews`): re-importing the same run, a later run,
a regenerate of one node and a resume all call it with that node's current
review. Issues are matched to existing rows by `issueKey`:

* known issue, row live  -> the row is kept with its replies and state
  (`resolved` stays resolved); only its anchor, payload and open/orphaned
  state are refreshed;
* known issue, row deleted by a user (soft-deleted, not superseded) or
  resolved -> the issue does not come back (a dismissed issue stays dismissed);
* new issue -> a new row;
* a live row whose issue the new review no longer reports: `resolved` rows
  stay as they are; an open row with replies becomes `resolved` +
  `payload.outdated` (history); an open row nobody touched is soft-deleted
  (`payload.superseded = true`, so a later import can tell it from a user's
  delete).

Reviews never count in the outline badges (those are open comments and pending
suggestions only).
"""
from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from engine.agents.models import normalize_severity
from engine.util.anchors import make_anchor, resolve_quote

from api.domain.models import CommentKind, CommentStatus, NodeComment
from api.domain.ports import CommentRepository

MAX_BODY = 20_000
MAX_LIST_ITEMS = 50
MAX_ITEM_CHARS = 2_000


@dataclass
class ParsedIssue:
    key: str
    body: str
    anchor: dict | None
    payload: dict


def _text(value: Any, limit: int = MAX_BODY) -> str:
    # Postgres text columns reject NUL.
    return (value if isinstance(value, str) else "").replace("\x00", "")[:limit]


def _norm(value: str) -> str:
    return " ".join(value.split())


def issue_key(issue_type: str, quote: str, description: str) -> str:
    raw = "\x1f".join((_norm(issue_type), _norm(quote), _norm(description)))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def _source_of(issue_type: str, description: str) -> str:
    if issue_type.startswith("consistency:") or issue_type == "consistency":
        return "consistency"
    if issue_type == "citation" and description.startswith("Removed citations"):
        return "citation"
    return "reviewer"


def _severity(value: Any) -> str:
    return "major" if normalize_severity(value) in ("major", "critical") else "minor"


def resolve_issue_anchor(content: str, issue: dict[str, Any]) -> dict | None:
    """The anchor of one reviewer issue in `content`: None for a whole-section
    issue (no quote); otherwise the engine's own offsets if they still index the
    quote (they were written against the same file), else the quote re-resolved
    tolerantly; an orphan anchor (`start`/`end` null) when it cannot be found."""
    quote = issue.get("quote")
    if not isinstance(quote, str) or not quote.strip():
        return None
    start, end = issue.get("start"), issue.get("end")
    if (
        isinstance(start, int) and isinstance(end, int)
        and not isinstance(start, bool) and not isinstance(end, bool)
        and 0 <= start < end <= len(content) and content[start:end] == quote
    ):
        return make_anchor(content, start, end)
    return resolve_quote(content, quote)


def parse_review(
    review: dict[str, Any], content: str, run_id: uuid.UUID | None
) -> tuple[list[ParsedIssue], dict[str, Any]]:
    """`(issues, summary)` of a section review; issues with the same key are
    reported once."""
    ok_to_keep = bool(review.get("ok_to_keep", True))
    parsed: dict[str, ParsedIssue] = {}
    for raw in review.get("issues") or []:
        if not isinstance(raw, dict):
            continue
        issue_type = _text(raw.get("type"), 200).strip() or "other"
        description = _text(raw.get("description")).strip()
        quote = _text(raw.get("quote"))
        key = issue_key(issue_type, quote, description)
        if key in parsed:
            continue
        anchor = resolve_issue_anchor(content, {**raw, "quote": quote})
        parsed[key] = ParsedIssue(
            key=key,
            body=description,
            anchor=anchor,
            payload={
                "issueKey": key,
                "type": issue_type,
                "severity": _severity(raw.get("severity")),
                "requiredFix": _text(raw.get("required_fix")),
                "replaceFrom": _text(raw.get("replace_from")),
                "replaceTo": _text(raw.get("replace_to")),
                "quote": anchor["quote"] if anchor else "",
                "okToKeep": ok_to_keep,
                "source": _source_of(issue_type, description),
                "runId": str(run_id) if run_id else None,
            },
        )

    def strings(value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        return [_text(v, MAX_ITEM_CHARS) for v in value if isinstance(v, str) and v.strip()][
            :MAX_LIST_ITEMS
        ]

    summary = {
        "okToKeep": ok_to_keep,
        "issueCount": len(parsed),
        "suggestedEdits": strings(review.get("suggested_edits")),
        "retrievalQueries": strings(review.get("retrieval_queries")),
        "runId": str(run_id) if run_id else None,
        "reviewedAt": datetime.now(timezone.utc).isoformat(),
    }
    return list(parsed.values()), summary


def _status_for(anchor: dict | None, current: CommentStatus | None = None) -> CommentStatus:
    if current == CommentStatus.RESOLVED:
        return CommentStatus.RESOLVED
    if anchor is not None and anchor.get("start") is None:
        return CommentStatus.ORPHANED
    return CommentStatus.OPEN


async def sync_node_reviews(
    comments: CommentRepository,
    *,
    project_id: uuid.UUID,
    node_id: uuid.UUID,
    issues: list[ParsedIssue],
    now: datetime | None = None,
) -> None:
    """Make the node's review rows match `issues` (see the module docstring).
    Writes without committing; the caller commits with its other writes."""
    now = now or datetime.now(timezone.utc)
    roots, reply_counts = await comments.list_reviews_for_node(node_id)

    live: dict[str, NodeComment] = {}
    dismissed: set[str] = set()
    keyless_live: list[NodeComment] = []
    for row in roots:
        key = row.payload.get("issueKey")
        if row.deleted_at is not None:
            if key and not row.payload.get("superseded"):
                dismissed.add(key)  # a user's delete: the issue stays dismissed
            continue
        if not key:
            keyless_live.append(row)
        elif key not in live:
            live[key] = row
        else:  # a duplicate (should not exist): treat as stale
            keyless_live.append(row)

    new_keys = {issue.key for issue in issues}
    new_rows: list[NodeComment] = []
    refresh: list[dict[str, Any]] = []
    for issue in issues:
        row = live.get(issue.key)
        if row is None:
            if issue.key in dismissed:
                continue
            row_id = uuid.uuid4()
            new_rows.append(
                NodeComment(
                    id=row_id,
                    project_id=project_id,
                    node_id=node_id,
                    kind=CommentKind.REVIEW,
                    author_id=None,
                    anchor=issue.anchor,
                    status=_status_for(issue.anchor),
                    thread_id=row_id,
                    parent_id=None,
                    body_markdown=issue.body,
                    payload=issue.payload,
                    created_at=now,
                    updated_at=now,
                )
            )
            continue
        # Same issue again: keep the row (replies, state); refresh the rest.
        current = row.status
        if row.payload.get("outdated"):
            current = CommentStatus.OPEN  # reported again: no longer history
        status = _status_for(issue.anchor, current)
        payload = dict(issue.payload)  # a fresh payload: `outdated` is dropped
        if (
            status != row.status
            or payload != row.payload
            or issue.anchor != row.anchor
        ):
            refresh.append(
                {"id": row.id, "anchor": issue.anchor, "status": status.value, "payload": payload}
            )

    superseded: list[uuid.UUID] = []
    outdated: list[dict[str, Any]] = []
    for key, row in list(live.items()):
        if key in new_keys:
            continue
        if row.status == CommentStatus.RESOLVED:
            continue
        if reply_counts.get(row.id):
            outdated.append(
                {
                    "id": row.id,
                    "anchor": row.anchor,
                    "status": CommentStatus.RESOLVED.value,
                    "payload": {**row.payload, "outdated": True},
                }
            )
        else:
            superseded.append(row.id)
    for row in keyless_live:
        if row.status != CommentStatus.RESOLVED and not reply_counts.get(row.id):
            superseded.append(row.id)

    if refresh or outdated:
        await comments.bulk_update([*refresh, *outdated])
    await comments.supersede(superseded)
    if new_rows:
        await comments.add_many(new_rows)


__all__ = [
    "ParsedIssue",
    "issue_key",
    "parse_review",
    "resolve_issue_anchor",
    "sync_node_reviews",
]
