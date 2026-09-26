"""Renders a project + its outline into the two shapes the CLI's book mode
accepts as input (issue #7), consumed by `api.infrastructure.cli.book_command`
(issue #8) depending on `RunOptions.outline`:

- `SpecRenderer.render` builds the TXT read with `--use-txt`: an LLM turns it
  into a `book_structure.json`-shaped dict, *unless* it contains outline
  headings, in which case the CLI's own
  `book_builder.py:_extract_explicit_outline_from_txt` parses them verbatim
  and the LLM's structure is discarded for `childs`. Heading shape therefore
  has to match that function's regexes: `^(#{2,6})\\s+(.+?)\\s*$` for headings,
  `\\((?:~\\s*)?N\\s*pages?\\)\\s*$` for the trailing page hint.
- `StructureBuilder.build` builds the `book_structure.json` dict directly,
  read with `-j book_structure.json --use-json`, bypassing the LLM
  structuring step entirely.

Both mirror the field defaults/shape of `book_builder.py:_normalize_book_json`
/ `_normalize_book_child` (repo root) so a payload built here needs no further
massaging by the CLI. Output is deterministic (stable child ordering, no
wall-clock/random data) because the CLI hashes the rendered TXT for `--resume`.
"""

from __future__ import annotations

from typing import Any

from api.domain.models import OutlineNode, Project, SourceScope, TargetAudience
from api.domain.outline import OutlineTree

_AUDIENCE_PHRASES: dict[TargetAudience, str] = {
    TargetAudience.UNDERGRADUATE: "undergraduate students",
    TargetAudience.GRADUATE: "graduate students",
    TargetAudience.PHD_RESEARCHER: "PhD students and researchers",
    TargetAudience.INDUSTRY_PRACTITIONER: "industry practitioners",
}


def audience_phrase(audience: TargetAudience) -> str:
    return _AUDIENCE_PHRASES[audience]


def _project_summary(project: Project) -> str:
    """`topic`, with `subtitle` prepended as its first sentence."""
    subtitle = project.subtitle.strip()
    if subtitle and not subtitle.endswith((".", "!", "?")):
        subtitle = f"{subtitle}."
    return " ".join(part for part in (subtitle, project.topic.strip()) if part)


def _writing_instructions(node: OutlineNode) -> str:
    """`subPrompt`, `mathLevel`, `equationDensityLevel` folded into the one
    paragraph the writer agent reads as its brief, alongside `summary`."""
    parts: list[str] = []
    if node.sub_prompt and node.sub_prompt.strip():
        parts.append(node.sub_prompt.strip())
    parts.append(f"Math level: {node.math_level.value}.")
    parts.append(f"Equation density: {node.equation_density_level}/5.")
    return "Writing instructions: " + " ".join(parts)


def _node_summary(node: OutlineNode) -> str:
    summary = (node.summary or "").strip()
    instructions = _writing_instructions(node)
    return f"{summary}\n\n{instructions}" if summary else instructions


def _format_pages(value: float) -> str:
    number = float(value)
    return str(int(number)) if number.is_integer() else f"{number:.1f}"


class SpecRenderer:
    """Deterministic TXT rendering of a project (+ optional outline) for the
    CLI's `--use-txt` book-mode input."""

    @staticmethod
    def render(
        project: Project, outline_tree: list[OutlineTree], *, include_outline: bool
    ) -> str:
        header = SpecRenderer._render_header(project)
        if not include_outline or not outline_tree:
            return header + "\n"
        return header + "\n\n" + SpecRenderer._render_nodes(outline_tree) + "\n"

    @staticmethod
    def _render_header(project: Project) -> str:
        lines = [
            f"Title: {project.title.strip()}",
            f"Summary: {_project_summary(project)}",
            f"Target readers: {audience_phrase(project.target_audience)}",
            f"Total pages: {_format_pages(project.total_pages_budget)}",
        ]
        if project.additional_requirements and project.additional_requirements.strip():
            lines.append(
                f"Additional requirements: {project.additional_requirements.strip()}"
            )
        return "\n".join(lines)

    @staticmethod
    def _render_nodes(trees: list[OutlineTree]) -> str:
        return "\n\n".join(SpecRenderer._render_node(tree) for tree in trees)

    @staticmethod
    def _render_node(tree: OutlineTree) -> str:
        node = tree.node
        heading = "#" * min(max(node.level + 1, 2), 6)
        lines = [f"{heading} {node.title.strip()} ({_format_pages(node.target_pages)} pages)"]
        lines.extend(
            f"- {bullet}"
            for bullet in _node_summary(node).splitlines()
            if bullet.strip()
        )
        block = "\n".join(lines)
        child_blocks = [SpecRenderer._render_node(child) for child in tree.children]
        return block + "\n\n" + "\n\n".join(child_blocks) if child_blocks else block


