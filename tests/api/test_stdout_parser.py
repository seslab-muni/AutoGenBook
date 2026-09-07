from __future__ import annotations

import pytest

from api.infrastructure.cli.stdout_parser import parse_line


@pytest.mark.parametrize(
    ("line", "expected_stage", "expected_level", "expected_message"),
    [
        ("[KB] Buduji/nactivam znalostni databazi z: /tmp/kb", "kb", "info", "Buduji/nactivam znalostni databazi z: /tmp/kb"),
        ("[JSON] Trvani: 0.1s", "json", "info", "Trvani: 0.1s"),
        ("[SUBDIVIDE] Trvani: 0.2s", "subdivide", "info", "Trvani: 0.2s"),
        ("[GEN] Generuji obsah sekcí", "generate", "info", "Generuji obsah sekcí"),
        ("[MD] Skladam finalni Markdown vystup", "markdown", "info", "Skladam finalni Markdown vystup"),
        ("[LATEX] Exportuji TeX", "latex", "info", "Exportuji TeX"),
        ("[PDF] Kompiluji PDF", "pdf", "info", "Kompiluji PDF"),
        ("[RESUME] Preskakuji sekci", "resume", "info", "Preskakuji sekci"),
        ("[WARN] Chybejici citace", "warning", "warning", "Chybejici citace"),
        ("[INFO] Neco informativniho", "info", "info", "Neco informativniho"),
        ("[TOKENS] Celkem: 42", "tokens", "info", "Celkem: 42"),
        ("[COST] $0.01", "cost", "info", "$0.01"),
    ],
)
def test_known_prefixes_map_to_stage_and_level(line, expected_stage, expected_level, expected_message):
    stage, level, message = parse_line(line)
    assert stage == expected_stage
    assert level == expected_level
    assert message == expected_message


def test_warn_prefix_maps_to_warning_level():
    stage, level, _ = parse_line("[WARN] something looks off")
    assert level == "warning"


def test_gen_line_maps_to_generate_stage():
    stage, _, _ = parse_line("[GEN] Generuji obsah sekcí")
    assert stage == "generate"


def test_unrecognized_line_falls_back_to_log_info():
    stage, level, message = parse_line("Hotovo. Vystupy:")
    assert stage == "log"
    assert level == "info"
    assert message == "Hotovo. Vystupy:"


def test_strips_trailing_newline():
    stage, level, message = parse_line("[INFO] hello\n")
    assert message == "hello"


def test_empty_line():
    stage, level, message = parse_line("\n")
    assert stage == "log"
    assert level == "info"
    assert message == ""
