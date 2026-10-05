"""RunConfig precedence and EventSink formatting (#151)."""

from __future__ import annotations

import io
import json
from pathlib import Path

import pytest

from api.infrastructure.cli.stdout_parser import parse_line
from engine.cli import build_parser
from engine.config import RunConfig
from engine.errors import ConfigError
from engine.events import CompositeSink, JsonlSink, MemorySink, StreamSink, format_line


def _cfg(argv: list[str], env: dict[str, str]) -> RunConfig:
    return RunConfig.from_args(build_parser().parse_args(argv), env)


def test_llm_env_precedence(tmp_path: Path) -> None:
    base = ["-i", "x.txt", "-o", str(tmp_path / "out")]
    cfg = _cfg(base, {})
    assert cfg.llm.base_url == "https://openrouter.ai/api/v1"
    assert cfg.llm.model == "openai/gpt-5-mini" and cfg.llm.mini_model == "openai/gpt-5-mini"
    assert cfg.llm.api_key is None and cfg.concurrency == 4 and cfg.llm.timeout_s == 300

    env = {
        "OPENROUTER_BASE_URL": "https://or.example/v1",
        "AUTOGENBOOK_LLM_BASE_URL": "https://llm.ai.e-infra.cz/v1/",
        "AUTOGENBOOK_LLM_API_KEY": "einfra",
        "AUTOGENBOOK_LLM_MODEL": "glm-5.3",
        "AUTOGENBOOK_LLM_MINI_MODEL": "deepseek-v4.1-flash",
        "AUTOGENBOOK_CONCURRENCY": "8",
        "OPENROUTER_REQUEST_TIMEOUT_S": "120",
        "OPENROUTER_MAX_RETRIES": "5",
    }
    cfg = _cfg(base, env)
    assert cfg.llm.base_url == "https://llm.ai.e-infra.cz/v1/"
    assert cfg.llm.api_key == "einfra"
    assert (cfg.llm.model, cfg.llm.mini_model) == ("glm-5.3", "deepseek-v4.1-flash")
    assert cfg.llm.resolve("main") == "glm-5.3" and cfg.llm.resolve("mini") == "deepseek-v4.1-flash"
    assert cfg.concurrency == 8 and cfg.llm.timeout_s == 120 and cfg.llm.max_retries == 5
    # Embedding/rerank endpoints default to the LLM endpoint and key.
    assert cfg.retrieval.embed_base_url == cfg.llm.base_url and cfg.retrieval.embed_api_key == "einfra"
    assert cfg.retrieval.embed_model == "qwen3-embedding-4b" and cfg.retrieval.rerank_model == "qwen3-reranker-4b"

    # OPENROUTER_API_KEY wins over AUTOGENBOOK_LLM_API_KEY (the API's own precedence).
    assert _cfg(base, {**env, "OPENROUTER_API_KEY": "or"}).llm.api_key == "or"
    # --llm-base-url beats the environment; --concurrency beats AUTOGENBOOK_CONCURRENCY.
    cfg = _cfg(base + ["--llm-base-url", "http://localhost:1234/v1", "--concurrency", "2"], env)
    assert cfg.llm.base_url == "http://localhost:1234/v1" and cfg.concurrency == 2
    # Force-mini routes every role to the mini model.
    forced = _cfg(base, {**env, "AUTOGENBOOK_FORCE_MINI_MODEL": "1"})
    assert forced.llm.resolve("main") == "deepseek-v4.1-flash"


def test_paths_and_output_toggles(tmp_path: Path) -> None:
    out = tmp_path / "out"
    cfg = _cfg(["-i", "x.txt", "-o", str(out), "-j", "book_structure.json", "--use-json"], {})
    assert cfg.json_path == out.resolve() / "book_structure.json"  # -j relative to -o
    assert (cfg.md_output, cfg.tex_output, cfg.pdf_output) == (True, False, False)
    cfg = _cfg(["-i", "x.txt", "-o", str(out), "--export-tex", "--no-pdf"], {})
    assert (cfg.tex_output, cfg.pdf_output) == (True, False)
    cfg = _cfg(["-i", "x.txt", "-o", str(out), "--export-tex"], {})
    assert (cfg.tex_output, cfg.pdf_output) == (True, True)
    cfg = _cfg(["-i", "x.txt", "-o", str(out), "--no-tex", "--no-pdf"], {})
    assert (cfg.tex_output, cfg.pdf_output) == (False, False)
    cfg = _cfg(["-i", "x.txt", "-o", str(out), "--audit-book", "--audit-book-mode", "strict"], {})
    assert cfg.audit_enabled and cfg.audit_mode == "strict"
    assert not _cfg(["-i", "x.txt", "-o", str(out), "--audit-book", "--audit-book-mode", "off"], {}).audit_enabled
    paper = _cfg(["--mode", "paper", "-o", str(out)], {})
    assert paper.input_path.name == "paper_input.txt" and paper.json_path.name == "paper_structure.json"
    assert paper.tex_output and paper.pdf_output


