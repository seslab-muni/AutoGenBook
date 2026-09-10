from __future__ import annotations

from pathlib import Path

import pytest

from api.core.settings import Settings
from api.domain.models import RunOptions
from api.infrastructure.cli.book_command import ENV_ALLOWLIST, FORCED_ENV, build_command


@pytest.fixture
def settings() -> Settings:
    return Settings(cli_python="python3", cli_entrypoint="main.py", repo_root="/repo")


@pytest.fixture
def work_dir(tmp_path: Path) -> Path:
    return tmp_path / "run-1"


def test_build_command_acceptance_criteria_example(settings: Settings, work_dir: Path):
    # RunOptions(outline="project", output_format="pdf") with a kb/ dir
    # present must produce exactly this fixed argv order.
    (work_dir / "kb").mkdir(parents=True)

    options = RunOptions(outline="project", output_format="pdf")
    argv, _env, cwd = build_command(work_dir, options, settings)

    assert argv == [
        "python3",
        "main.py",
        "--mode",
        "book",
        "-i",
        str(work_dir / "book_input.txt"),
        "-o",
        str(work_dir / "out"),
        "-j",
        "book_structure.json",
        "--use-json",
        "--kb-dir",
        str(work_dir / "kb"),
        "--export-tex",
    ]
    assert cwd == "/repo"


def test_outline_generate_uses_use_txt(settings: Settings, work_dir: Path):
    options = RunOptions(outline="generate", output_format="markdown")
    argv, _env, _cwd = build_command(work_dir, options, settings)

    assert "--use-txt" in argv
    assert "-j" not in argv
    assert "--use-json" not in argv


def test_output_format_markdown_disables_tex_and_pdf(settings: Settings, work_dir: Path):
    options = RunOptions(outline="generate", output_format="markdown")
    argv, _env, _cwd = build_command(work_dir, options, settings)

    assert argv[-2:] == ["--no-tex", "--no-pdf"]
    assert "--export-tex" not in argv


def test_output_format_latex_exports_tex_without_pdf(settings: Settings, work_dir: Path):
    options = RunOptions(outline="generate", output_format="latex")
    argv, _env, _cwd = build_command(work_dir, options, settings)

    assert argv[-2:] == ["--export-tex", "--no-pdf"]


def test_output_format_pdf_exports_tex_with_pdf(settings: Settings, work_dir: Path):
    options = RunOptions(outline="generate", output_format="pdf")
    argv, _env, _cwd = build_command(work_dir, options, settings)

    assert argv[-1] == "--export-tex"
    assert "--no-pdf" not in argv


def test_kb_dir_omitted_when_absent(settings: Settings, work_dir: Path):
    work_dir.mkdir(parents=True)  # no kb/ subdir created
    options = RunOptions(outline="generate", output_format="markdown")
    argv, _env, _cwd = build_command(work_dir, options, settings)

    assert "--kb-dir" not in argv


def test_kb_dir_included_when_present(settings: Settings, work_dir: Path):
    (work_dir / "kb").mkdir(parents=True)
    options = RunOptions(outline="generate", output_format="markdown")
    argv, _env, _cwd = build_command(work_dir, options, settings)

    assert "--kb-dir" in argv
    assert argv[argv.index("--kb-dir") + 1] == str(work_dir / "kb")


@pytest.mark.parametrize(
    ("field", "flag"),
    [
        ("rebuild_kb", "--rebuild-kb"),
        ("resume", "--resume"),
        ("enable_web_rag", "--enable-web-rag"),
        ("audit_book", "--audit-book"),
        ("legacy_tex", "--legacy-tex"),
        ("fail_fast_schema", "--fail-fast-schema"),
    ],
)
def test_boolean_flags_only_appear_when_true(settings: Settings, work_dir: Path, field, flag):
    off_options = RunOptions(outline="generate", output_format="markdown")
    on_options = RunOptions(outline="generate", output_format="markdown", **{field: True})

    off_argv, _env, _cwd = build_command(work_dir, off_options, settings)
    on_argv, _env, _cwd = build_command(work_dir, on_options, settings)

    assert flag not in off_argv
    assert flag in on_argv


