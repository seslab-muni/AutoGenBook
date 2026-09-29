"""book_input.txt parsing, book_structure.json normalisation, DocGraph (#151)."""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

from engine.graph import DocGraph, child_key, depth_of, sort_keys
from engine.spec import detect_language, graph_from_structure, normalize_structure, parse_book_txt

REPO = Path(__file__).resolve().parents[2]

API_STYLE_TXT = """Title: Signals and Systems
Summary: An introduction. Covers transforms.
Target readers: undergraduate students
Total pages: 12.5
Additional requirements: Use SI units.

## Foundations (4 pages)
- What a signal is
- Writing instructions: Math level: rigorous. Equation density: 3/5.

### Sampling (1.5 pages)
- Nyquist rate

## Transforms (8.5 pages)
- Fourier and Laplace
"""


def test_parses_the_api_rendered_spec() -> None:
    spec = parse_book_txt(API_STYLE_TXT)
    assert spec.title == "Signals and Systems"
    assert spec.summary == "An introduction. Covers transforms."
    assert spec.target_readers == "undergraduate students"
    assert spec.total_pages == 12.5
    assert spec.additional_requirements == "Use SI units."
    assert [n.title for n in spec.outline] == ["Foundations", "Transforms"]
    first = spec.outline[0]
    assert first.n_pages == 4 and [c.title for c in first.children] == ["Sampling"]
    assert "Writing instructions: Math level: rigorous." in first.summary
    structure = first.to_structure()
    assert structure["structure_locked"] is True and structure["needsSubdivision"] is True


def test_parses_the_czech_benchmark_spec() -> None:
    spec = parse_book_txt((REPO / "input/bench/cs_book/book_input.txt").read_text(encoding="utf-8"))
    assert spec.title == 'METODICKÁ PŘÍRUČKA "AI VE VÝUCE VUT"'
    assert spec.summary.startswith("Vytvoř učebnici")
    assert len(spec.outline) == 10
    assert spec.outline[0].title == "ÚVOD DO AI PRO PEDAGOGY" and spec.outline[0].n_pages == 10
    assert spec.outline[0].children[0].title == "Co je generativní AI?"
    assert "http" not in spec.outline[0].children[0].summary
    assert detect_language(spec.raw_text) == "cs"
    assert detect_language((REPO / "input/bench/en_book/book_input.txt").read_text(encoding="utf-8")) == "en"


def test_structure_normalisation_matches_the_old_rules() -> None:
    raw = {
        "title": " T ",
        "n_pages": "20",
        "equation_frequency_level": 9,
        "max_depth": "3",
        "childs": [
            {"title": "A", "n_pages": "2,5", "needsSubdivision": "False", "content_locked": True, "content_file": "locked_sections/u.md"},
            {"title": "B", "kb_scope": "selected", "kb_sources": ["src1", " ", "src2/x.pdf"], "childs": [{"title": "B1"}]},
            {"title": "C", "kb_scope": "weird"},
            "not a node",
        ],
    }
    s = normalize_structure(raw)
    assert s.title == "T" and s.n_pages == 20 and s.equation_frequency_level == 5 and s.max_depth == 3
    a, b, c = s.childs
    assert a.n_pages == 2.5 and a.content_locked and a.structure_locked
    assert b.needsSubdivision and b.kb_sources == ["src1", "src2/x.pdf"]
    assert c.kb_scope == "inherit"
    g = graph_from_structure(s)
    assert list(g.dfs()) == ["book", "1", "2", "2-1", "3"]
    assert g.nodes["1"]["content_locked"] and g.nodes["1"]["content_file"] == "locked_sections/u.md"
    assert g.nodes["2"]["kb_scope"] == "selected" and "kb_scope" not in g.nodes["3"]


def test_keys_and_dfs_order() -> None:
    assert child_key("book", 3) == "3" and child_key("2-1", 4) == "2-1-4"
    assert depth_of("book") == 0 and depth_of("2-1-4") == 3
    assert sort_keys(["10", "2", "1-10", "1-2", "1"]) == ["1", "1-2", "1-10", "2", "10"]
    g = DocGraph.new({"title": "B"})
    for key, parent in [("1", "book"), ("2", "book"), ("1-1", "1"), ("1-2", "1"), ("10", "book")]:
        g.add_node(key, parent, {"title": key})
    data = g.to_json()
    assert list(data["nodes"]) == ["book", "1", "1-1", "1-2", "2", "10"]
    assert data["edges"][:3] == [["book", "1"], ["book", "2"], ["book", "10"]] or data["edges"][0] == ["book", "1"]
    assert g.leaves() == ["1-1", "1-2", "2", "10"]
    g.remove_subtree("1")
    assert g.leaves() == ["2", "10"] and "1-1" not in g.nodes


def test_round_trip_and_old_engine_graph_tolerance(tmp_path: Path) -> None:
    old = DocGraph.load(REPO / "output/book/structure_graph.json")
    node = old.nodes["1-1"]
    assert node["n_pages"] == 1.2 and node["needsSubdivision"] is False  # strings coerced
    assert len(old.leaves()) == 100
    path = tmp_path / "structure_graph.json"
    old.save(path)
    again = DocGraph.load(path)
    assert again.to_json() == old.to_json()
    old.attrs["x"] = 1
    old.save(path)
    assert (tmp_path / "structure_graph.json.bak").exists()
    assert json.loads(path.read_text(encoding="utf-8"))["graph"]["x"] == 1


def test_atomic_writes_are_never_seen_half_written(tmp_path: Path) -> None:
    g = DocGraph.new({"title": "B"})
    for i in range(1, 300):
        g.add_node(str(i), "book", {"title": f"node {i}", "summary": "x" * 200})
    path = tmp_path / "structure_graph.json"
    g.save(path)
    stop = threading.Event()
    bad: list[str] = []

    def poll() -> None:
        while not stop.is_set():
            try:
                json.loads(path.read_text(encoding="utf-8"))
            except ValueError as exc:
                bad.append(str(exc))

    thread = threading.Thread(target=poll)
    thread.start()
    for i in range(40):
        g.nodes["1"]["summary"] = str(i) * 50
        g.save(path)
    time.sleep(0.05)
    stop.set()
    thread.join()
    assert bad == []
