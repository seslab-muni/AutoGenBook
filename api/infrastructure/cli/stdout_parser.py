"""Parse one line of book-mode CLI stdout/stderr into `(stage, level, message)`.

The CLI (`autogenbook/pipelines/book_pipeline.py` and friends) reports
progress purely via `print()`, using a small set of `[TAG]` line prefixes.
This module is a straight lookup table from those prefixes to a
`(stage, level)` pair; unrecognized lines pass through as stage `"log"`,
level `"info"`.
"""

from __future__ import annotations

DEFAULT_STAGE = "log"
DEFAULT_LEVEL = "info"

# Prefix -> (stage, level). Order doesn't matter: no prefix here is a
# prefix of another.
PREFIX_TABLE: dict[str, tuple[str, str]] = {
    "[KB]": ("kb", "info"),
    "[JSON]": ("json", "info"),
    "[SUBDIVIDE]": ("subdivide", "info"),
    "[GEN]": ("generate", "info"),
    "[MD]": ("markdown", "info"),
    "[LATEX]": ("latex", "info"),
    "[PDF]": ("pdf", "info"),
    "[RESUME]": ("resume", "info"),
    "[WARN]": ("warning", "warning"),
    "[INFO]": ("info", "info"),
    "[TOKENS]": ("tokens", "info"),
    "[COST]": ("cost", "info"),
}


def parse_line(line: str) -> tuple[str, str, str]:
    """Return `(stage, level, message)` for one raw line of CLI output.

    The recognized `[TAG]` prefix (if any) and surrounding whitespace are
    stripped from `message`. Lines with no recognized prefix get
    `(DEFAULT_STAGE, DEFAULT_LEVEL, message)`.
    """
    stripped = line.rstrip("\r\n")
    for prefix, (stage, level) in PREFIX_TABLE.items():
        if stripped.startswith(prefix):
            return stage, level, stripped[len(prefix) :].strip()
    return DEFAULT_STAGE, DEFAULT_LEVEL, stripped.strip()
