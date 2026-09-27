"""Immutable run configuration, resolved once from argv + environment.

Nothing in the engine reads `os.environ` after `RunConfig.from_args` has run:
every setting a component needs is passed to it from here, so two runs in one
process never interfere (the old engine's process-global prompt registry,
usage totals and logger are what forced the API to shell out).
"""

from __future__ import annotations

import argparse
import os
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any, Mapping

from engine.errors import ConfigError

DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_MODEL = "openai/gpt-5-mini"
DEFAULT_EMBED_MODEL = "qwen3-embedding-4b"
DEFAULT_RERANK_MODEL = "qwen3-reranker-4b"
DEFAULT_TTS_MODEL = "openai/gpt-4o-mini-tts-2025-12-15"
DEFAULT_CONCURRENCY = 4
MODES = ("book", "paper", "presentation")
DEFAULT_STRUCTURE_FILE = {
    "book": "book_structure.json",
    "paper": "paper_structure.json",
    "presentation": "presentation_structure.json",
}
DEFAULT_INPUT_FILE = {
    "book": "book_input.txt",
    "paper": "paper_input.txt",
    "presentation": "presentation_input.txt",
}

_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off"}


def _json_safe(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    return value


def _env_str(env: Mapping[str, str], name: str, default: str = "") -> str:
    value = env.get(name)
    return value.strip() if value and value.strip() else default


def _env_bool(env: Mapping[str, str], name: str, default: bool) -> bool:
    value = env.get(name)
    if value is None:
        return default
    value = value.strip().lower()
    if value in _TRUE:
        return True
    if value in _FALSE:
        return False
    return default


def _env_float(env: Mapping[str, str], name: str, default: float) -> float:
    try:
        return float(_env_str(env, name, str(default)))
    except ValueError as exc:
        raise ConfigError(f"{name} must be a number") from exc


def _env_int(env: Mapping[str, str], name: str, default: int) -> int:
    try:
        return int(_env_str(env, name, str(default)))
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer") from exc


def is_openrouter(url: str) -> bool:
    return "openrouter.ai" in (url or "").lower()


@dataclass(frozen=True)
class LLMSettings:
    base_url: str = DEFAULT_OPENROUTER_BASE_URL
    api_key: str | None = None
    model: str = DEFAULT_MODEL
    mini_model: str = DEFAULT_MODEL
    force_mini: bool = False
    timeout_s: float = 300.0
    max_retries: int = 3
    http_referer: str | None = None
    x_title: str | None = None
    pricing_disabled: bool = False
    pricing_timeout_s: float = 30.0
    pricing_cache_path: Path | None = None
    temperature: float = 0.3

    @property
    def is_openrouter(self) -> bool:
        return is_openrouter(self.base_url)

    def resolve(self, role: str = "main") -> str:
        """Model id for an agent role (`main` or `mini`); the force-mini switch
        wins over every role, as in the old client."""
        if self.force_mini or role == "mini":
            return self.mini_model
        return self.model


@dataclass(frozen=True)
class RetrievalSettings:
    kb_dir: Path | None = None
    rebuild_kb: bool = False
    extract_cache_dir: Path | None = None
    ocr: bool = False
    ocr_lang: str = "eng"
    chunk_tokens: int = 400
    top_k: int = 6
    candidates: int = 30
    max_chars_total: int = 6000
    item_chars: int = 1500
    dense: str = "auto"  # auto | remote | local | none
    embed_model: str = DEFAULT_EMBED_MODEL
    embed_base_url: str = DEFAULT_OPENROUTER_BASE_URL
    embed_api_key: str | None = None
    rerank: str = "remote"  # none | remote | llm
    rerank_model: str = DEFAULT_RERANK_MODEL
    rerank_base_url: str = DEFAULT_OPENROUTER_BASE_URL
    rerank_api_key: str | None = None
    enable_web: bool = False
    tavily_api_key: str | None = None
    web_k: int = 5


@dataclass(frozen=True)
class PresentationSettings:
    tex: bool = False
    pptx: bool = False
    narration: bool = False
    narration_model: str | None = None
    tts: bool = False
    tts_mode: str = "openrouter"  # openrouter | local
    tts_model: str = DEFAULT_TTS_MODEL
    tts_voice: str = "alloy"
    tts_base_url: str = DEFAULT_OPENROUTER_BASE_URL
    tts_api_key: str | None = None
    tts_local_model: str | None = None  # Coqui model name override for --presentation-tts-mode local
    tts_speaker_wavs: tuple[Path, ...] = ()  # XTTS reference recordings (AUTOGENBOOK_TTS_SPEAKER_WAV)
    exclude_slides: str = ""
    disable_general_knowledge_citation: bool = False


@dataclass(frozen=True)
class RunConfig:
    mode: str
    input_path: Path
    out_dir: Path
    json_path: Path
    use_json: bool = False
    use_txt: bool = False
    resume: bool = False
    md_output: bool = True
    tex_output: bool = False
    tex_requested: bool = False  # LaTeX asked for explicitly: its failure fails the run
    pdf_output: bool = False
    audit_enabled: bool = False
    audit_mode: str = "warn"
    fail_fast_schema: bool = False
    concurrency: int = DEFAULT_CONCURRENCY
    context_mode: str = "parallel"
    language: str | None = None
    author: str | None = None
    max_consistency_patches: int = 3
    citation_style: str = "bibtex"
    paper_venue: str = "arXiv"
    llm: LLMSettings = field(default_factory=LLMSettings)
    retrieval: RetrievalSettings = field(default_factory=RetrievalSettings)
    presentation: PresentationSettings = field(default_factory=PresentationSettings)
    args: Mapping[str, Any] = field(default_factory=dict)

    @property
    def kb_dir(self) -> Path | None:
        return self.retrieval.kb_dir

    @classmethod
    def from_args(cls, args: argparse.Namespace, env: Mapping[str, str] | None = None) -> "RunConfig":
        env = dict(os.environ if env is None else env)
        mode = args.mode
        out_dir = Path(args.out_dir).expanduser().resolve()

        raw_input = args.input
        if mode == "presentation" and args.input is None:
            raw_input = args.presentation_input
        if mode == "paper" and args.input is None:
            raw_input = args.paper_input
        input_path = Path(raw_input or DEFAULT_INPUT_FILE[mode]).expanduser().resolve()

        json_path = Path(args.json_path or DEFAULT_STRUCTURE_FILE[mode]).expanduser()
        if not json_path.is_absolute():
            # Contract 3.1: a relative -j resolves against -o, not the cwd.
            json_path = out_dir / json_path

        base_url = (
            (args.llm_base_url or "").strip()
            or _env_str(env, "AUTOGENBOOK_LLM_BASE_URL")
            or _env_str(env, "OPENROUTER_BASE_URL")
            or DEFAULT_OPENROUTER_BASE_URL
        )
        # Key precedence follows the API (`api/core/settings.py:resolved_llm_api_key`,
        # which mirrors the old client): OPENROUTER_API_KEY, then AUTOGENBOOK_LLM_API_KEY.
        api_key = (
            _env_str(env, "OPENROUTER_API_KEY")
            or _env_str(env, "AUTOGENBOOK_LLM_API_KEY")
            or _env_str(env, "OPENAI_API_KEY")
            or None
        )
        model = _env_str(env, "AUTOGENBOOK_LLM_MODEL", DEFAULT_MODEL)
        mini = _env_str(env, "AUTOGENBOOK_LLM_MINI_MODEL", model)
        cache_dir_raw = _env_str(env, "AUTOGENBOOK_KB_EXTRACT_CACHE_DIR")
        extract_cache_dir = Path(cache_dir_raw).expanduser().resolve() if cache_dir_raw else None
        pricing_cache = _env_str(env, "AUTOGENBOOK_PRICING_CACHE")
        if pricing_cache:
            pricing_cache_path: Path | None = Path(pricing_cache).expanduser()
        elif _env_str(env, "HOME"):
            pricing_cache_path = Path(env["HOME"]).expanduser() / ".cache" / "autogenbook" / "openrouter_pricing.json"
        else:
            pricing_cache_path = None
        llm = LLMSettings(
            base_url=base_url,
            api_key=api_key,
            model=model,
            mini_model=mini,
            force_mini=_env_bool(env, "AUTOGENBOOK_FORCE_MINI_MODEL", False),
            timeout_s=_env_float(env, "OPENROUTER_REQUEST_TIMEOUT_S", 300.0),
            max_retries=max(0, _env_int(env, "OPENROUTER_MAX_RETRIES", 3)),
            http_referer=_env_str(env, "OPENROUTER_HTTP_REFERER") or None,
            x_title=_env_str(env, "OPENROUTER_X_TITLE") or None,
            pricing_disabled=_env_bool(env, "OPENROUTER_PRICING_DISABLE", False),
            pricing_timeout_s=_env_float(env, "OPENROUTER_PRICING_TIMEOUT", 30.0),
            pricing_cache_path=pricing_cache_path,
        )

        kb_dir = Path(args.kb_dir).expanduser().resolve() if args.kb_dir else None
        dense = _env_str(env, "AUTOGENBOOK_DENSE", "auto").lower()
        if dense not in {"auto", "remote", "local", "none"}:
            raise ConfigError("AUTOGENBOOK_DENSE must be one of auto, remote, local, none")
        rerank = _env_str(env, "AUTOGENBOOK_RERANK", "remote").lower()
        if rerank not in {"none", "remote", "llm"}:
            raise ConfigError("AUTOGENBOOK_RERANK must be one of none, remote, llm")
        retrieval = RetrievalSettings(
            kb_dir=kb_dir,
            rebuild_kb=bool(args.rebuild_kb),
            extract_cache_dir=extract_cache_dir,
            ocr=_env_bool(env, "AUTOGENBOOK_KB_OCR", False),
            ocr_lang=_env_str(env, "AUTOGENBOOK_KB_OCR_LANG", "eng"),
            chunk_tokens=max(50, _env_int(env, "AUTOGENBOOK_CHUNK_TOKENS", 400)),
            dense=dense,
            embed_model=_env_str(env, "AUTOGENBOOK_EMBED_MODEL", DEFAULT_EMBED_MODEL),
            embed_base_url=_env_str(env, "AUTOGENBOOK_EMBED_BASE_URL", base_url),
            embed_api_key=_env_str(env, "AUTOGENBOOK_EMBED_API_KEY") or api_key,
            rerank=rerank,
            rerank_model=_env_str(env, "AUTOGENBOOK_RERANK_MODEL", DEFAULT_RERANK_MODEL),
            rerank_base_url=_env_str(env, "AUTOGENBOOK_RERANK_BASE_URL", base_url),
            rerank_api_key=_env_str(env, "AUTOGENBOOK_RERANK_API_KEY") or api_key,
            enable_web=bool(args.enable_web_rag),
            tavily_api_key=_env_str(env, "TAVILY_API_KEY") or None,
            web_k=max(1, int(args.web_rag_k)),
        )

        concurrency = args.concurrency
        if concurrency is None:
            concurrency = _env_int(env, "AUTOGENBOOK_CONCURRENCY", DEFAULT_CONCURRENCY)
        if concurrency < 1:
            raise ConfigError("--concurrency must be at least 1")

        # Output toggles, same semantics as the old Markdown-first book path:
        # .tex/.pdf only with --export-tex (paper: always unless --no-tex/--no-pdf;
        # presentation: its own --presentation-tex/--presentation-pptx flags).
        md_output = not args.no_md
        if mode == "book":
            tex_output = bool(args.export_tex) and not args.no_tex
            pdf_output = bool(args.export_tex) and not args.no_pdf
        elif mode == "paper":
            tex_output = not args.no_tex or bool(args.export_tex)
            pdf_output = not args.no_pdf
            if pdf_output:
                tex_output = True
        else:
            tex_output = bool(args.presentation_tex)
            pdf_output = bool(args.presentation_tex) and not args.no_pdf
        # Book --export-tex and presentation --presentation-tex are explicit; a
        # paper's .tex is a default by-product unless --export-tex asks for it.
        tex_requested = tex_output and (mode != "paper" or bool(args.export_tex))

        if mode == "book":
            audit_enabled = bool(args.audit_book) and args.audit_book_mode != "off"
            audit_mode = args.audit_book_mode
        else:
            audit_mode = args.audit_mode
            audit_enabled = audit_mode != "off" and (args.audit is not False)

        presentation = PresentationSettings(
            tex=bool(args.presentation_tex),
            pptx=bool(args.presentation_pptx),
            narration=bool(args.presentation_narration or args.presentation_tts),
            narration_model=args.presentation_narration_model,
            tts=bool(args.presentation_tts),
            tts_mode=args.presentation_tts_mode,
            tts_model=args.presentation_tts_model or _env_str(env, "AUTOGENBOOK_TTS_MODEL", DEFAULT_TTS_MODEL),
            tts_voice=_env_str(env, "OPENROUTER_TTS_VOICE", "alloy"),
            tts_base_url=_env_str(env, "AUTOGENBOOK_TTS_BASE_URL", base_url),
            tts_api_key=_env_str(env, "AUTOGENBOOK_TTS_API_KEY") or api_key,
            tts_local_model=_env_str(env, "AUTOGENBOOK_TTS_LOCAL_MODEL") or None,
            tts_speaker_wavs=tuple(
                Path(p).expanduser() for p in _env_str(env, "AUTOGENBOOK_TTS_SPEAKER_WAV").split(",") if p.strip()
            ),
            exclude_slides=args.presentation_exclude_slides or "",
            disable_general_knowledge_citation=bool(args.disable_general_knowledge_citation),
        )

        language = (args.language or "").strip().lower() or None
        author = _env_str(env, "AUTOGENBOOK_BOOK_AUTHOR") or None

        serial: dict[str, Any] = {}
        for key, value in vars(args).items():
            serial[key] = str(value) if isinstance(value, Path) else value
        return cls(
            mode=mode,
            input_path=input_path,
            out_dir=out_dir,
            json_path=json_path,
            use_json=bool(args.use_json),
            use_txt=bool(args.use_txt),
            resume=bool(args.resume),
            md_output=md_output,
            tex_output=tex_output,
            tex_requested=tex_requested,
            pdf_output=pdf_output,
            audit_enabled=audit_enabled,
            audit_mode=audit_mode,
            fail_fast_schema=bool(args.fail_fast_schema),
            concurrency=int(concurrency),
            context_mode=args.context_mode,
            language=language,
            author=author,
            max_consistency_patches=max(0, _env_int(env, "AUTOGENBOOK_CONSISTENCY_MAX_PATCHES", 3)),
            citation_style=args.citation_style,
            paper_venue=args.paper_venue,
            llm=llm,
            retrieval=retrieval,
            presentation=presentation,
            args=serial,
        )

    def describe(self) -> dict[str, Any]:
        """JSON-safe summary for run_meta.json (no secrets)."""
        out: dict[str, Any] = {}
        for f in fields(self):
            value = getattr(self, f.name)
            if f.name in {"llm", "retrieval", "presentation"}:
                out[f.name] = {k.name: _json_safe(getattr(value, k.name)) for k in fields(value) if "api_key" not in k.name}
            elif f.name == "args":
                continue
            else:
                out[f.name] = str(value) if isinstance(value, Path) else value
        return out
