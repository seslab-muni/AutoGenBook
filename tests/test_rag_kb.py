import json
import os
import unittest
import uuid
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

import rag_kb


class KnowledgeBaseExtractionCacheTests(unittest.TestCase):
    """`KnowledgeBase.build_from_directory`'s per-file extraction cache: keyed by file
    content (sha256), not by path, so re-extraction/OCR is skipped for a document
    that is byte-identical to one already seen, regardless of filename, directory,
    or which project/run it was attached through.
    """

    def _build(self, kb_dir: Path, extract_cache_dir, **kwargs) -> "rag_kb.KnowledgeBase":
        # A fresh, unique `cache_dir` per call isolates these tests to the extraction
        # cache: the pre-existing whole-directory pickle cache is keyed by this
        # directory's absolute path, so reusing one across calls would let it mask
        # extraction-cache behavior.
        unique_cache_dir = kb_dir.parent / f"kbcache_{uuid.uuid4().hex}"
        return rag_kb.KnowledgeBase.build_from_directory(
            kb_dir,
            cache_dir=unique_cache_dir,
            extract_cache_dir=extract_cache_dir,
            **kwargs,
        )

    def test_disabled_by_default(self):
        # Isolated from a real AUTOGENBOOK_KB_EXTRACT_CACHE_DIR possibly set in the
        # ambient shell (e.g. a developer who sourced the Docker .env) so this
        # actually exercises "disabled", not "happens to be disabled here".
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("AUTOGENBOOK_KB_EXTRACT_CACHE_DIR", None)
            with TemporaryDirectory() as tmp:
                kb_dir = Path(tmp) / "kb"
                kb_dir.mkdir()
                (kb_dir / "a.txt").write_text("hello world")
                kb = self._build(kb_dir, extract_cache_dir=None)
                self.assertEqual(len(kb.chunks), 1)

    def test_identical_content_in_different_directories_is_extracted_once(self):
        with TemporaryDirectory() as tmp:
            extract_cache_dir = Path(tmp) / "extract_cache"
            dir_a = Path(tmp) / "project_a" / "kb"
            dir_b = Path(tmp) / "project_b" / "kb"
            dir_a.mkdir(parents=True)
            dir_b.mkdir(parents=True)
            content = "The quick brown fox jumps over the lazy dog. " * 20
            (dir_a / "source1.txt").write_text(content)
            (dir_b / "renamed_completely.txt").write_text(content)  # same bytes only

            with mock.patch.object(rag_kb, "_read_txt_md", wraps=rag_kb._read_txt_md) as spy:
                self._build(dir_a, extract_cache_dir)
                self._build(dir_b, extract_cache_dir)
                self.assertEqual(spy.call_count, 1)

    def test_changed_content_is_re_extracted(self):
        with TemporaryDirectory() as tmp:
            extract_cache_dir = Path(tmp) / "extract_cache"
            kb_dir = Path(tmp) / "kb"
            kb_dir.mkdir()
            f = kb_dir / "a.txt"
            f.write_text("version one")

            with mock.patch.object(rag_kb, "_read_txt_md", wraps=rag_kb._read_txt_md) as spy:
                self._build(kb_dir, extract_cache_dir)
                f.write_text("version two, genuinely different content")
                self._build(kb_dir, extract_cache_dir)
                self.assertEqual(spy.call_count, 2)

    def test_force_rebuild_bypasses_cache_read_but_refreshes_it(self):
        with TemporaryDirectory() as tmp:
            extract_cache_dir = Path(tmp) / "extract_cache"
            kb_dir = Path(tmp) / "kb"
            kb_dir.mkdir()
            (kb_dir / "a.txt").write_text("stable content")

            with mock.patch.object(rag_kb, "_read_txt_md", wraps=rag_kb._read_txt_md) as spy:
                self._build(kb_dir, extract_cache_dir)
                self._build(kb_dir, extract_cache_dir, force_rebuild=True)
                self.assertEqual(spy.call_count, 2)
                # A normal (non-forced) build afterwards should hit the cache the
                # forced rebuild just refreshed.
                self._build(kb_dir, extract_cache_dir)
                self.assertEqual(spy.call_count, 2)

    def test_env_var_enables_cache_when_param_omitted(self):
        with TemporaryDirectory() as tmp:
            extract_cache_dir = Path(tmp) / "extract_cache"
            kb_dir = Path(tmp) / "kb"
            kb_dir.mkdir()
            (kb_dir / "a.txt").write_text("content read via env var config")

            with mock.patch.dict(
                os.environ, {"AUTOGENBOOK_KB_EXTRACT_CACHE_DIR": str(extract_cache_dir)}
            ):
                with mock.patch.object(rag_kb, "_read_txt_md", wraps=rag_kb._read_txt_md) as spy:
                    self._build(kb_dir, extract_cache_dir=None)
                    self._build(kb_dir, extract_cache_dir=None)
                    self.assertEqual(spy.call_count, 1)

    def test_cached_result_still_produces_correct_chunks(self):
        with TemporaryDirectory() as tmp:
            extract_cache_dir = Path(tmp) / "extract_cache"
            kb_dir = Path(tmp) / "kb"
            kb_dir.mkdir()
            content = "Alpha beta gamma. " * 300
            (kb_dir / "a.txt").write_text(content)

            fresh = self._build(kb_dir, extract_cache_dir)
            cached = self._build(kb_dir, extract_cache_dir)
            self.assertEqual([c.text for c in fresh.chunks], [c.text for c in cached.chunks])
            self.assertTrue(len(fresh.chunks) > 1)

    def test_malformed_cache_entry_falls_back_to_fresh_extraction(self):
        # A cache file that parses as JSON but doesn't have the expected shape (disk
        # corruption, a manual edit, or an old/new payload-schema mismatch) must be
        # treated as a miss, not silently drop the source file's chunks from the KB.
        with TemporaryDirectory() as tmp:
            extract_cache_dir = Path(tmp) / "extract_cache"
            extract_cache_dir.mkdir()
            kb_dir = Path(tmp) / "kb"
            kb_dir.mkdir()
            (kb_dir / "a.txt").write_text("some real content")

            self._build(kb_dir, extract_cache_dir)
            cache_files = list(extract_cache_dir.glob("extract_*.json"))
            self.assertEqual(len(cache_files), 1)
            cache_files[0].write_text(json.dumps({"unexpected": "shape"}))

            kb = self._build(kb_dir, extract_cache_dir)
            self.assertEqual(len(kb.chunks), 1)

    def test_uncreatable_extract_cache_dir_disables_caching_gracefully(self):
        # A plain file sitting at the configured cache path (permission mismatch,
        # a bad mount, a full disk) must not abort the whole KB build.
        with TemporaryDirectory() as tmp:
            blocked_path = Path(tmp) / "not_a_directory"
            blocked_path.write_text("i am a file, not a directory")
            kb_dir = Path(tmp) / "kb"
            kb_dir.mkdir()
            (kb_dir / "a.txt").write_text("hello")

            kb = self._build(kb_dir, extract_cache_dir=blocked_path)
            self.assertEqual(len(kb.chunks), 1)

    def test_pdf_with_ocr_enabled_is_never_cached(self):
        # OCR is an external, non-deterministic process; a transient failure there
        # must not be baked into the persistent, cross-run cache forever.
        with TemporaryDirectory() as tmp:
            extract_cache_dir = Path(tmp) / "extract_cache"
            kb_dir = Path(tmp) / "kb"
            kb_dir.mkdir()
            (kb_dir / "a.pdf").write_bytes(b"not a real pdf, _read_pdf is mocked below")

            with mock.patch.object(
                rag_kb, "_read_pdf", return_value=("full", [("page 1", "hello world")])
            ) as spy:
                self._build(kb_dir, extract_cache_dir, enable_ocr=True)
                self._build(kb_dir, extract_cache_dir, enable_ocr=True)
                self.assertEqual(spy.call_count, 2)

    def test_pdf_without_ocr_is_cached(self):
        with TemporaryDirectory() as tmp:
            extract_cache_dir = Path(tmp) / "extract_cache"
            kb_dir = Path(tmp) / "kb"
            kb_dir.mkdir()
            (kb_dir / "a.pdf").write_bytes(b"not a real pdf, _read_pdf is mocked below")

            with mock.patch.object(
                rag_kb, "_read_pdf", return_value=("full", [("page 1", "hello world")])
            ) as spy:
                self._build(kb_dir, extract_cache_dir, enable_ocr=False)
                self._build(kb_dir, extract_cache_dir, enable_ocr=False)
                self.assertEqual(spy.call_count, 1)

    def test_outer_directory_cache_invalidates_when_ocr_setting_changes(self):
        # The pre-existing whole-directory cache is keyed only by file path/size/mtime;
        # it must also invalidate when a setting that changes the *output* (here,
        # enable_ocr) changes, even though the directory's contents didn't.
        with TemporaryDirectory() as tmp:
            kb_dir = Path(tmp) / "kb"
            kb_dir.mkdir()
            (kb_dir / "a.pdf").write_bytes(b"not a real pdf, _read_pdf is mocked below")
            shared_dir_cache = Path(tmp) / "shared_dir_cache"

            with mock.patch.object(
                rag_kb, "_read_pdf", return_value=("full", [("page 1", "hello world")])
            ) as spy:
                rag_kb.KnowledgeBase.build_from_directory(
                    kb_dir, cache_dir=shared_dir_cache, enable_ocr=False
                )
                rag_kb.KnowledgeBase.build_from_directory(
                    kb_dir, cache_dir=shared_dir_cache, enable_ocr=True
                )
                self.assertEqual(spy.call_count, 2)

    def test_store_extraction_cache_cleans_up_tmp_file_when_replace_fails(self):
        with TemporaryDirectory() as tmp:
            cache_path = Path(tmp) / "extract_test.json"
            with mock.patch.object(rag_kb.os, "replace", side_effect=OSError("simulated failure")):
                rag_kb._store_extraction_cache(cache_path, {"text": "x"})
            self.assertEqual(list(Path(tmp).iterdir()), [])


class ExtractionCacheKeyTests(unittest.TestCase):
    def test_same_content_and_params_same_path(self):
        cache_dir = Path("/tmp/does-not-need-to-exist")
        p1 = rag_kb._extraction_cache_path(cache_dir, "abc123", "txt")
        p2 = rag_kb._extraction_cache_path(cache_dir, "abc123", "txt")
        self.assertEqual(p1, p2)

    def test_different_params_different_path(self):
        cache_dir = Path("/tmp/does-not-need-to-exist")
        p1 = rag_kb._extraction_cache_path(cache_dir, "abc123", "pdf:ocr=0:lang=eng")
        p2 = rag_kb._extraction_cache_path(cache_dir, "abc123", "pdf:ocr=1:lang=eng")
        self.assertNotEqual(p1, p2)

    def test_different_content_different_path(self):
        cache_dir = Path("/tmp/does-not-need-to-exist")
        p1 = rag_kb._extraction_cache_path(cache_dir, "abc123", "txt")
        p2 = rag_kb._extraction_cache_path(cache_dir, "def456", "txt")
        self.assertNotEqual(p1, p2)


if __name__ == "__main__":
    unittest.main()
