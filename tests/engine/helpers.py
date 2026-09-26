"""Helpers shared by the engine tests (importable as `helpers` from any test
module in this directory)."""

from __future__ import annotations

import importlib.util
import shutil

import pytest


def _have(binary: str) -> bool:
    return shutil.which(binary) is not None


def _have_module(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


requires_pandoc = pytest.mark.skipif(not _have("pandoc"), reason="pandoc not installed")
requires_lualatex = pytest.mark.skipif(
    not (_have("pandoc") and _have("lualatex")), reason="pandoc/lualatex not installed"
)
requires_tesseract = pytest.mark.skipif(
    not (_have("tesseract") and _have_module("pytesseract")), reason="tesseract not installed"
)
requires_libreoffice = pytest.mark.skipif(
    not (_have("libreoffice") or _have("soffice")), reason="libreoffice not installed"
)


