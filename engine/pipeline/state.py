"""Engine-private resumable state under `out/.engine/`.

- `WorkStore`: the result of each finished stage of a leaf chain
  (`<key>.<stage>.json`, tagged with a fingerprint of the node's brief), so an
  interrupted run resumes after the last finished stage. Cleared when the
  section file is written, so a later regenerate starts from scratch.
- `SectionMeta`: per-leaf summary/key terms/citations for the consistency pass.
"""

from __future__ import annotations

import hashlib
import json
import threading
from pathlib import Path
from typing import Any

from engine.util.fs import atomic_write_json, read_json


def fingerprint(*parts: Any) -> str:
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:24]


class WorkStore:
    def __init__(self, root: Path) -> None:
        self.root = root

    def _path(self, key: str, stage: str) -> Path:
        return self.root / "work" / f"{key}.{stage}.json"

    def save(self, key: str, stage: str, fp: str, data: dict[str, Any]) -> None:
        atomic_write_json(self._path(key, stage), {"fingerprint": fp, "data": data})

    def load(self, key: str, stage: str, fp: str) -> dict[str, Any] | None:
        payload = read_json(self._path(key, stage))
        if not isinstance(payload, dict) or payload.get("fingerprint") != fp or not isinstance(payload.get("data"), dict):
            return None
        return payload["data"]

    def last_stage(self, key: str, fp: str, stages: tuple[str, ...]) -> str | None:
        last = None
        for stage in stages:
            if self.load(key, stage, fp) is None:
                break
            last = stage
        return last

    def clear(self, key: str) -> None:
        folder = self.root / "work"
        if not folder.is_dir():
            return
        for path in folder.glob(f"{key}.*.json"):
            # `1-1.draft.json` must not match leaf `1-10`: the glob is exact on the key.
            if path.name.split(".", 1)[0] == key:
                try:
                    path.unlink()
                except OSError:
                    pass


class SectionMeta:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()
        data = read_json(path)
        self.data: dict[str, dict[str, Any]] = data if isinstance(data, dict) else {}

    def get(self, key: str) -> dict[str, Any] | None:
        return self.data.get(key)

    def set(self, key: str, value: dict[str, Any]) -> None:
        with self._lock:
            self.data[key] = value
            atomic_write_json(self.path, self.data)
