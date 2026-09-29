"""Prompt packs and the strict renderer.

A prompt file (`engine/prompts/<pack>/<name>.md`) is Markdown with a small
YAML header::

    ---
    id: book/writer
    description: Writes the body of one leaf section.
    compose: [common/policy, common/citations]
    placeholders: [language, book_title, section_title]
    ---
    === system ===
    ...text with {placeholders}...
    === user ===
    ...

`compose` lists shared blocks (under `common/`) that are rendered and
prepended to the system part, in order: global policy is composed explicitly
per prompt, never injected by magic. Literal braces are written `{{`/`}}`.

Strictness: every `{name}` in the text (own or composed) must be declared in
`placeholders` (or in a composed block's header), every declared placeholder
must be used, and `render()` must receive exactly the declared set. Any
mismatch raises `PromptError` - at load time for the file, at render time for
the caller. There is no silent `{cite_key}` left in a prompt.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping

import yaml

from engine.errors import PromptError

PROMPTS_DIR = Path(__file__).resolve().parent
_PLACEHOLDER_RE = re.compile(r"\{([a-z_][a-z0-9_]*)\}")
_TOKEN_RE = re.compile(r"\{\{|\}\}|\{([a-z_][a-z0-9_]*)\}")
_ANY_BRACE_RE = re.compile(r"\{[^{}\n]*\}")
_SECTION_RE = re.compile(r"^=== (system|user) ===\s*$", re.MULTILINE)


@dataclass(frozen=True)
class Prompt:
    id: str
    description: str
    system: str
    user: str
    placeholders: frozenset[str]
    compose: tuple[str, ...] = ()
    composed_placeholders: frozenset[str] = field(default_factory=frozenset)

    @property
    def required(self) -> frozenset[str]:
        return self.placeholders | self.composed_placeholders


def _fields(text: str) -> set[str]:
    return {m.group(1) for m in _TOKEN_RE.finditer(text) if m.group(1)}


def _substitute(text: str, values: Mapping[str, str]) -> str:
    """One pass, so `{{`/`}}` escapes are resolved in the template only and a
    value containing braces (LaTeX, JSON) is inserted verbatim."""

    def replace(match: re.Match[str]) -> str:
        token = match.group(0)
        if token == "{{":
            return "{"
        if token == "}}":
            return "}"
        return values[match.group(1)]

    return _TOKEN_RE.sub(replace, text)


def parse_prompt(text: str, source: str) -> tuple[dict[str, Any], str, str]:
    if not text.startswith("---"):
        raise PromptError(f"{source}: missing YAML header")
    try:
        _, header_text, body = text.split("---", 2)
    except ValueError as exc:
        raise PromptError(f"{source}: unterminated YAML header") from exc
    try:
        header = yaml.safe_load(header_text) or {}
    except yaml.YAMLError as exc:
        raise PromptError(f"{source}: invalid YAML header ({exc})") from exc
    parts = _SECTION_RE.split(body)
    sections: dict[str, str] = {}
    # parts: [preamble, name, text, name, text, ...]
    for i in range(1, len(parts) - 1, 2):
        sections[parts[i]] = parts[i + 1].strip("\n")
    if not sections:
        sections["system"] = body.strip("\n")
    return header, sections.get("system", "").strip(), sections.get("user", "").strip()


@lru_cache(maxsize=None)
def load_prompt(prompt_id: str, root: str = str(PROMPTS_DIR)) -> Prompt:
    path = Path(root) / f"{prompt_id}.md"
    if not path.is_file():
        raise PromptError(f"prompt {prompt_id!r} not found ({path})")
    header, system, user = parse_prompt(path.read_text(encoding="utf-8"), str(path))
    declared = header.get("placeholders") or []
    if not isinstance(declared, list) or not all(isinstance(p, str) for p in declared):
        raise PromptError(f"{path}: `placeholders` must be a list of names")
    compose = tuple(header.get("compose") or [])
    used = _fields(system) | _fields(user)
    unknown = used - set(declared)
    if unknown:
        raise PromptError(f"{path}: undeclared placeholder(s) {sorted(unknown)}")
    unused = set(declared) - used
    if unused:
        raise PromptError(f"{path}: declared but unused placeholder(s) {sorted(unused)}")
    # A single brace pair that is not a valid placeholder is almost always a
    # typo ({Title}, {cite key}); JSON examples must use {{ }}.
    stripped = system.replace("{{", "").replace("}}", "") + user.replace("{{", "").replace("}}", "")
    for token in _ANY_BRACE_RE.findall(stripped):
        if not _PLACEHOLDER_RE.fullmatch(token):
            raise PromptError(f"{path}: stray brace expression {token!r} (escape literal braces as {{{{ }}}})")
    composed: set[str] = set()
    for block in compose:
        composed |= load_prompt(block, root).required
    return Prompt(
        id=str(header.get("id") or prompt_id),
        description=str(header.get("description") or ""),
        system=system,
        user=user,
        placeholders=frozenset(declared),
        compose=compose,
        composed_placeholders=frozenset(composed),
    )


def render(prompt_id: str, values: Mapping[str, Any], *, root: str = str(PROMPTS_DIR)) -> list[dict[str, str]]:
    """Chat messages for `prompt_id`. `values` must supply exactly the
    prompt's declared placeholders (own + composed)."""
    prompt = load_prompt(prompt_id, root)
    given = set(values)
    missing = prompt.required - given
    extra = given - prompt.required
    if missing or extra:
        raise PromptError(
            f"prompt {prompt_id!r}: missing {sorted(missing)} / unexpected {sorted(extra)} placeholder values"
        )
    text_values = {k: _stringify(v) for k, v in values.items()}
    blocks = []
    for block_id in prompt.compose:
        block = load_prompt(block_id, root)
        blocks.append(_render_block(block, text_values, root))
    system = "\n\n".join([b for b in blocks if b] + ([_substitute(prompt.system, text_values)] if prompt.system else []))
    messages = [{"role": "system", "content": system.strip()}]
    if prompt.user:
        messages.append({"role": "user", "content": _substitute(prompt.user, text_values).strip()})
    return messages


def _render_block(block: Prompt, values: Mapping[str, str], root: str) -> str:
    parts = [_render_block(load_prompt(b, root), values, root) for b in block.compose]
    own = "\n\n".join(p for p in (block.system, block.user) if p)
    parts.append(_substitute(own, values))
    return "\n\n".join(p for p in parts if p).strip()


def _stringify(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float):
        return f"{value:g}"
    return str(value)


def list_prompts(pack: str | None = None, root: Path = PROMPTS_DIR) -> list[str]:
    base = root / pack if pack else root
    return sorted(
        str(p.relative_to(root).with_suffix("")).replace("\\", "/")
        for p in base.rglob("*.md")
        if not p.name.startswith("README")
    )
