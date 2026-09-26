"""Contract 3.1: invocation (argv, exit codes, non-interactivity).

One test per contract item of docs/ENGINE_REWRITE.md section 3. Skipped until
the phase that implements it (#151).
"""

from __future__ import annotations

import pytest


def test_accepts_every_argv_book_command_builds() -> None:
    """Every argv `api/infrastructure/cli/book_command.py:build_command` can emit parses (outline x format x per-run flags)."""
    pytest.skip("pending: implemented in phase #151")


def test_rejects_unknown_flags_with_exit_2() -> None:
    """An unknown flag exits 2, like argparse in the old CLI and fake_cli.py."""
    pytest.skip("pending: implemented in phase #151")


def test_legacy_tex_is_accepted_and_ignored() -> None:
    """`--legacy-tex` is accepted and has no effect (Markdown-first only)."""
    pytest.skip("pending: implemented in phase #151")


def test_missing_input_file_fails_non_zero() -> None:
    """A missing `-i` file exits non-zero without a traceback."""
    pytest.skip("pending: implemented in phase #151")


def test_never_reads_stdin() -> None:
    """Runs with stdin closed and AUTOGENBOOK_NONINTERACTIVE/ASSUME_YES set or unset."""
    pytest.skip("pending: implemented in phase #151")
