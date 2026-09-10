"""Flatten a run's structure_graph.json into one file with every node's content.

Leaf nodes: full generated text (from content_file_path).
Non-leaf nodes (chapters/sections/parts): title + summary only, since
book_builder.py only ever generates LLM content for leaf nodes.

Usage:
    python scripts/dump_all_node_content.py output/book/out_book/structure_graph.json > full_outline.md
"""

import json
import sys
from pathlib import Path


def get_depth(node_key: str) -> int:
    return 0 if node_key == "book" else node_key.count("-") + 1


def sort_key(node_key: str):
    return [] if node_key == "book" else [int(p) for p in node_key.split("-")]


def resolve_section_file(graph_path: Path, content_file_path: str) -> Path | None:
    """content_file_path in structure_graph.json is an absolute path recorded at
    generation time, which may not exist on this machine (different host/run_dir,
    or a Windows path read on Linux). Fall back to <graph_dir>/sections/<basename>."""
    recorded = Path(content_file_path)
    if recorded.is_file():
        return recorded
    basename = content_file_path.replace("\\", "/").rsplit("/", 1)[-1]
    fallback = graph_path.parent / "sections" / basename
    return fallback if fallback.is_file() else None


def main() -> None:
    graph_path = Path(sys.argv[1])
    data = json.loads(graph_path.read_text(encoding="utf-8"))
    nodes: dict[str, dict] = data["nodes"]

    children: dict[str, list[str]] = {}
    for src, dst in data["edges"]:
        children.setdefault(src, []).append(dst)
    for kids in children.values():
        kids.sort(key=sort_key)

    def walk(node_key: str) -> None:
        attrs = nodes[node_key]
        depth = get_depth(node_key)
        heading = "#" * min(6, depth + 1)
        print(f"{heading} {attrs.get('title', node_key)}")
        print()

        content_path = attrs.get("content_file_path")
        section_file = resolve_section_file(graph_path, content_path) if content_path else None
        if section_file:
            print(section_file.read_text(encoding="utf-8").strip())
        elif attrs.get("summary"):
            print(f"_[outline only, not generated]_ {attrs['summary']}")
        else:
            print("_[outline only, not generated]_")
        print()

        for child in children.get(node_key, []):
            walk(child)

    for top in children.get("book", []):
        walk(top)


if __name__ == "__main__":
    main()