def test_audit_book_mode_only_appended_when_non_default(settings: Settings, work_dir: Path):
    default_mode = RunOptions(outline="generate", output_format="markdown", audit_book=True)
    argv, _env, _cwd = build_command(work_dir, default_mode, settings)
    assert "--audit-book-mode" not in argv

    strict_mode = RunOptions(
        outline="generate", output_format="markdown", audit_book=True, audit_book_mode="strict"
    )
    argv, _env, _cwd = build_command(work_dir, strict_mode, settings)
    assert argv[argv.index("--audit-book-mode") + 1] == "strict"


def test_audit_book_mode_absent_when_audit_book_false(settings: Settings, work_dir: Path):
    options = RunOptions(
        outline="generate", output_format="markdown", audit_book=False, audit_book_mode="strict"
    )
    argv, _env, _cwd = build_command(work_dir, options, settings)
    assert "--audit-book" not in argv
    assert "--audit-book-mode" not in argv


def test_allow_subdivision_and_export_tex_only_have_no_flag(settings: Settings, work_dir: Path):
    # These RunOptions fields are modeled for forward compatibility (issue
    # #11 / future subdivision control) but have no CLI flag yet.
    options = RunOptions(
        outline="generate",
        output_format="markdown",
        allow_subdivision=False,
        export_tex_only=True,
    )
    argv, _env, _cwd = build_command(work_dir, options, settings)
    baseline, _env, _cwd = build_command(
        work_dir, RunOptions(outline="generate", output_format="markdown"), settings
    )
    assert argv == baseline


def test_cwd_is_repo_root_not_work_dir(settings: Settings, work_dir: Path):
    options = RunOptions(outline="generate", output_format="markdown")
    _argv, _env, cwd = build_command(work_dir, options, settings)
    assert cwd == settings.repo_root
    assert cwd != str(work_dir)


def test_kb_extract_cache_dir_always_set_from_settings(work_dir: Path):
    settings = Settings(
        cli_python="python3",
        cli_entrypoint="main.py",
        repo_root="/repo",
        kb_extract_cache_dir="/data/kb_cache",
    )
    options = RunOptions(outline="generate", output_format="markdown")
    _argv, env, _cwd = build_command(work_dir, options, settings)
    assert env["AUTOGENBOOK_KB_EXTRACT_CACHE_DIR"] == "/data/kb_cache"


def test_forced_env_does_not_force_assume_yes(work_dir: Path, settings: Settings):
    # `AUTOGENBOOK_ASSUME_YES=1` made `_ask_yes_no` answer *yes* everywhere,
    # including `book_pipeline.py`'s "Nahradit puvodni JSON touto revizi?",
    # whose interactive default is "no" - `AUTOGENBOOK_NONINTERACTIVE` alone
    # already makes every `_ask_*` helper fall through to its own default
    # instead of blocking on stdin (issue #79).
    options = RunOptions(outline="generate", output_format="markdown")
    _argv, env, _cwd = build_command(work_dir, options, settings)
    assert env["AUTOGENBOOK_NONINTERACTIVE"] == "1"
    assert "AUTOGENBOOK_ASSUME_YES" not in env


def test_author_env_var_set_when_author_given(settings: Settings, work_dir: Path):
    options = RunOptions(outline="generate", output_format="markdown")
    _argv, env, _cwd = build_command(work_dir, options, settings, author="Ada Lovelace, Alan Turing")
    assert env["AUTOGENBOOK_BOOK_AUTHOR"] == "Ada Lovelace, Alan Turing"


def test_author_env_var_omitted_when_author_blank(settings: Settings, work_dir: Path):
    options = RunOptions(outline="generate", output_format="markdown")
    _argv, env, _cwd = build_command(work_dir, options, settings)
    assert "AUTOGENBOOK_BOOK_AUTHOR" not in env
    _argv, env, _cwd = build_command(work_dir, options, settings, author="   ")
    assert "AUTOGENBOOK_BOOK_AUTHOR" not in env


