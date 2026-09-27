"""Small filesystem helpers: atomic writes, hashing, safe file names."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import uuid
from pathlib import Path
from typing import Any


def sha256_file(path: Path, block_size: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(block_size), b""):
            digest.update(block)
    return digest.hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def atomic_write_bytes(path: Path, data: bytes, *, backup: bool = False) -> None:
    """Write-then-rename, so a concurrent reader (the API polls
    `structure_graph.json` once a second) never sees a partial file. The temp
    name mixes the PID with a UUID because work dirs and caches can be shared
    by PID-namespaced containers. `backup` keeps the previous content as
    `<name>.bak` (the old engine's convention, skipped by artifact upload)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}-{uuid.uuid4().hex}")
    try:
        with tmp.open("wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        if backup and path.exists():
            try:
                shutil.copyfile(path, path.with_name(path.name + ".bak"))
            except OSError:
                pass
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


def atomic_write_text(path: Path, text: str, *, backup: bool = False) -> None:
    atomic_write_bytes(path, text.encode("utf-8"), backup=backup)


def atomic_write_json(path: Path, obj: Any, *, backup: bool = False, indent: int | None = 2) -> None:
    atomic_write_text(path, json.dumps(obj, ensure_ascii=False, indent=indent) + "\n", backup=backup)


def read_json(path: Path) -> Any | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def decode_text_bytes(raw: bytes) -> str:
    """UTF-8 first, then the Windows code page old Czech runs sometimes used."""
    for encoding in ("utf-8", "cp1250"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1", errors="replace")


def safe_filename(name: str, default: str = "book") -> str:
    """Same rule as the old engine (`utils.safe_filename`), so the final book
    keeps its familiar name; the API finds it by extension anyway."""
    name = name.strip()
    name = re.sub(r"\s+", "_", name)
    name = re.sub(r"[^A-Za-z0-9_.\-À-ž]+", "_", name)
    return name or default
