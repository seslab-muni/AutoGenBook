"""Markdown -> LaTeX with pandoc and our own template; LaTeX -> PDF with LuaLaTeX.

`pylatex`/`latex2markdown` are not used. The LaTeX input is the same
assembled Markdown (numbered references included), so both outputs share one
citation numbering. LuaLaTeX runs in a private temporary directory, so no
`.aux`/`.toc` litter ends up in `out/` (every file there is uploaded); the
compile log is kept as `out/logs/<name>.latex.log`.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"
BABEL_LANGUAGES = {
    "cs": "czech",
    "sk": "slovak",
    "en": "english",
    "de": "ngerman",
    "pl": "polish",
    "fr": "french",
    "es": "spanish",
    "it": "italian",
    "pt": "portuguese",
    "nl": "dutch",
    "hu": "magyar",
    "uk": "ukrainian",
}
_ERROR_LINE_RE = re.compile(r"^(?:! .+|.+:\d+: .+)$", re.MULTILINE)


class LatexError(RuntimeError):
    pass


def pandoc_available() -> bool:
    return shutil.which("pandoc") is not None


def lualatex_available() -> bool:
    return shutil.which("lualatex") is not None


def babel_language(language: str) -> str:
    """Babel option for `language`, falling back to English when the TeX
    installation lacks that language's `.ldf` (the Docker image ships Czech,
    Slovak and English)."""
    name = BABEL_LANGUAGES.get(language, "english")
    if name == "english" or not shutil.which("kpsewhich"):
        return name
    try:
        found = subprocess.run(
            ["kpsewhich", f"{name}.ldf"], capture_output=True, text=True, timeout=20, check=False
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return name
    return name if found else "english"


def markdown_to_latex(
    markdown_body: str,
    out_tex: Path,
    *,
    title: str,
    author: str,
    language: str,
    template: str = "book.latex",
    top_level: str = "chapter",
    documentclass: str | None = None,
    raw_tex: bool = False,
    graphics_path: Path | None = None,
    abstract: str | None = None,
    extra_args: list[str] | None = None,
    toc: bool = True,
) -> Path:
    """Convert the assembled Markdown body (top-level headings at `##`) into a
    standalone `.tex`. `raw_tex` lets LaTeX commands in legacy `.tex` sections
    through; generated Markdown sections are converted with it off, so a stray
    backslash from a model is escaped instead of breaking the build."""
    if not pandoc_available():
        raise LatexError("pandoc is required for LaTeX export (install pandoc)")
    # No auto identifiers: babel-czech makes `-` active, which breaks \\label
    # names read back from the .aux; the book has no internal cross-references.
    extensions = "markdown+tex_math_dollars+tex_math_single_backslash+pipe_tables+grid_tables-implicit_figures-auto_identifiers"
    extensions += "+raw_tex" if raw_tex else "-raw_tex"
    args = [
        "pandoc",
        f"--from={extensions}",
        "--to=latex",
        "--standalone",
        f"--template={TEMPLATES_DIR / template}",
        f"--top-level-division={top_level}",
        "--shift-heading-level-by=-1",
        "--no-highlight",
        "--wrap=none",
        "-M", f"title={title}",
        "-V", f"babel-lang={babel_language(language)}",
        "-V", f"lang={language}",
    ]
    if author:
        args += ["-M", f"author={author}"]
    if documentclass:
        args += ["-V", f"documentclass={documentclass}"]
    if toc:
        args += ["-V", "toc=true"]
    if raw_tex:
        args += ["-V", "legacy-compat=true"]
    if graphics_path is not None:
        args += ["-V", f"graphics-path={graphics_path.as_posix().rstrip('/')}/"]
    if abstract:
        args += ["-M", f"abstract={abstract}"]
    args += list(extra_args or [])
    proc = subprocess.run(
        args, input=markdown_body, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600, check=False
    )
    if proc.returncode != 0:
        raise LatexError(f"pandoc failed: {(proc.stderr or proc.stdout).strip()[:1000]}")
    out_tex.parent.mkdir(parents=True, exist_ok=True)
    out_tex.write_text(proc.stdout, encoding="utf-8")
    return out_tex


@dataclass
class CompileResult:
    ok: bool
    pdf_path: Path | None
    errors: list[str]
    log_path: Path | None


def compile_pdf(
    tex_path: Path,
    out_pdf: Path,
    *,
    log_dir: Path | None = None,
    runs: int = 2,
    bibtex: bool = False,
    timeout_s: int = 900,
    engine: str = "lualatex",
) -> CompileResult:
    """Compile `tex_path` in a temporary directory; copy the PDF to `out_pdf`.

    Runs in nonstop mode and accepts the PDF when one is produced, reporting
    the TeX errors it hit (a malformed table must not cost the whole book)."""
    if not shutil.which(engine):
        raise LatexError(f"{engine} is required for PDF export")
    with tempfile.TemporaryDirectory(prefix="engine_latex_") as tmp:
        work = Path(tmp)
        src = work / tex_path.name
        shutil.copyfile(tex_path, src)
        for extra in tex_path.parent.glob("*.bib"):
            shutil.copyfile(extra, work / extra.name)
        env = dict(os.environ)
        env.setdefault("TEXMFVAR", str(work / ".texmf-var"))
        log_text = ""

        def latex_pass() -> None:
            nonlocal log_text
            proc = subprocess.run(
                [engine, "-interaction=nonstopmode", "-file-line-error", src.name],
                cwd=work, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=timeout_s, check=False,
            )
            log_file = work / (src.stem + ".log")
            log_text = log_file.read_text(encoding="utf-8", errors="replace") if log_file.exists() else proc.stdout

        latex_pass()
        if bibtex and shutil.which("bibtex"):
            subprocess.run(["bibtex", src.stem], cwd=work, env=env, capture_output=True, text=True, timeout=300, check=False)
            latex_pass()
        for _ in range(max(0, runs - 1)):
            latex_pass()
        pdf = work / (src.stem + ".pdf")
        errors = sorted(set(_ERROR_LINE_RE.findall(log_text)))[:20]
        log_path = None
        if log_dir is not None:
            log_dir.mkdir(parents=True, exist_ok=True)
            log_path = log_dir / f"{src.stem}.latex.log"
            log_path.write_text(log_text, encoding="utf-8")
        if pdf.exists() and pdf.stat().st_size > 0:
            out_pdf.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(pdf, out_pdf)
            return CompileResult(True, out_pdf, errors, log_path)
        return CompileResult(False, None, errors or ["no PDF produced"], log_path)
