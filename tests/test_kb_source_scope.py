"""Per-node knowledge-base source scoping (issue #138): `kb_scope`/`kb_sources`
on outline nodes restrict which `--kb-dir` files a section retrieves from."""

import io
import unittest
import uuid
from contextlib import redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory

import book_builder
import rag_kb
from autogenbook.retrieval.manager import RetrievalManager


def _build_kb(kb_dir: Path) -> rag_kb.KnowledgeBase:
    return rag_kb.KnowledgeBase.build_from_directory(
        kb_dir,
        cache_dir=kb_dir.parent / f"kbcache_{uuid.uuid4().hex}",
        extract_cache_dir=None,
    )


class SourceFilterTests(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.kb_dir = Path(self._tmp.name) / "kb"
        # One directory per source, the layout the web app uses.
        (self.kb_dir / "src-a").mkdir(parents=True)
        (self.kb_dir / "src-b").mkdir(parents=True)
        (self.kb_dir / "src-ab").mkdir(parents=True)
        # "householder" is far more frequent in src-a, so an unfiltered top-1
        # always comes from there.
        (self.kb_dir / "src-a" / "golub.txt").write_text("householder reflections householder qr " * 30)
        (self.kb_dir / "src-b" / "trefethen.txt").write_text("householder triangularization")
        (self.kb_dir / "src-ab" / "other.txt").write_text("householder once")
        self.kb = _build_kb(self.kb_dir)

    def tearDown(self):
        self._tmp.cleanup()

    def _names(self, hits):
        return {Path(chunk.source_path).parent.name for chunk, _ in hits}

    def test_no_filter_searches_everything(self):
        hits = self.kb.retrieve("householder", k=10)
        self.assertEqual(self._names(hits), {"src-a", "src-b", "src-ab"})

    def test_filter_applies_before_top_k(self):
        accept = rag_kb.make_source_filter(self.kb_dir, ["src-b"])
        hits = self.kb.retrieve("householder", k=1, source_filter=accept)
        self.assertEqual(self._names(hits), {"src-b"})

    def test_prefix_matches_whole_segments_only(self):
        accept = rag_kb.make_source_filter(self.kb_dir, ["src-a"])
        hits = self.kb.retrieve("householder", k=10, source_filter=accept)
        self.assertEqual(self._names(hits), {"src-a"})

    def test_single_file_source(self):
        accept = rag_kb.make_source_filter(self.kb_dir, ["src-ab/other.txt"])
        hits = self.kb.retrieve("householder", k=10, source_filter=accept)
        self.assertEqual(self._names(hits), {"src-ab"})

    def test_manager_empty_selection_returns_no_kb_items(self):
        manager = RetrievalManager(local_kb=self.kb, kb_root=self.kb_dir)
        self.assertEqual(manager.retrieve("householder", kb_sources=[]), [])
        self.assertTrue(manager.retrieve("householder", kb_sources=None))

    def test_manager_requires_root_to_filter(self):
        manager = RetrievalManager(local_kb=self.kb)
        with self.assertRaises(ValueError):
            manager.retrieve("householder", kb_sources=["src-a"])


class ScopeResolutionTests(unittest.TestCase):
    def _graph(self, chapter_scope=None, section_scope=None):
        chapter = {"title": "Direct methods", "n_pages": 4, "childs": [
            {"title": "LU", "n_pages": 1},
            {"title": "QR", "n_pages": 1},
        ]}
        if chapter_scope:
            chapter.update(chapter_scope)
        if section_scope:
            chapter["childs"][1].update(section_scope)
        book = book_builder._normalize_book_json({
            "title": "NLA",
            "childs": [chapter, {"title": "Iterative", "n_pages": 2}],
        })
        return book_builder.build_graph_from_book_json(book)

    def test_default_is_unrestricted(self):
        g = self._graph()
        self.assertIsNone(book_builder.resolve_kb_sources(g, "1-1"))
        self.assertNotIn("kb_scope", g.nodes["1-1"])

    def test_section_inherits_chapter_selection(self):
        g = self._graph({"kb_scope": "selected", "kb_sources": ["src-a", " "]})
        self.assertEqual(book_builder.resolve_kb_sources(g, "1-1"), ["src-a"])
        self.assertEqual(book_builder.resolve_kb_sources(g, "1-2"), ["src-a"])
        self.assertIsNone(book_builder.resolve_kb_sources(g, "2"))

    def test_section_all_overrides_restricted_chapter(self):
        g = self._graph({"kb_scope": "selected", "kb_sources": ["src-a"]}, {"kb_scope": "all"})
        self.assertEqual(book_builder.resolve_kb_sources(g, "1-1"), ["src-a"])
        self.assertIsNone(book_builder.resolve_kb_sources(g, "1-2"))

    def test_section_own_selection_wins(self):
        g = self._graph(
            {"kb_scope": "selected", "kb_sources": ["src-a"]},
            {"kb_scope": "selected", "kb_sources": ["src-b"]},
        )
        self.assertEqual(book_builder.resolve_kb_sources(g, "1-2"), ["src-b"])

    def test_unknown_scope_falls_back_to_inherit(self):
        g = self._graph({"kb_scope": "bogus", "kb_sources": ["src-a"]})
        self.assertIsNone(book_builder.resolve_kb_sources(g, "1-1"))

    def test_subdivided_child_inherits(self):
        g = self._graph({"kb_scope": "selected", "kb_sources": ["src-a"]})
        g.add_node("1-1-1", title="Pivoting", summary="", n_pages=0.5)
        g.add_edge("1-1", "1-1-1")
        self.assertEqual(book_builder.resolve_kb_sources(g, "1-1-1"), ["src-a"])

    def test_warning_when_scoped_section_gets_no_hits(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            book_builder._warn_if_scoped_without_hits({"title": "QR"}, ["src-a"], [])
            book_builder._warn_if_scoped_without_hits({"title": "LU"}, None, [])
        out = buf.getvalue()
        self.assertIn("[WARN] Section 'QR'", out)
        self.assertIn("1 selected source;", out)
        self.assertNotIn("LU", out)


if __name__ == "__main__":
    unittest.main()
