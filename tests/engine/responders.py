"""Per-schema responders for the fake LLM (`fake_llm.py`).

`respond(call)` returns a Python object that validates against the schema the
engine requested. Schemas with a registered responder get plausible,
prompt-aware content (the section writer cites the `cite_key`s it finds in the
retrieved context and writes to the requested length, the reviewer rejects a
deterministic subset of sections so the revise path is exercised, ...). Any
other schema is answered by `from_schema`, a deterministic generator that
walks the JSON schema.

Responders only read the prompt text the engine sends; they never import
engine code, so a prompt change that drops information a responder relies on
shows up as a failing test instead of being silently papered over.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Callable

RESPONDERS: dict[str, Callable[[Any], Any]] = {}

_CITE_KEY_RE = re.compile(r'cite_key="([^"]+)"')
_NODE_KEY_RE = re.compile(r"(?im)^\s*(?:-\s*)?node[_ ]key:\s*`?([0-9]+(?:-[0-9]+)*)`?\s*$")
_TARGET_WORDS_RE = re.compile(r"(?i)target length:\s*about\s*(\d+)\s*words")
_TITLE_RE = re.compile(r"(?im)^\s*(?:-\s*)?(?:section )?title:\s*(.+?)\s*$")


def register(name: str) -> Callable[[Callable[[Any], Any]], Callable[[Any], Any]]:
    def deco(fn: Callable[[Any], Any]) -> Callable[[Any], Any]:
        RESPONDERS[name] = fn
        return fn

    return deco


def respond(call: Any) -> Any:
    fn = RESPONDERS.get(call.schema_name or "")
    if fn is not None:
        return fn(call)
    schema = call.schema or {"type": "object", "properties": {}}
    return from_schema(schema, seed=call.schema_name or "obj", root=schema)


def plain_text(call: Any) -> str:
    """Free-text completion (no schema): a short deterministic paragraph."""
    title = first_match(_TITLE_RE, call.prompt) or "the topic"
    return f"Fake generated content about {title}. " * 3


# --------------------------------------------------------------------- helpers
def stable_int(*parts: Any) -> int:
    digest = hashlib.sha256("\x1f".join(str(p) for p in parts).encode("utf-8")).hexdigest()
    return int(digest[:12], 16)


def first_match(pattern: re.Pattern[str], text: str) -> str | None:
    match = pattern.search(text or "")
    return match.group(1).strip() if match else None


def node_key_of(prompt: str) -> str | None:
    return first_match(_NODE_KEY_RE, prompt)


def cite_keys_in(prompt: str) -> list[str]:
    seen: list[str] = []
    for key in _CITE_KEY_RE.findall(prompt or ""):
        if key not in seen:
            seen.append(key)
    return seen


def target_words(prompt: str, default: int = 300) -> int:
    value = first_match(_TARGET_WORDS_RE, prompt)
    return int(value) if value else default


def filler_paragraphs(topic: str, words: int, *, cite: list[str], seed: str) -> str:
    """Deterministic prose of about `words` words, split into paragraphs of
    ~90 words, citing `cite` keys with the `[cite_key]` marker."""
    vocabulary = (
        "the approach relies on careful reasoning about each concept and shows how it connects "
        "to practice while explaining assumptions limitations and consequences for readers who "
        "want a precise yet accessible account of the material presented in this part"
    ).split()
    paragraphs: list[str] = []
    produced = 0
    index = 0
    while produced < words:
        n = min(90, words - produced)
        rng = stable_int(seed, index)
        body = [vocabulary[(rng + j * 7) % len(vocabulary)] for j in range(max(n - 12, 4))]
        sentence = " ".join(body)
        lead = f"Fake generated content for {topic}, part {index + 1}:"
        text = f"{lead} {sentence}."
        if cite and index < len(cite):
            text = text[:-1] + f" [{cite[index]}]."
        paragraphs.append(text)
        produced += len(text.split())
        index += 1
    return "\n\n".join(paragraphs)


# ------------------------------------------------------ schema-driven fallback
def _resolve(schema: dict[str, Any], root: dict[str, Any]) -> dict[str, Any]:
    ref = schema.get("$ref")
    if isinstance(ref, str) and ref.startswith("#/"):
        node: Any = root
        for part in ref[2:].split("/"):
            node = node.get(part, {}) if isinstance(node, dict) else {}
        return _resolve(node, root) if isinstance(node, dict) else {}
    return schema


def from_schema(schema: dict[str, Any], *, seed: str, root: dict[str, Any], depth: int = 0) -> Any:
    schema = _resolve(schema, root)
    for key in ("anyOf", "oneOf"):
        options = schema.get(key)
        if isinstance(options, list) and options:
            non_null = [o for o in options if _resolve(o, root).get("type") != "null"]
            return from_schema((non_null or options)[0], seed=seed, root=root, depth=depth)
    if "allOf" in schema and schema["allOf"]:
        merged: dict[str, Any] = {}
        for part in schema["allOf"]:
            merged.update(_resolve(part, root))
        return from_schema(merged, seed=seed, root=root, depth=depth)
    if "const" in schema:
        return schema["const"]
    if "enum" in schema and schema["enum"]:
        options = schema["enum"]
        return options[stable_int(seed) % len(options)]
    kind = schema.get("type")
    if isinstance(kind, list):
        kind = next((k for k in kind if k != "null"), "null")
    if kind == "object" or (kind is None and "properties" in schema):
        out: dict[str, Any] = {}
        props = schema.get("properties") or {}
        for name, sub in props.items():
            out[name] = from_schema(sub, seed=f"{seed}.{name}", root=root, depth=depth + 1)
        return out
    if kind == "array":
        items = schema.get("items") or {"type": "string"}
        count = max(int(schema.get("minItems", 2 if depth < 3 else 1)), 1)
        if "maxItems" in schema:
            count = min(count, int(schema["maxItems"]))
        return [from_schema(items, seed=f"{seed}[{i}]", root=root, depth=depth + 1) for i in range(count)]
    if kind == "integer":
        lo = int(schema.get("minimum", 1))
        hi = int(schema.get("maximum", max(lo, 5)))
        return lo + stable_int(seed) % (hi - lo + 1)
    if kind == "number":
        lo = float(schema.get("minimum", schema.get("exclusiveMinimum", 0.0) + 0.5))
        hi = float(schema.get("maximum", lo + 2.0))
        return round(lo + (stable_int(seed) % 100) / 100.0 * (hi - lo), 1)
    if kind == "boolean":
        return stable_int(seed) % 2 == 0
    if kind == "null":
        return None
    text = f"fake {seed.split('.')[-1]} value"
    min_len = int(schema.get("minLength", 0))
    if len(text) < min_len:
        text = (text + " ") * (min_len // len(text) + 1)
    if "maxLength" in schema:
        text = text[: int(schema["maxLength"])]
    return text.strip() or "x"


def dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False)


# ------------------------------------------------------------ book responders
_SPEC_TITLE_RE = re.compile(r"(?im)^\s*(?:title|název|nazev)\s*:\s*(.+?)\s*$")
_TOTAL_PAGES_RE = re.compile(r"(?im)^Total pages:\s*([\d.]+)")
_CHAPTER_HINT_RE = re.compile(r"(?im)^Suggested number of chapters:\s*(\d+)")
_PART_PAGES_RE = re.compile(r"(?im)^-\s*Pages:\s*([\d.]+)")
_PART_TITLE_RE = re.compile(r"(?im)^-\s*Title:\s*(.+?)\s*$")
_SUGGESTED_RE = re.compile(r"use about (\d+) of them")
_BODY_RE = re.compile(r"<<<\n(.*?)\n>>>", re.DOTALL)
_OVERVIEW_KEY_RE = re.compile(r"(?m)^\[(\d+(?:-\d+)*)\]")
_PATCHABLE_RE = re.compile(r"Only these sections may be patched:\s*([^.\n]+)\.")
_MAX_PATCHES_RE = re.compile(r"choose at most (\d+) sections")


def _spec_title(prompt: str) -> str:
    return first_match(_SPEC_TITLE_RE, prompt) or "Fake Book"


@register("BookOutline")
def book_outline(call: Any) -> dict:
    prompt = call.prompt
    total = float(first_match(_TOTAL_PAGES_RE, prompt) or 12)
    chapters = max(3, min(4, int(first_match(_CHAPTER_HINT_RE, prompt) or 3)))
    per_chapter = round(total / chapters, 1)
    out = []
    for c in range(1, chapters + 1):
        out.append({
            "title": f"Chapter {c} of {_spec_title(prompt)}",
            "summary": f"Chapter {c} explains topic {c} step by step.",
            "n_pages": per_chapter,
            "sections": [
                {"title": f"Topic {c}.{s}", "summary": f"Section {s} of chapter {c}: aspect {s} of topic {c}.", "n_pages": round(per_chapter / 2, 1)}
                for s in (1, 2)
            ],
        })
    return {
        "title": _spec_title(prompt), "summary": f"A fake book about {_spec_title(prompt)}.",
        "target_readers": "students", "additional_requirements": "", "equation_frequency_level": 2,
        "chapters": out, "redundancy_notes": ["Merged two overlapping introductory sections."],
    }


@register("BookMetadata")
def book_metadata(call: Any) -> dict:
    return {
        "title": _spec_title(call.prompt), "summary": "A fake summary of the whole book written by the metadata agent.",
        "target_readers": "teachers", "additional_requirements": "", "equation_frequency_level": 1,
    }


@register("SubdivisionPlan")
def subdivision_plan(call: Any) -> dict:
    prompt = call.prompt
    pages = float(first_match(_PART_PAGES_RE, prompt) or 2)
    count = int(first_match(_SUGGESTED_RE, prompt) or 2)
    title = first_match(_PART_TITLE_RE, prompt) or "Part"
    return {"sections": [
        {"title": f"{title}, part {i}", "summary": f"Part {i} of {title}.", "n_pages": round(pages / count, 1)}
        for i in range(1, count + 1)
    ]}


@register("Glossary")
def glossary(call: Any) -> dict:
    return {
        "terms": [{"term": "fake term", "definition": "a term used consistently in the fake book", "note": ""},
                  {"term": "approach", "definition": "the method discussed in the book", "note": ""}],
        "notation": [{"symbol": "x", "meaning": "a variable"}],
        "audience": "Readers new to the topic.", "tone": "Clear and precise.", "conventions": ["Use SI units."],
    }


def _section_title(prompt: str) -> str:
    return first_match(re.compile(r"(?im)^-\s*Title:\s*(.+?)\s*$"), prompt) or "the section"


@register("SectionDraft")
def section_draft(call: Any) -> dict:
    prompt = call.prompt
    key = node_key_of(prompt) or "0"
    cites = cite_keys_in(prompt)[:2]
    words = target_words(prompt)
    body = filler_paragraphs(f"{_section_title(prompt)} ({key})", words, cite=cites, seed=f"draft:{key}")
    return {"body_markdown": body, "summary": f"Section {key} explains {_section_title(prompt)}.", "key_terms": ["fake term"], "citations_used": cites}


@register("SectionReview")
def section_review(call: Any) -> dict:
    prompt = call.prompt
    key = node_key_of(prompt) or "0"
    body = first_match(_BODY_RE, prompt) or ""
    reject = stable_int("review", key) % 3 == 0 and "(revised)" not in body
    issues = [{"type": "coverage", "severity": "major" if reject else "minor",
               "description": f"Section {key} should give one more example.", "required_fix": "Add a concrete example."}]
    return {"ok_to_keep": not reject, "issues": issues, "suggested_edits": [],
            "retrieval_queries": [f"example for {_section_title(prompt)}"] if reject else []}


@register("SectionRevision")
def section_revision(call: Any) -> dict:
    prompt = call.prompt
    bodies = _BODY_RE.findall(prompt)
    body = bodies[-1] if bodies else ""
    return {"body_markdown": body.rstrip() + "\n\nFake generated content (revised) with the example the review asked for.",
            "summary": "Revised section.", "changes_made": ["added an example"]}


@register("LengthAdjustment")
def length_adjustment(call: Any) -> dict:
    prompt = call.prompt
    key = node_key_of(prompt) or first_match(re.compile(r"(?m)^Section ([0-9-]+):"), prompt) or "0"
    words = int(first_match(re.compile(r"to about (\d+) words"), prompt) or 300)
    bodies = _BODY_RE.findall(prompt)
    cites = cite_keys_in(prompt) or re.findall(r"\[(kb_[^\]\s;]+)\]", bodies[-1] if bodies else "")[:2]
    return {"body_markdown": filler_paragraphs(f"section {key} (length adjusted)", words, cite=cites[:2], seed=f"len:{key}")}


@register("ConsistencyReport")
def consistency_report(call: Any) -> dict:
    prompt = call.prompt
    keys = _OVERVIEW_KEY_RE.findall(prompt)
    patchable_text = first_match(_PATCHABLE_RE, prompt) or ""
    patchable = [k.strip() for k in patchable_text.split(",") if k.strip() and k.strip() != "(none)"]
    max_patches = int(first_match(_MAX_PATCHES_RE, prompt) or 0)
    findings = []
    if len(keys) >= 2:
        findings.append({"type": "duplicated_coverage", "severity": "minor", "node_keys": keys[:2],
                         "description": f"Sections {keys[0]} and {keys[1]} both introduce the approach.",
                         "required_fix": f"Keep the introduction in {keys[0]} and refer back to it in {keys[1]}."})
        findings.append({"type": "terminology", "severity": "minor", "node_keys": [keys[-1]],
                         "description": f"Section {keys[-1]} uses a synonym instead of the glossary term.", "required_fix": "Use 'fake term'."})
    patches = [{"node_key": k, "instructions": "Refer back to the earlier introduction instead of repeating it."} for k in patchable[:max_patches] if k in keys[:2]]
    return {"findings": findings, "patches": patches}
