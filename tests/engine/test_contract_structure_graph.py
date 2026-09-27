"""Contract 3.4: out/structure_graph.json."""

from __future__ import annotations

import hashlib
import json
import re
import threading
from pathlib import Path

from fake_llm import FakeLLM
from helpers import api_run, make_work_dir, project_structure, write_project

KEY_RE = re.compile(r"^\d+(?:-\d+)*$")


def _dfs(edges: list[list[str]]) -> list[str]:
    children: dict[str, list[str]] = {}
    for parent, child in edges:
        children.setdefault(parent, []).append(child)
    order = ["book"]

    def walk(key: str) -> None:
        for child in children.get(key, []):
            order.append(child)
            walk(child)

    walk("book")
    return order


def test_shape_graph_nodes_edges(tmp_path: Path) -> None:
    """`{graph, nodes, edges}`; graph.input_sha256/input_path; edges are [parent, child] rooted at 'book'."""
    work = make_work_dir(tmp_path)
    run = api_run(work, FakeLLM(), outline="generate")
    assert run.exit_code == 0, run.text
    data = run.graph()
    assert set(data) == {"graph", "nodes", "edges"}
    assert data["graph"]["input_sha256"] == hashlib.sha256((work / "book_input.txt").read_bytes()).hexdigest()
    assert data["graph"]["input_path"] == str((work / "book_input.txt").resolve())
    assert "book" in data["nodes"]
    nodes = set(data["nodes"])
    for edge in data["edges"]:
        assert isinstance(edge, list) and len(edge) == 2 and edge[0] in nodes and edge[1] in nodes
    assert {child for _p, child in data["edges"]} == nodes - {"book"}
    assert any(parent == "book" for parent, _c in data["edges"])


def test_keys_are_dfs_ordered_dash_paths(tmp_path: Path) -> None:
    """Node keys `book`, `1`, `1-2`, ... in DFS order."""
    work = make_work_dir(tmp_path)
    run = api_run(work, FakeLLM(), outline="generate")
    data = run.graph()
    keys = list(data["nodes"])
    assert keys == _dfs(data["edges"])
    for parent, child in data["edges"]:
        assert KEY_RE.match(child)
        if parent == "book":
            assert "-" not in child
        else:
            assert child.startswith(parent + "-") and child.count("-") == parent.count("-") + 1
    top = [c for p, c in data["edges"] if p == "book"]
    assert top == [str(i) for i in range(1, len(top) + 1)]


def test_node_fields_the_api_reads(tmp_path: Path) -> None:
    """title/summary/n_pages/content_file_path/kb_scope/kb_sources/content_locked/structure_locked/content_file survive."""
    work = make_work_dir(tmp_path)
    locked_rel = "locked_sections/1234.md"
    write_project(work, project_structure(locked_file=locked_rel), {locked_rel: "Curated ENIAC text.\n"})
    run = api_run(work, FakeLLM(), outline="project")
    assert run.exit_code == 0, run.text
    nodes = run.graph()["nodes"]
    assert nodes["1"]["title"] == "Mechanical calculation"
    assert nodes["1-1"]["summary"].endswith("Writing instructions: Math level: intuitive. Equation density: 2/5.")
    assert nodes["1-1"]["kb_scope"] == "selected" and nodes["1-1"]["kb_sources"] == ["mechanical-computing"]
    assert nodes["2"]["kb_scope"] == "all"
    assert nodes["2-1"]["content_locked"] is True and nodes["2-1"]["structure_locked"] is True
    assert nodes["2-1"]["content_file"] == locked_rel
    for key in ("1-1", "1-2", "2-1", "2-2"):
        assert isinstance(nodes[key]["n_pages"], float)
        assert nodes[key]["content_file_path"]


def test_content_file_path_is_set_only_when_the_section_exists(tmp_path: Path) -> None:
    """Absolute path, set after `sections/<key>.md` is written."""
    work = make_work_dir(tmp_path)
    graph_path = work / "out" / "structure_graph.json"
    violations: list[str] = []
    stop = threading.Event()

    def watch() -> None:
        while not stop.is_set():
            try:
                data = json.loads(graph_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            for key, attrs in data.get("nodes", {}).items():
                path = attrs.get("content_file_path")
                if path and not Path(path).is_file():
                    violations.append(key)

    thread = threading.Thread(target=watch, daemon=True)
    thread.start()
    run = api_run(work, FakeLLM(latency_s=0.005), outline="generate")
    stop.set()
    thread.join()
    assert run.exit_code == 0 and violations == []
    data = run.graph()
    parents = {p for p, _c in data["edges"]}
    for key, attrs in data["nodes"].items():
        if key == "book" or key in parents:
            assert not attrs.get("content_file_path")
        else:
            path = Path(attrs["content_file_path"])
            assert path.is_absolute() and path == (work / "out" / "sections" / f"{key}.md").resolve()


def test_writes_are_atomic_while_polled(tmp_path: Path) -> None:
    """A poller reading once per ms never sees invalid JSON."""
    work = make_work_dir(tmp_path)
    graph_path = work / "out" / "structure_graph.json"
    errors: list[str] = []
    reads = [0]
    stop = threading.Event()

    def poll() -> None:
        while not stop.is_set():
            try:
                text = graph_path.read_text(encoding="utf-8")
            except OSError:
                continue
            reads[0] += 1
            try:
                json.loads(text)
            except ValueError as exc:
                errors.append(str(exc))
            stop.wait(0.001)

    thread = threading.Thread(target=poll, daemon=True)
    thread.start()
    run = api_run(work, FakeLLM(latency_s=0.002), outline="generate")
    stop.set()
    thread.join()
    assert run.exit_code == 0
    assert reads[0] > 10 and errors == []
