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
from typing import Any

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


def _load_json(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


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


def _load_section_review(out_dir: Path, cli_key: str) -> dict[str, Any] | None:
    reviews_dir = out_dir / "section_reviews"
    for name in (f"{cli_key}_revised.json", f"{cli_key}.json"):
        data = _load_json(reviews_dir / name)
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


def _leaf_content_changes(
    out_dir: Path, cli_key: str, kb_index: dict[str, Any] | None
) -> dict[str, Any]:
    content_path = out_dir / "sections" / f"{cli_key}.md"
    if not content_path.is_file():
        return {}
    content = content_path.read_text(encoding="utf-8")
    changes: dict[str, Any] = {
        "content_markdown": content,
        "actual_words": len(content.split()),
        "status": NodeStatus.COMPILED,
    }
    if kb_index is not None:
        changes["rag_citations"] = _extract_citations(content, kb_index)
    review = _load_section_review(out_dir, cli_key)
    if review:
        if "notes" in review:
            changes["reviewer_notes"] = review["notes"]
        if "score" in review:
            changes["reviewer_score"] = review["score"]
    return changes


def _matched_node_changes(
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
    changes.update(_leaf_content_changes(out_dir, cli_key, kb_index))
    return changes


def _new_node(
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
    )
    changes = _leaf_content_changes(out_dir, cli_key, kb_index)
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
) -> None:
    out_dir = work_dir / OUT_DIRNAME
    data = _load_json(out_dir / "structure_graph.json")
    if data is None:
        return

    nodes_json: dict[str, dict[str, Any]] = data.get("nodes") or {}
    children_by_parent: dict[str, list[str]] = {}
    for edge in data.get("edges") or []:
        if len(edge) != 2:
            continue
        parent, child = edge
        children_by_parent.setdefault(parent, []).append(child)

    kb_index = _load_json(out_dir / "kb_sources.json")

    flat = await outline_repository.list(project.id)
    positioned = assign_positions(flat)
    by_cli_key = {node.cli_key: node for node in positioned if node.cli_key}
    next_order_by_parent: dict[uuid.UUID | None, int] = {}
    for node in positioned:
        next_order_by_parent[node.parent_id] = max(
            next_order_by_parent.get(node.parent_id, -1), node.order_index
        ) + 1

    now = datetime.now(timezone.utc)

    async def walk(cli_key: str, parent_id: uuid.UUID | None) -> uuid.UUID:
        cli_node = nodes_json.get(cli_key) or {}
        node = by_cli_key.get(cli_key)
        if node is not None:
            changes = _matched_node_changes(node, cli_node, out_dir, cli_key, kb_index)
            if changes:
                await outline_repository.update(
                    dataclass_replace(node, **changes, updated_at=now)
                )
            node_id = node.id
        else:
            order_index = next_order_by_parent.get(parent_id, 0)
            next_order_by_parent[parent_id] = order_index + 1
            created = await outline_repository.add(
                _new_node(project, cli_node, parent_id, cli_key, out_dir, kb_index, order_index, now)
            )
            node_id = created.id

        for child_key in children_by_parent.get(cli_key, []):
            await walk(child_key, node_id)
        return node_id

    for root_key in children_by_parent.get("book", []):
        await walk(root_key, None)

    if kb_index is not None:
        await _sync_source_chunk_counts(project, kb_index, source_repository)


async def import_single_node(
    project: Project,
    work_dir: Path,
    node_id: uuid.UUID,
    outline_repository: OutlineRepository,
) -> None:
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
    """
    out_dir = work_dir / OUT_DIRNAME
    data = _load_json(out_dir / "structure_graph.json")
    if data is None:
        return

    flat = await outline_repository.list(project.id)
    positioned = {node.id: node for node in assign_positions(flat)}
    node = positioned.get(node_id)
    if node is None or not node.cli_key:
        return

    kb_index = _load_json(out_dir / "kb_sources.json")
    changes = _leaf_content_changes(out_dir, node.cli_key, kb_index)
    if changes:
        await outline_repository.update(
            dataclass_replace(node, **changes, updated_at=datetime.now(timezone.utc))
        )
