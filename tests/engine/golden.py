"""Golden-run helpers: normalised comparison of a run's `out/` against
committed expectations, with record/replay of the fake LLM's chat replies.

Re-record after an intentional prompt or assembly change:

    ENGINE_UPDATE_GOLDEN=1 pytest tests/engine/test_golden_book.py tests/engine/test_golden_paper.py tests/engine/test_golden_presentation.py
"""

from __future__ import annotations

import json
import os
import re
import shutil
from collections import Counter
from pathlib import Path
from typing import Any

GOLDEN_DIR = Path(__file__).resolve().parent / "golden"
UPDATE = os.environ.get("ENGINE_UPDATE_GOLDEN") == "1"
SKIP_NAMES = {"run_meta.json", "llm_usage.jsonl", "events.jsonl"}
SKIP_DIRS = {".kb_cache", "logs"}
SKIP_SUFFIXES = {".bak", ".pdf", ".tex", ".log", ".pptx", ".mp3", ".wav"}


def _relativize(obj: Any, work: str) -> Any:
    if isinstance(obj, dict):
        return {k: _relativize(v, work) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_relativize(v, work) for v in obj]
    if isinstance(obj, str) and work in obj:
        return obj.replace(work, "<work>")
    return obj


def snapshot(out_dir: Path, work_dir: Path) -> dict[str, str]:
    work = str(work_dir.resolve())
    files: dict[str, str] = {}
    for path in sorted(out_dir.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(out_dir)
        if rel.parts[0] in SKIP_DIRS or path.name in SKIP_NAMES or path.suffix in SKIP_SUFFIXES:
            continue
        text = path.read_text(encoding="utf-8")
        if path.suffix == ".json":
            data = _relativize(json.loads(text), work)
            if path.name == "kb_sources.json" and isinstance(data.get("page_keys"), dict):
                # page_keys (old-engine derived index) hash the absolute source path.
                data["page_keys"] = {re.sub(r"_[0-9a-f]{8}_", "_<hash>_", k): v for k, v in data["page_keys"].items()}
            text = json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True) + "\n"
        else:
            text = text.replace(work, "<work>")
        files[rel.as_posix()] = text
    usage = out_dir / "llm_usage.jsonl"
    if usage.exists():
        labels = Counter(json.loads(line)["label"] for line in usage.read_text(encoding="utf-8").splitlines() if line.strip())
        files["_calls.json"] = json.dumps(dict(sorted(labels.items())), indent=1) + "\n"
    return files


def expected_dir(name: str) -> Path:
    return GOLDEN_DIR / name / "expected"


def responses_path(name: str) -> Path:
    return GOLDEN_DIR / name / "responses.json"


def write_expected(name: str, files: dict[str, str]) -> None:
    target = expected_dir(name)
    if target.exists():
        shutil.rmtree(target)
    for rel, text in files.items():
        path = target / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")


def load_expected(name: str) -> dict[str, str]:
    root = expected_dir(name)
    return {p.relative_to(root).as_posix(): p.read_text(encoding="utf-8") for p in sorted(root.rglob("*")) if p.is_file()}


def assert_matches(name: str, files: dict[str, str]) -> None:
    expected = load_expected(name)
    missing = sorted(set(expected) - set(files))
    extra = sorted(set(files) - set(expected))
    changed = sorted(k for k in set(expected) & set(files) if expected[k] != files[k])
    assert not (missing or extra or changed), (
        f"golden run '{name}' drifted: missing={missing} extra={extra} changed={changed}. "
        "If the change is intended, re-record with ENGINE_UPDATE_GOLDEN=1."
    )