def test_env_forwards_only_allowlisted_vars_present_in_parent(settings, work_dir, monkeypatch):
    for key in ENV_ALLOWLIST:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    monkeypatch.setenv("TAVILY_API_KEY", "tvly-test")
    # Should never leak through: not on the allow-list.
    monkeypatch.setenv("SOME_UNRELATED_SECRET", "leak-me-not")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "also-should-not-leak")

    options = RunOptions(outline="generate", output_format="markdown")
    _argv, env, _cwd = build_command(work_dir, options, settings)

    assert env["OPENROUTER_API_KEY"] == "sk-test"
    assert env["TAVILY_API_KEY"] == "tvly-test"
    assert "SOME_UNRELATED_SECRET" not in env
    assert "AWS_SECRET_ACCESS_KEY" not in env

    # Allow-listed vars absent from the parent must not appear at all.
    for key in ENV_ALLOWLIST:
        if key not in {"OPENROUTER_API_KEY", "TAVILY_API_KEY"}:
            assert key not in env

    for key, value in FORCED_ENV.items():
        assert env[key] == value

    assert env["AUTOGENBOOK_KB_EXTRACT_CACHE_DIR"] == settings.kb_extract_cache_dir

    # Nothing beyond the (present) allow-list + forced vars + the settings-derived
    # extraction-cache path (always set, regardless of the parent environment).
    assert set(env) <= set(ENV_ALLOWLIST) | set(FORCED_ENV) | {"AUTOGENBOOK_KB_EXTRACT_CACHE_DIR"}


def test_forced_env_overrides_parent_env(settings, work_dir, monkeypatch):
    monkeypatch.setenv("MCP_GATEWAY_ENABLE", "1")  # parent tries to enable it
    options = RunOptions(outline="generate", output_format="markdown")
    _argv, env, _cwd = build_command(work_dir, options, settings)
    assert env["MCP_GATEWAY_ENABLE"] == "0"


def test_llm_model_not_set_when_options_have_none(settings: Settings, work_dir: Path, monkeypatch):
    # A run's `options.llm_model` is only ever unset for a row persisted before issue #128 -
    # `build_command` shouldn't invent a value, just leave whatever (if anything) the parent
    # process's own environment already had.
    monkeypatch.delenv("AUTOGENBOOK_LLM_MODEL", raising=False)
    options = RunOptions(outline="generate", output_format="markdown")
    _argv, env, _cwd = build_command(work_dir, options, settings)
    assert "AUTOGENBOOK_LLM_MODEL" not in env


def test_llm_model_from_options_is_set_in_env(settings: Settings, work_dir: Path):
    options = RunOptions(
        outline="generate", output_format="markdown", llm_model="anthropic/claude-3.5-sonnet"
    )
    _argv, env, _cwd = build_command(work_dir, options, settings)
    assert env["AUTOGENBOOK_LLM_MODEL"] == "anthropic/claude-3.5-sonnet"


def test_llm_model_from_options_overrides_parent_env(
    settings: Settings, work_dir: Path, monkeypatch
):
    # Issue #128: the CLI subprocess must use this run's own resolved model, not whatever the
    # api/worker container's own `AUTOGENBOOK_LLM_MODEL` (a deployment-wide default, only ever
    # consulted for a *new* project without its own model) happens to be set to.
    monkeypatch.setenv("AUTOGENBOOK_LLM_MODEL", "openai/gpt-5-mini")
    options = RunOptions(
        outline="generate", output_format="markdown", llm_model="anthropic/claude-3.5-sonnet"
    )
    _argv, env, _cwd = build_command(work_dir, options, settings)
    assert env["AUTOGENBOOK_LLM_MODEL"] == "anthropic/claude-3.5-sonnet"
