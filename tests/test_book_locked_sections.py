"""
Content-locked sections (issue #113): a ``book_structure.json`` leaf marked ``content_locked``
with a ``content_file`` is kept byte-for-byte on a run, never handed to the writer, but still
walked through the same context bookkeeping (``ContextMemory`` + ``previous_sections``) as a
freshly generated section, so later sections know what it already covers.
"""

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import book_builder
from autogenbook.prompts.book_loader import load_book_prompts
from autogenbook.prompts.registry import set_prompt_registry


# Deliberately awkward bytes: CRLF line endings, trailing whitespace, a UTF-8 multibyte char and
# no trailing newline. "Byte-for-byte" means none of these may be normalised away.
LOCKED_ONE = "# Kept chapter\r\n\r\nStabilizer formalism, defined here first.   \r\né".encode("utf-8")
LOCKED_THREE = b"# Another kept chapter\n\nAlready written text.\n"


class DummyLLM:
    """Only constructed-against: every agent that would call it is patched out below."""

    def __init__(self):
        self.config = SimpleNamespace(model="dummy-model", temperature=0.0)

    def chat(self, *args, **kwargs):
        raise AssertionError("No agent should reach the LLM in these tests.")

    def get_last_usage(self):
        return None


class FakeWriter:
    """Records every writer call, and what context_memory.json held at that moment."""

    def __init__(self, memory_path: Path):
        self.calls = []
        self._memory_path = memory_path

    def run(self, inputs, context):
        memory_on_disk = (
            json.loads(self._memory_path.read_text(encoding="utf-8"))
            if self._memory_path.exists()
            else None
        )
        self.calls.append({"inputs": dict(inputs), "memory_on_disk": memory_on_disk})
        return f"```md\nGenerated body for {inputs['node_key']}.\n```"


class FakeMemoryAgent:
    """Adds one recognisable term per section so the flow into later prompts is observable."""

    def __init__(self):
        self.calls = []

    def run(self, inputs, context):
        self.calls.append(dict(inputs))
        key = inputs["node_key"]
        return {
            "terms_added": [{"term": f"Term-{key}", "definition": f"Defined in section {key}."}],
            "terms_updated": [],
            "citations_used": [],
            "open_threads": [],
        }


class _FailingSubdivider:
    def run(self, *_args, **_kwargs):
        raise AssertionError("A content-locked node must never be subdivided.")


def _cfg(**overrides):
    base = dict(
        content_format="markdown",
        do_consider_outline=False,
        do_consider_previous_sections=True,
        n_previous_sections=1,
        enable_section_review=False,
    )
    base.update(overrides)
    return book_builder.AppConfig(**base)


def _leaf(title, **extra):
    node = {"title": title, "summary": f"{title} summary", "n_pages": 0.05, "needsSubdivision": False}
    node.update(extra)
    return node


class ContentLockNormalizationTests(unittest.TestCase):
    def test_normalize_book_child_carries_lock_and_implies_structure_lock(self):
        out = book_builder._normalize_book_child(
            {"title": "Ch", "content_locked": "true", "content_file": "  locked_sections/abc.md  "}
        )
        self.assertTrue(out["content_locked"])
        self.assertTrue(out["structure_locked"])
        self.assertEqual(out["content_file"], "locked_sections/abc.md")

    def test_normalize_book_child_drops_absent_or_blank_lock_keys(self):
        out = book_builder._normalize_book_child({"title": "Ch", "content_locked": False, "content_file": "   "})
        self.assertNotIn("content_locked", out)
        self.assertNotIn("structure_locked", out)
        self.assertNotIn("content_file", out)

    def test_build_graph_copies_lock_attrs_and_forces_structure_lock(self):
        graph = book_builder.build_graph_from_book_json(
            {
                "title": "Book",
                "summary": "",
                "childs": [
                    _leaf("Locked", content_locked=True, content_file="locked_sections/one.md"),
                    _leaf("Plain"),
                ],
            }
        )
        self.assertTrue(graph.nodes["1"]["content_locked"])
        self.assertTrue(graph.nodes["1"]["structure_locked"])
        self.assertEqual(graph.nodes["1"]["content_file"], "locked_sections/one.md")
        self.assertNotIn("content_locked", graph.nodes["2"])
        self.assertNotIn("structure_locked", graph.nodes["2"])

    def test_subdivide_graph_never_splits_a_content_locked_leaf(self):
        graph = book_builder.build_graph_from_book_json(
            {
                "title": "Book",
                "summary": "",
                "max_output_pages": 1.5,
                "childs": [
                    # Everything about this node says "split me" except the content lock.
                    _leaf("Locked", n_pages=50.0, needsSubdivision=True, content_locked=True,
                          content_file="locked_sections/one.md"),
                ],
            }
        )
        with patch.object(book_builder, "StructureSubdividerAgent", lambda: _FailingSubdivider()):
            book_builder.subdivide_graph(llm=object(), g=graph, kb=None, rag_top_k=2, rag_max_chars_total=1000)
        self.assertEqual(set(graph.nodes), {"book", "1"})


class ContentLockGenerationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        set_prompt_registry("book", load_book_prompts(content_format="markdown"))

    def _run(self, book_json, out_dir: Path, cfg=None, progress_path=None):
        memory_path = out_dir / "context_memory.json"
        writer = FakeWriter(memory_path)
        memory_agent = FakeMemoryAgent()
        graph = book_builder.build_graph_from_book_json(book_json)
        stdout = io.StringIO()
        with (
            patch.object(book_builder, "BookSectionWriterAgent", lambda llm: writer),
            patch.object(book_builder, "ContextMemoryAgent", lambda llm: memory_agent),
            patch.object(book_builder, "enforce_section_length", lambda llm, tex, **kwargs: (tex, None)),
            contextlib.redirect_stdout(stdout),
        ):
            book_builder.generate_contents(
                DummyLLM(), graph, out_dir, kb=None, cfg=cfg or _cfg(), progress_path=progress_path
            )
        return graph, writer, memory_agent, stdout.getvalue()

    def test_locked_leaves_are_kept_verbatim_and_feed_later_sections(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp) / "out"
            (out_dir / "locked_sections").mkdir(parents=True)
            (out_dir / "locked_sections" / "one.md").write_bytes(LOCKED_ONE)
            absolute_three = Path(tmp) / "elsewhere" / "three.md"
            absolute_three.parent.mkdir()
            absolute_three.write_bytes(LOCKED_THREE)

            book_json = {
                "title": "Book",
                "summary": "Summary",
                "childs": [
                    # Relative path -> resolved against out_dir, like -j.
                    _leaf("Kept one", content_locked=True, content_file="locked_sections/one.md"),
                    _leaf("Fresh two"),
                    # Absolute path used as-is.
                    _leaf("Kept three", content_locked=True, content_file=str(absolute_three)),
                    _leaf("Fresh four"),
                ],
            }
            progress_path = out_dir / "structure_graph.json"
            graph, writer, memory_agent, log = self._run(book_json, out_dir, progress_path=progress_path)

            # Only the unlocked leaves reach the writer, in outline order.
            self.assertEqual([c["inputs"]["node_key"] for c in writer.calls], ["2", "4"])

            # Locked files land where assembly expects them, byte-identical to the input.
            self.assertEqual((out_dir / "sections" / "1.md").read_bytes(), LOCKED_ONE)
            self.assertEqual((out_dir / "sections" / "3.md").read_bytes(), LOCKED_THREE)
            self.assertEqual(graph.nodes["1"]["content_file_path"], str(out_dir / "sections" / "1.md"))
            self.assertIn("Generated body for 2.", (out_dir / "sections" / "2.md").read_text(encoding="utf-8"))

            # Every leaf, locked or not, goes through the memory agent, in order; the locked ones
            # with their verbatim text and no fresh retrieval.
            self.assertEqual([c["node_key"] for c in memory_agent.calls], ["1", "2", "3", "4"])
            self.assertEqual(memory_agent.calls[0]["section_latex"], LOCKED_ONE.decode("utf-8"))
            self.assertEqual(memory_agent.calls[0]["retrieved_context"], "(none)")

            # Node 2's prompt was built after node 1's memory contribution was persisted, and
            # carries node 1's verbatim text as previous_sections.
            call_two = writer.calls[0]
            self.assertIn("Term-1", call_two["memory_on_disk"]["terms"])
            self.assertIn("Term-1", call_two["inputs"]["context_memory_excerpt"])
            self.assertIn(LOCKED_ONE.decode("utf-8"), call_two["inputs"]["previous_sections"])
            self.assertIn("Kept one", call_two["inputs"]["previous_sections"])

            # Same for node 4 relative to locked node 3.
            call_four = writer.calls[1]
            self.assertIn("Term-3", call_four["inputs"]["context_memory_excerpt"])
            self.assertIn(LOCKED_THREE.decode("utf-8"), call_four["inputs"]["previous_sections"])

            # The persisted memory holds every section's contribution.
            memory = json.loads((out_dir / "context_memory.json").read_text(encoding="utf-8"))
            self.assertEqual(set(memory["terms"]), {"Term-1", "Term-2", "Term-3", "Term-4"})

            # Progress graph carries the lock attrs and the content path for the API's watcher.
            progress = json.loads(progress_path.read_text(encoding="utf-8"))
            node_one = progress["nodes"]["1"]
            self.assertTrue(node_one.get("content_locked"))
            self.assertTrue(str(node_one.get("content_file_path", "")).endswith("sections/1.md"))

            # Log line the API's stdout parser already classifies as a generate/info event.
            self.assertIn("[GEN] 1/4 Locked section 'Kept one' (kept, used as context)", log)
            self.assertIn("[GEN] 3/4 Locked section 'Kept three' (kept, used as context)", log)
            self.assertNotIn("[WARN]", log)

    def test_locked_leaf_wins_over_resume_leftovers(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp)
            (out_dir / "locked_sections").mkdir()
            (out_dir / "locked_sections" / "one.md").write_bytes(LOCKED_ONE)
            (out_dir / "sections").mkdir()
            (out_dir / "sections" / "1.md").write_text("stale text from an earlier run", encoding="utf-8")

            book_json = {
                "title": "Book",
                "summary": "",
                "childs": [_leaf("Kept one", content_locked=True, content_file="locked_sections/one.md")],
            }
            with patch.object(book_builder, "BookSectionWriterAgent", lambda llm: FakeWriter(out_dir / "x")), \
                    patch.object(book_builder, "ContextMemoryAgent", lambda llm: FakeMemoryAgent()), \
                    patch.object(book_builder, "enforce_section_length", lambda llm, tex, **kw: (tex, None)), \
                    contextlib.redirect_stdout(io.StringIO()):
                graph = book_builder.build_graph_from_book_json(book_json)
                book_builder.generate_contents(DummyLLM(), graph, out_dir, kb=None, cfg=_cfg(), resume=True)

            self.assertEqual((out_dir / "sections" / "1.md").read_bytes(), LOCKED_ONE)

    def test_missing_or_blank_content_file_falls_back_to_generation(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp)
            (out_dir / "locked_sections").mkdir()
            (out_dir / "locked_sections" / "blank.md").write_bytes(b"  \n\n")

            book_json = {
                "title": "Book",
                "summary": "",
                "childs": [
                    _leaf("Gone", content_locked=True, content_file="locked_sections/does-not-exist.md"),
                    _leaf("Blank", content_locked=True, content_file="locked_sections/blank.md"),
                    _leaf("Pathless", content_locked=True),
                ],
            }
            _graph, writer, _memory_agent, log = self._run(book_json, out_dir)

            # All three are generated normally...
            self.assertEqual([c["inputs"]["node_key"] for c in writer.calls], ["1", "2", "3"])
            for key in ("1", "2", "3"):
                self.assertIn(f"Generated body for {key}.", (out_dir / "sections" / f"{key}.md").read_text(encoding="utf-8"))
            # ...and each says why.
            self.assertIn("[WARN] Section 'Gone' is content-locked but", log)
            self.assertIn("could not be read", log)
            self.assertIn("[WARN] Section 'Blank' is content-locked but", log)
            self.assertIn("is empty", log)
            self.assertIn("[WARN] Section 'Pathless' is content-locked but has no content_file", log)
            self.assertNotIn("Locked section", log)


if __name__ == "__main__":
    unittest.main()