def test_invalid_env_values_are_config_errors(tmp_path: Path) -> None:
    with pytest.raises(ConfigError):
        _cfg(["-i", "x", "-o", str(tmp_path)], {"AUTOGENBOOK_CONCURRENCY": "many"})
    with pytest.raises(ConfigError):
        _cfg(["-i", "x", "-o", str(tmp_path), "--concurrency", "0"], {})
    with pytest.raises(ConfigError):
        _cfg(["-i", "x", "-o", str(tmp_path)], {"AUTOGENBOOK_RERANK": "magic"})


def test_config_is_immutable_and_describe_hides_keys(tmp_path: Path) -> None:
    cfg = _cfg(["-i", "x", "-o", str(tmp_path)], {"AUTOGENBOOK_LLM_API_KEY": "secret"})
    with pytest.raises(Exception):
        cfg.concurrency = 9  # type: ignore[misc]
    assert "secret" not in json.dumps(cfg.describe(), default=str)


@pytest.mark.parametrize(
    "stage,prefix,api_stage",
    [
        ("kb", "[KB]", "kb"), ("json", "[JSON]", "json"), ("subdivide", "[SUBDIVIDE]", "subdivide"),
        ("generate", "[GEN]", "generate"), ("markdown", "[MD]", "markdown"), ("latex", "[LATEX]", "latex"),
        ("pdf", "[PDF]", "pdf"), ("resume", "[RESUME]", "resume"), ("info", "[INFO]", "info"),
        ("tokens", "[TOKENS]", "tokens"), ("cost", "[COST]", "cost"),
    ],
)
def test_every_stage_prints_its_contract_prefix(stage: str, prefix: str, api_stage: str) -> None:
    line = format_line(stage, "hello")
    assert line == f"{prefix} hello"
    assert parse_line(line) == (api_stage, "info", "hello")


def test_warnings_print_warn_and_messages_stay_single_line() -> None:
    assert format_line("generate", "boom", "warning") == "[WARN] boom"
    assert parse_line(format_line("generate", "boom", "warning"))[:2] == ("warning", "warning")
    assert format_line("kb", "a\nb\r\nc") == "[KB] a b  c"
    assert format_line("log", "plain") == "plain"


def test_stream_and_jsonl_sinks(tmp_path: Path) -> None:
    buffer = io.StringIO()
    memory = MemorySink()
    sink = CompositeSink(StreamSink(buffer), JsonlSink(tmp_path / "events.jsonl"), memory)
    sink.emit("generate", "Starting section 'A'", node_key="1-2", payload={"i": 1})
    sink.emit("generate", "hidden", level="debug")
    sink.close()
    assert buffer.getvalue() == "[GEN] Starting section 'A'\n"
    records = [json.loads(l) for l in (tmp_path / "events.jsonl").read_text(encoding="utf-8").splitlines()]
    assert records[0]["stage"] == "generate" and records[0]["node_key"] == "1-2" and records[0]["payload"] == {"i": 1}
    assert set(records[0]) == {"ts", "stage", "level", "node_key", "message", "payload"}
    assert len(records) == 2 and records[1]["level"] == "debug"
    assert memory.lines() == ["[GEN] Starting section 'A'"]


def test_reasoning_effort_env(tmp_path: Path) -> None:
    base = ["-i", "x", "-o", str(tmp_path)]
    assert _cfg(base, {}).llm.reasoning_effort is None
    assert _cfg(base, {"AUTOGENBOOK_LLM_REASONING_EFFORT": " Low "}).llm.reasoning_effort == "low"
    with pytest.raises(ConfigError, match="AUTOGENBOOK_LLM_REASONING_EFFORT"):
        _cfg(base, {"AUTOGENBOOK_LLM_REASONING_EFFORT": "tiny"})


def test_body_headings_flag_and_env(tmp_path: Path) -> None:
    base = ["-i", "x", "-o", str(tmp_path)]
    assert _cfg(base, {}).body_headings is False
    assert _cfg(base + ["--body-headings"], {}).body_headings is True
    assert _cfg(base, {"AUTOGENBOOK_BODY_HEADINGS": "1"}).body_headings is True
    assert _cfg(base, {"AUTOGENBOOK_BODY_HEADINGS": "off"}).body_headings is False
    assert _cfg(base, {}).describe()["body_headings"] is False
