"""The one function that makes a node's margin cards follow its text (issue #182).

Whenever a node's `content_markdown` is written by anything other than the
card's own creation, the anchors of its live cards must be re-resolved against
the new text. Call `reanchor_node_cards` from **every** content writer, in the
same transaction as the content write:

* `OutlineService.update` (a `contentMarkdown` PATCH),
* the graph import (`graph_import._merge_cli_graph_into_outline`,
  `import_single_node`) - the worker writes content without going through the
  service,
* `RevisionService.accept` (an accepted suggestion).

Cards considered (one query, no per-card reads): root `comment` and `review`
rows with an anchor, in any status, and `suggestion` rows that are `running`
or `pending`. Their stored anchor is re-resolved with the engine's resolver
(`api.application.comment_anchors`): the offsets move with the text, a quote
that was edited slightly is fuzzily re-matched (and rewritten to the matched
text), a quote that is gone orphans the card. For comment and review rows the
status follows (`reanchored_status`): `open` <-> `orphaned`, and a `resolved`
row stays resolved. Suggestion rows keep their status - a pending suggestion is
never rewritten or dropped because its text moved; `RevisionService.accept`
re-validates it against the current text instead.

The resolver is CPU-bound pure Python (a 2 kB quote in a 100 kB section is
sub-second, many cards add up), so large jobs run in a worker thread and never
block the event loop. Only rows whose anchor or status actually changed are
written, in one bulk statement.
"""
from __future__ import annotations

import logging
import uuid
from starlette.concurrency import run_in_threadpool

from api.application.comment_anchors import resolve_anchors
from api.domain.models import CommentKind, CommentStatus, NodeComment
from api.domain.ports import CommentRepository

logger = logging.getLogger("api.application.reanchor")

# Work (cards x characters of text) above which the resolver goes to a thread.
_THREAD_THRESHOLD = 200_000


def reanchored_status(comment: NodeComment, anchor: dict | None) -> CommentStatus:
    """Status of a comment/review row after its `anchor` was (re-)resolved:
    resolved rows stay resolved, otherwise open <-> orphaned follows the anchor."""
    if comment.status == CommentStatus.RESOLVED:
        return CommentStatus.RESOLVED
    if anchor is not None and anchor.get("start") is None:
        return CommentStatus.ORPHANED
    return CommentStatus.OPEN


async def reanchor_node_cards(
    comments: CommentRepository,
    node_id: uuid.UUID,
    content: str,
    *,
    commit: bool = False,
) -> int:
    """Re-resolve every live anchored card of `node_id` against `content`
    (see the module docstring). Returns how many rows changed. Does not commit
    unless `commit=True`: call it before the surrounding transaction's commit."""
    rows = await comments.list_anchored_for_node(node_id)
    if not rows:
        return 0
    anchors = [row.anchor or {} for row in rows]
    if len(rows) * max(len(content), 1) > _THREAD_THRESHOLD:
        resolved = await run_in_threadpool(resolve_anchors, content, anchors)
    else:
        resolved = resolve_anchors(content, anchors)

    updates: list[tuple[uuid.UUID, dict | None, CommentStatus | None]] = []
    for row, new_anchor in zip(rows, resolved):
        new_status: CommentStatus | None = None
        if row.kind in (CommentKind.COMMENT, CommentKind.REVIEW):
            status = reanchored_status(row, new_anchor)
            new_status = status if status != row.status else None
        if new_anchor != row.anchor or new_status is not None:
            updates.append((row.id, new_anchor, new_status))
    if updates:
        await comments.update_anchors(updates, commit=False)
    if commit:
        await comments.commit()
    return len(updates)
