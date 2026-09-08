"""Fold a finished run's `out/structure_graph.json` back into the project's
outline nodes (issue #10) - so the editor shows real generated content and
`Page[OutlineNode]` reflects whatever the CLI actually produced, including
sections it subdivided on its own.

Matching a CLI node key ("1", "1-2", ...) to an outline row is done by
recomputing `cli_key` for the outline's *current* tree shape
(`api.domain.outline.assign_positions`) rather than reading a persisted
column - `OutlineNode.cli_key` is deliberately never written to storage
(`api/presentation/schemas/outline.py`'s docstring), only derived at read
time. This is only safe because `OutlineService._reject_if_run_active`
blocks every structural outline write (create/delete/replace, and any
`update` that moves a node) for the whole lifetime of a project's active
run - otherwise an insert/delete/move landing between `StructureBuilder.
build` rendering the outline for this run and this import running after it
finished would shift every sibling's recomputed key, and this import would
silently write one node's generated content and title onto a different,
unrelated row (issue #74).

A CLI key present in `structure_graph.json` but absent from that recomputed
map is a node the CLI subdivided on its own (`book_pipeline.py`'s
`subdivide_graph`, always allowed for unlocked nodes) - inserted here as a
new, unlocked outline row under the right parent.
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import replace as dataclass_replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from starlette.concurrency import run_in_threadpool

from api.application.outline import WORDS_PER_PAGE
from api.domain.models import MathLevel, NodeStatus, OutlineNode, Project, SourceStatus
from api.domain.outline import assign_positions
from api.domain.ports import OutlineRepository, SourceRepository
from api.infrastructure.cli.book_command import OUT_DIRNAME

_CITATION_TOKEN_RE = re.compile(r"\[([A-Za-z0-9_.:-]+)\]")
_PAGE_RE = re.compile(r"(?:page|p\.?)[\s:]*([0-9]+)", re.IGNORECASE)

# `StructureBuilder._build_node` (`book_spec.py`) sends the CLI a "summary"
# that is actually `subPrompt`/`mathLevel`/`equationDensityLevel` mixed into
# the node's real `summary` as one trailing "Writing instructions: ..."
# block - the only way that per-node metadata reaches `book_builder.py:
# generate_contents`, which reads nothing but a flat `section_summary`.
# Strip that same trailer back off before ever treating a CLI-echoed
# "summary" as a candidate update for the node's own `summary` column - the
# user's own value already lives there and in its own `sub_prompt`/
# `math_level`/`equation_density_level` columns; echoing the merged string
# back would bake the trailer into `summary` and, on every subsequent full
# run, compound another copy of it on top.
_WRITING_INSTRUCTIONS_RE = re.compile(r"(?:\A|\n\n)Writing instructions:.*\Z", re.DOTALL)


def _strip_synthesized_writing_instructions(summary: str) -> str:
    return _WRITING_INSTRUCTIONS_RE.sub("", summary).strip()


def _load_json_sync(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


async def _load_json(path: Path) -> dict[str, Any] | None:
    # Off the event loop (issue #55): a run with many sections did one sync
    # `read_text`/`json.loads` per section here (`_leaf_content_changes`
    # below, plus this for the graph/kb-index/review files), each one
    # blocking every other worker slot's drain loop for however long that
    # file read took.
    return await run_in_threadpool(_load_json_sync, path)


def _extract_page(loc: str) -> str | None:
    match = _PAGE_RE.search(loc)
    return match.group(1) if match else None


def _extract_citations(content: str, kb_index: dict[str, Any]) -> list[dict[str, Any]]:
    cite_keys = kb_index.get("cite_keys") or {}
    rids = kb_index.get("rids") or {}
    found: dict[str, dict[str, Any]] = {}
    for token in _CITATION_TOKEN_RE.findall(content):
        if token in found:
            continue
        entry = cite_keys.get(token) or rids.get(token)
        if entry is None:
            continue
        found[token] = {
            "id": token,
            "sourceDoc": Path(str(entry.get("source_path", ""))).name,
            "sectionSnippet": entry.get("excerpt", ""),
            "pageNumber": _extract_page(str(entry.get("loc", ""))),
            "relevanceScore": None,
        }
    return list(found.values())


async def _load_section_review(out_dir: Path, cli_key: str) -> dict[str, Any] | None:
    reviews_dir = out_dir / "section_reviews"
    for name in (f"{cli_key}_revised.json", f"{cli_key}.json"):
        data = await _load_json(reviews_dir / name)
        if data is None:
            continue
        result: dict[str, Any] = {}
        issues = data.get("issues")
        if isinstance(issues, list) and issues:
            result["notes"] = "\n".join(str(issue) for issue in issues)
        score = data.get("score")
        if isinstance(score, (int, float)):
            result["score"] = float(score)
        return result or None
    return None


def _read_section_sync(content_path: Path) -> str | None:
    if not content_path.is_file():
        return None
    return content_path.read_text(encoding="utf-8")


async def _leaf_content_changes(
    out_dir: Path, cli_key: str, kb_index: dict[str, Any] | None
) -> dict[str, Any]:
    content_path = out_dir / "sections" / f"{cli_key}.md"
    content = await run_in_threadpool(_read_section_sync, content_path)
    if content is None:
        return {}
    changes: dict[str, Any] = {
        "content_markdown": content,
        "actual_words": len(content.split()),
        "status": NodeStatus.COMPILED,
    }
    if kb_index is not None:
        changes["rag_citations"] = _extract_citations(content, kb_index)
    review = await _load_section_review(out_dir, cli_key)
    if review:
        if "notes" in review:
            changes["reviewer_notes"] = review["notes"]
        if "score" in review:
            changes["reviewer_score"] = review["score"]
    return changes


async def _matched_node_changes(
    node: OutlineNode, cli_node: dict[str, Any], out_dir: Path, cli_key: str,
    kb_index: dict[str, Any] | None,
) -> dict[str, Any]:
    changes: dict[str, Any] = {}
    cli_title = str(cli_node.get("title", "")).strip()
    if cli_title and cli_title != node.title:
        changes["title"] = cli_title
    cli_summary = _strip_synthesized_writing_instructions(str(cli_node.get("summary", "")))
    if cli_summary and cli_summary != node.summary:
        changes["summary"] = cli_summary
    cli_pages = cli_node.get("n_pages")
    if isinstance(cli_pages, (int, float)) and abs(float(cli_pages) - node.target_pages) > 1e-9:
        changes["target_pages"] = float(cli_pages)
        # `word_budget` is derived from `target_pages` at creation time
        # (`OutlineService.create`/`replace`) but was never recomputed here
        # when the CLI's own subdivision changed a node's page count -
        # leaving it stale relative to the `target_pages` shown right next
        # to it (issue #65).
        changes["word_budget"] = int(WORDS_PER_PAGE * float(cli_pages))
    changes.update(await _leaf_content_changes(out_dir, cli_key, kb_index))
    return changes


async def _new_node(
    project: Project, cli_node: dict[str, Any], parent_id: uuid.UUID | None, cli_key: str,
    out_dir: Path, kb_index: dict[str, Any] | None, order_index: int, now: datetime,
) -> OutlineNode:
    title = str(cli_node.get("title", "")).strip() or cli_key
    summary = str(cli_node.get("summary", "")).strip()
    cli_pages = cli_node.get("n_pages")
    target_pages = float(cli_pages) if isinstance(cli_pages, (int, float)) else 1.0

    node = OutlineNode(
        id=uuid.uuid4(),
        project_id=project.id,
        parent_id=parent_id,
        order_index=order_index,
        title=title,
        summary=summary,
        status=NodeStatus.NOT_STARTED,
        target_pages=target_pages,
        word_budget=int(WORDS_PER_PAGE * target_pages),
        actual_words=0,
        equation_density_level=project.equation_frequency_level,
        math_level=MathLevel.RIGOROUS,
        sub_prompt=None,
        content_markdown="",
        content_latex="",
        rag_citations=[],
        reviewer_score=None,
        reviewer_notes=None,
        structure_locked=False,
        created_at=now,
        updated_at=now,
        # Persisted (not left `None` for `assign_positions` to recompute
        # later) so a `generate`-mode base run's drift check
        # (`RunService.regenerate_node`) has a stable record of the key
        # this node actually had in the CLI's own `structure_graph.json` at
        # import time, independent of whatever position it's since moved
        # to (issue #58; #62 tracks `cli_key` persistence more generally -
        # this only needs it reliable for nodes created here).
        cli_key=cli_key,
    )
    changes = await _leaf_content_changes(out_dir, cli_key, kb_index)
    return dataclass_replace(node, **changes) if changes else node


async def _sync_source_chunk_counts(
    project: Project, kb_index: dict[str, Any], source_repository: SourceRepository
) -> None:
    counts: dict[str, int] = {}
    for chunk in kb_index.get("chunks") or []:
        source_id = Path(str(chunk.get("source_path", ""))).parent.name
        counts[source_id] = counts.get(source_id, 0) + 1

    for source in await source_repository.list_all(project.id):
        count = counts.get(str(source.id), 0)
        status = SourceStatus.indexed if count > 0 else SourceStatus.error
        if source.chunks_count != count or source.status != status:
            await source_repository.update(
                dataclass_replace(source, chunks_count=count, status=status)
            )


async def import_graph(
    project: Project,
    work_dir: Path,
    outline_repository: OutlineRepository,
    source_repository: SourceRepository,
    *,
    outline_mode: Literal["project", "generate"] = "project",
) -> None:
    out_dir = work_dir / OUT_DIRNAME
    data = await _load_json(out_dir / "structure_graph.json")
    if data is None:
        return

    nodes_json: dict[str, dict[str, Any]] = data.get("nodes") or {}
    children_by_parent: dict[str, list[str]] = {}
    for edge in data.get("edges") or []:
        if len(edge) != 2:
            continue
        parent, child = edge
        children_by_parent.setdefault(parent, []).append(child)

    kb_index = await _load_json(out_dir / "kb_sources.json")
    now = datetime.now(timezone.utc)

    if outline_mode == "generate":
        await _replace_outline_from_cli_graph(
            project, nodes_json, children_by_parent, out_dir, kb_index, outline_repository, now
        )
    else:
        await _merge_cli_graph_into_outline(
            project, nodes_json, children_by_parent, out_dir, kb_index, outline_repository, now
        )

    if kb_index is not None:
        await _sync_source_chunk_counts(project, kb_index, source_repository)


async def _merge_cli_graph_into_outline(
    project: Project,
    nodes_json: dict[str, dict[str, Any]],
    children_by_parent: dict[str, list[str]],
    out_dir: Path,
    kb_index: dict[str, Any] | None,
    outline_repository: OutlineRepository,
    now: datetime,
) -> None:
    """`outline="project"`: the CLI structured this run from the project's
    own outline (`GenerationService._prepare_work_dir` only writes
    `book_structure.json` in this mode), so its keys line up with the
    outline's current tree shape - match by recomputed `cli_key` and update
    matched rows in place, inserting only the nodes the CLI subdivided on
    its own."""
    flat = await outline_repository.list(project.id)
    positioned = assign_positions(flat)
    by_cli_key = {node.cli_key: node for node in positioned if node.cli_key}
    next_order_by_parent: dict[uuid.UUID | None, int] = {}
    for node in positioned:
        next_order_by_parent[node.parent_id] = max(
            next_order_by_parent.get(node.parent_id, -1), node.order_index
        ) + 1

    async def walk(cli_key: str, parent_id: uuid.UUID | None) -> uuid.UUID:
        cli_node = nodes_json.get(cli_key) or {}
        node = by_cli_key.get(cli_key)
        if node is not None:
            changes = await _matched_node_changes(node, cli_node, out_dir, cli_key, kb_index)
            if changes:
                await outline_repository.update(
                    dataclass_replace(node, **changes, updated_at=now)
                )
            node_id = node.id
        else:
            order_index = next_order_by_parent.get(parent_id, 0)
            next_order_by_parent[parent_id] = order_index + 1
            new_node = await _new_node(
                project, cli_node, parent_id, cli_key, out_dir, kb_index, order_index, now
            )
            created = await outline_repository.add(new_node)
            node_id = created.id

        for child_key in children_by_parent.get(cli_key, []):
            await walk(child_key, node_id)
        return node_id

    for root_key in children_by_parent.get("book", []):
        await walk(root_key, None)


async def _replace_outline_from_cli_graph(
    project: Project,
    nodes_json: dict[str, dict[str, Any]],
    children_by_parent: dict[str, list[str]],
    out_dir: Path,
    kb_index: dict[str, Any] | None,
    outline_repository: OutlineRepository,
    now: datetime,
) -> None:
    """`outline="generate"`: the CLI structured this run entirely on its
    own (no project outline was ever sent to it), so its keys have no
    relationship to whatever the project's outline currently holds -
    matching by recomputed positional `cli_key` here would silently
    overwrite unrelated, possibly user-authored nodes (issue #65). Replace
    the whole outline instead, the same soft-delete-and-recreate `PUT
    /outline` already uses, so the previous outline stays recoverable in
    the database rather than merged/clobbered in place."""
    flat_nodes: list[OutlineNode] = []

    async def build(cli_key: str, parent_id: uuid.UUID | None, order_index: int) -> None:
        cli_node = nodes_json.get(cli_key) or {}
        node = await _new_node(
            project, cli_node, parent_id, cli_key, out_dir, kb_index, order_index, now
        )
        flat_nodes.append(node)
        for index, child_key in enumerate(children_by_parent.get(cli_key, [])):
            await build(child_key, node.id, index)

    for index, root_key in enumerate(children_by_parent.get("book", [])):
        await build(root_key, None, index)

    await outline_repository.replace_all(project.id, flat_nodes)


async def import_single_node(
    project: Project,
    work_dir: Path,
    node_id: uuid.UUID,
    outline_repository: OutlineRepository,
) -> bool:
    """Sync-back for a succeeded `regenerate_section` run (issue #11) - unlike
    `import_graph`, touches only the one node that was regenerated. A
    `--resume` run leaves every other leaf's `sections/<key>.md` untouched,
    so walking the whole graph here (as `import_graph` does) would needlessly
    bump every other node's `updated_at`.

    Deliberately does not propagate `title`/`summary` from the CLI node back
    onto the outline row the way `import_graph`'s `_matched_node_changes`
    does: this run's own `structure_graph.json` had its `summary` rewritten
    with the prompt modifier before the CLI ran (`GenerationService.
    _prepare_regenerate`), and echoing that back would permanently bake the
    modifier text into the node's real summary.

    Returns whether any content change was actually applied, so the caller
    (`GenerationService._import_target_node`) can revert the node's status
    when a "succeeded" run produced nothing to import - e.g. `sections/
    <cli_key>.md` never existed because the target was a non-leaf (issue
    #77; blocked at `RunService.regenerate_node` for new runs, kept here as
    a backstop for a run created before that check existed).
    """
    out_dir = work_dir / OUT_DIRNAME
    data = await _load_json(out_dir / "structure_graph.json")
    if data is None:
        return False

    flat = await outline_repository.list(project.id)
    positioned = {node.id: node for node in assign_positions(flat)}
    node = positioned.get(node_id)
    if node is None or not node.cli_key:
        return False

    kb_index = await _load_json(out_dir / "kb_sources.json")
    changes = await _leaf_content_changes(out_dir, node.cli_key, kb_index)
    if not changes:
        return False
    await outline_repository.update(
        dataclass_replace(node, **changes, updated_at=datetime.now(timezone.utc))
    )
    return True
