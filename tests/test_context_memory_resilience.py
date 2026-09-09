import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import book_builder
from autogenbook.prompts.book_loader import load_book_prompts
from autogenbook.prompts.registry import set_prompt_registry


WRITER_RESPONSE = "```md\nSection body line one.\nSection body line two.\n```"

# Deliberately malformed: valid JSON, but with extra top-level keys that don't
# belong on ContextMemoryUpdateOutput (mirrors a real failure seen in production,
# where the model leaked a TermAdded object's fields onto the root object).
MALFORMED_MEMORY_RESPONSE = """
{
  "terms_added": [],
  "terms_updated": [],
  "citations_used": [],
  "open_threads": [],
  "consistency_flags": [],
  "retrieval_queries": [],
  "term": "stray term",
  "definition": "stray definition",
  "first_seen_node": "1"
}
"""


class DummyLLM:
    """Returns a queued response per llm.chat() call, in order."""

    def __init__(self, chat_responses):
        self.config = SimpleNamespace(model="dummy-model", temperature=0.0)
        self._chat_responses = list(chat_responses)

    def chat(self, messages, model=None, temperature=None, max_tokens=None, allow_tools=False):
        return self._chat_responses.pop(0)

    def chat_json_object(self, messages, model=None, temperature=None):
        # Repair attempts keep returning the same malformed shape, matching the
        # production incident where two repair passes did not fix the output.
        import json

        return json.loads(MALFORMED_MEMORY_RESPONSE)

    def get_last_usage(self):
        return {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}


class ContextMemoryResilienceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        set_prompt_registry("book", load_book_prompts(content_format="markdown"))

    def test_generate_contents_survives_unrepairable_context_memory_output(self):
        book_json = {
            "title": "Book",
            "summary": "Summary",
            "childs": [
                {
                    "title": "Intro",
                    "summary": "Intro summary",
                    "n_pages": 0.05,
                    "needsSubdivision": False,
                }
            ],
        }
        graph = book_builder.build_graph_from_book_json(book_json)

        llm = DummyLLM(
            [
                WRITER_RESPONSE,  # book_section_writer
                MALFORMED_MEMORY_RESPONSE,  # context_memory initial attempt
            ]
        )
        cfg = book_builder.AppConfig(
            content_format="markdown",
            do_consider_outline=False,
            do_consider_previous_sections=False,
            enable_section_review=False,
        )

        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp)
            with patch.object(
                book_builder,
                "enforce_section_length",
                lambda llm, tex, **kwargs: (tex, None),
            ):
                book_builder.generate_contents(llm, graph, out_dir, kb=None, cfg=cfg)

            section_path = out_dir / "sections" / "1.md"
            self.assertTrue(section_path.exists())
            self.assertIn("Section body line one.", section_path.read_text(encoding="utf-8"))

            memory_path = out_dir / "context_memory.json"
            memory = book_builder.ContextMemory.load(memory_path) if memory_path.exists() else book_builder.ContextMemory()
            self.assertEqual(memory.terms, {})


if __name__ == "__main__":
    unittest.main()
