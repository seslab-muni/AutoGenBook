"""Structured output helpers: a strict-mode JSON schema from a pydantic model,
the JSON instructions used when the provider cannot enforce a schema, and a
tolerant JSON extractor for prompt-only replies."""

from __future__ import annotations

import copy
import json
import re
from enum import IntEnum
from typing import Any

from pydantic import BaseModel


class Level(IntEnum):
    JSON_SCHEMA = 0
    JSON_OBJECT = 1
    PROMPT = 2

    @property
    def label(self) -> str:
        return {0: "json_schema", 1: "json_object", 2: "prompt"}[int(self)]


_DROP_KEYS = {"default", "title", "examples"}


def _strictify(node: Any) -> Any:
    """Schema keywords only: `properties`/`$defs` map names to schemas, and a
    property called `title` must survive while the `title` keyword goes."""
    if isinstance(node, list):
        return [_strictify(v) for v in node]
    if not isinstance(node, dict):
        return node
    out: dict[str, Any] = {}
    for key, value in node.items():
        if key in _DROP_KEYS:
            continue
        if key in {"properties", "$defs", "definitions"} and isinstance(value, dict):
            out[key] = {name: _strictify(sub) for name, sub in value.items()}
        else:
            out[key] = _strictify(value)
    if out.get("type") == "object" or "properties" in out:
        props = out.get("properties") or {}
        out["properties"] = props
        out["required"] = list(props.keys())
        out["additionalProperties"] = False
    return out


def json_schema_for(model: type[BaseModel]) -> dict[str, Any]:
    """Strict-mode compatible schema (every object closed, every property
    required). Validation of the reply stays lenient: pydantic defaults still
    apply to fields a provider leaves out when it ignores the schema."""
    return _strictify(copy.deepcopy(model.model_json_schema()))


def schema_instructions(name: str, schema: dict[str, Any]) -> str:
    return (
        "Respond with a single JSON object and nothing else (no prose, no code fence). "
        "It must validate against this JSON schema.\n"
        f"Schema name: {name}\n```json\n{json.dumps(schema, ensure_ascii=False)}\n```"
    )


_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
_FENCE_RE = re.compile(r"```(?:json|JSON)?\s*(.*?)```", re.DOTALL)


def extract_json(text: str) -> Any:
    """First JSON object in `text`: handles reasoning blocks, code fences and
    leading/trailing prose. Raises ValueError when there is none."""
    cleaned = _THINK_RE.sub("", text or "").strip()
    candidates = [cleaned]
    candidates += [m.group(1).strip() for m in _FENCE_RE.finditer(cleaned)]
    decoder = json.JSONDecoder()
    for candidate in candidates:
        try:
            value = json.loads(candidate)
            if isinstance(value, (dict, list)):
                return value
        except ValueError:
            pass
        for match in re.finditer(r"[{\[]", candidate):
            try:
                value, _end = decoder.raw_decode(candidate[match.start():])
            except ValueError:
                continue
            if isinstance(value, dict):
                return value
    raise ValueError("no JSON object found in the model output")


REJECTION_HINTS = ("response_format", "json_schema", "json schema", "structured", "schema", "format", "not supported", "unsupported", "json_object")


def looks_like_format_rejection(message: str) -> bool:
    lowered = (message or "").lower()
    return any(hint in lowered for hint in REJECTION_HINTS)
