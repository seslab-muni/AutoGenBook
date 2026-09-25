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
        project: Project, outline_tree: list[OutlineTree], *, lock_nodes: bool
    ) -> dict[str, Any]:
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
                StructureBuilder._build_node(tree, lock_nodes) for tree in outline_tree
            ],
        }

    @staticmethod
    def _build_node(tree: OutlineTree, lock_nodes: bool) -> dict[str, Any]:
        child_dicts = [
            StructureBuilder._build_node(child, lock_nodes) for child in tree.children
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
        out.update(kb_scope_fields(tree.node))
        return out


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