class StructureBuilder:
    """Builds the CLI's `book_structure.json`-shaped dict directly from a
    project + its outline tree, for `--use-json` runs (no LLM structuring
    step)."""

    @staticmethod
    def build(
        project: Project,
        outline_tree: list[OutlineTree],
        *,
        lock_nodes: bool,
        include_locked_content: bool = False,
    ) -> dict[str, Any]:
        """`include_locked_content` (issue #113) makes a content-locked leaf
        emit `content_locked`/`content_file` pointing at the file
        `locked_section_files` names, for a run whose work dir actually
        holds those files. `GET /projects/{id}/spec?format=json` keeps the
        default - a downloaded spec has no content files to point at."""
        return {
            "title": project.title.strip(),
            "summary": _project_summary(project),
            "n_pages": float(project.total_pages_budget),
            "target_readers": audience_phrase(project.target_audience),
            "equation_frequency_level": project.equation_frequency_level,
            "do_consider_outline": project.do_consider_outline,
            "do_consider_previous_sections": project.do_consider_previous_sections,
            "additional_requirements": (project.additional_requirements or "").strip(),
            "max_depth": project.max_outline_levels,
            "max_output_pages": 1.5,
            "childs": [
                StructureBuilder._build_node(tree, lock_nodes, include_locked_content)
                for tree in outline_tree
            ],
        }

    @staticmethod
    def _build_node(
        tree: OutlineTree, lock_nodes: bool, include_locked_content: bool = False
    ) -> dict[str, Any]:
        child_dicts = [
            StructureBuilder._build_node(child, lock_nodes, include_locked_content)
            for child in tree.children
        ]
        out: dict[str, Any] = {
            "title": tree.node.title.strip(),
            "summary": _node_summary(tree.node),
            "n_pages": float(tree.node.target_pages),
            "needsSubdivision": bool(child_dicts),
        }
        if child_dicts:
            out["childs"] = child_dicts
        if lock_nodes:
            out["structure_locked"] = True
        if include_locked_content and not child_dicts and _has_locked_content(tree.node):
            # The CLI keeps this leaf byte-for-byte (`book_builder.py:
            # generate_contents`). `content_locked` implies
            # `structure_locked` CLI-side too, but say so explicitly so the
            # written JSON is self-describing. Keyed by the node's UUID, not
            # its positional `cli_key` - no key agreement between API and
            # CLI is needed anywhere for this.
            out["content_locked"] = True
            out["structure_locked"] = True
            out["content_file"] = locked_section_path(tree.node)
        out.update(kb_scope_fields(tree.node))
        return out


# Where `GenerationService._write_work_dir_sync` puts a content-locked leaf's
# text inside the run's `out/` dir; `content_file` in `book_structure.json`
# is relative to `out_dir`, exactly like a relative `-j` (issue #113).
LOCKED_SECTIONS_DIRNAME = "locked_sections"


def _has_locked_content(node: OutlineNode) -> bool:
    return bool(node.content_locked) and bool((node.content_markdown or "").strip())


def locked_section_path(node: OutlineNode) -> str:
    return f"{LOCKED_SECTIONS_DIRNAME}/{node.id}.md"


def locked_section_files(outline_tree: list[OutlineTree]) -> dict[str, str]:
    """`{relative path under out_dir: content_markdown}` for every
    content-locked leaf of `outline_tree` - the files
    `StructureBuilder.build(..., include_locked_content=True)`'s
    `content_file` entries point at (issue #113)."""
    files: dict[str, str] = {}

    def walk(trees: list[OutlineTree]) -> None:
        for tree in trees:
            if tree.children:
                walk(tree.children)
            elif _has_locked_content(tree.node):
                files[locked_section_path(tree.node)] = tree.node.content_markdown

    walk(outline_tree)
    return files


def kb_scope_fields(node: OutlineNode) -> dict[str, Any]:
    """The CLI's `kb_scope`/`kb_sources` node fields for `node` (issue #138).

    `kb_sources` are paths relative to `--kb-dir`; `GenerationService.
    _download_sources` puts each source under `kb/<source.id>/`, so a
    source's id is its directory. `inherit` (the default) emits nothing."""
    if node.source_scope == SourceScope.ALL:
        return {"kb_scope": "all"}
    if node.source_scope == SourceScope.SELECTED:
        return {"kb_scope": "selected", "kb_sources": [str(sid) for sid in node.source_ids]}
    return {}


def sync_content_locks_into_graph(
    graph_data: dict[str, Any], nodes: list[OutlineNode]
) -> tuple[bool, dict[str, str], list[str]]:
    """Overwrite `content_locked`/`content_file` on a CLI `structure_graph.
    json` payload's nodes from the outline's *current* locks, matched by
    `cli_key` (issue #113) - the lock-side twin of `sync_kb_scopes_into_graph`
    for runs that reuse a base run's graph (`regenerate`, retry). Without it
    a node unlocked (or locked, or edited while locked) after the base run
    would keep the base run's stale flag and file, and `book_builder.py`'s
    lock check runs *ahead* of its `--resume` skip, so an unlocked node's
    regenerate would silently re-copy the old text.

    Returns `(changed, files, stale)`: `files` maps out_dir-relative paths
    to the locked text that must be on disk for the flags just set (always
    rewritten, so an edit made while locked is what the run sees), `stale`
    lists files a now-unlocked node used to point at, to delete."""
    graph_nodes = graph_data.get("nodes") or {}
    parents = {node.parent_id for node in nodes if node.parent_id is not None}
    changed = False
    files: dict[str, str] = {}
    stale: list[str] = []
    for node in nodes:
        if not node.cli_key:
            continue
        cli_node = graph_nodes.get(node.cli_key)
        if not isinstance(cli_node, dict):
            continue
        previous_file = str(cli_node.get("content_file") or "")
        if _has_locked_content(node) and node.id not in parents:
            path = locked_section_path(node)
            files[path] = node.content_markdown
            if cli_node.get("content_locked") is not True or previous_file != path:
                cli_node["content_locked"] = True
                cli_node["structure_locked"] = True
                cli_node["content_file"] = path
                changed = True
        elif "content_locked" in cli_node or "content_file" in cli_node:
            cli_node.pop("content_locked", None)
            cli_node.pop("content_file", None)
            if previous_file:
                stale.append(previous_file)
            changed = True
    return changed, files, stale


def sync_kb_scopes_into_graph(graph_data: dict[str, Any], nodes: list[OutlineNode]) -> bool:
    """Overwrite `kb_scope`/`kb_sources` on a CLI `structure_graph.json`
    payload's nodes from the outline's *current* scopes, matched by
    `cli_key` (issue #138). Runs reusing a base run's graph (`regenerate`,
    retry) otherwise keep whatever scopes were set when that base run
    started. Returns whether anything changed."""
    graph_nodes = graph_data.get("nodes") or {}
    changed = False
    for node in nodes:
        if not node.cli_key:
            continue
        cli_node = graph_nodes.get(node.cli_key)
        if not isinstance(cli_node, dict):
            continue
        wanted = kb_scope_fields(node)
        current = {key: cli_node[key] for key in ("kb_scope", "kb_sources") if key in cli_node}
        if current == wanted:
            continue
        cli_node.pop("kb_scope", None)
        cli_node.pop("kb_sources", None)
        cli_node.update(wanted)
        changed = True
    return changed
