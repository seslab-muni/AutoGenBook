"""Audit of the assembled document (runs on the Markdown, writes audit_report.json).

Checks: unknown citation keys (error), images that do not exist (error),
empty/missing sections (warning), leftover placeholders (warning) and,
optionally, numeric claims without a nearby citation (warning; on for paper,
off for book as in the old engine). Strict mode turns any error into exit 4
and blocks PDF emission.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from engine.assemble.citations import CitationIndex, find_citations
from engine.util.fs import atomic_write_json

_IMAGE_RE = re.compile(r"!\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
_PLACEHOLDER_RE = re.compile(
    r"\b(TODO|TBD|FIXME|lorem ipsum|\[citation needed\]|general background knowledge|XXX)\b", re.IGNORECASE
)
_NUMBER_RE = re.compile(r"(?<![\w.])\d+(?:[.,]\d+)?\s*(?:%|percent|procent)|\b\d{2,}(?:[.,]\d+)?\b")


@dataclass
class Finding:
    severity: str  # error | warning | info
    code: str
    message: str
    node_key: str | None = None
    excerpt: str = ""


@dataclass
class AuditReport:
    mode: str
    findings: list[Finding] = field(default_factory=list)

    @property
    def counts_by_severity(self) -> dict[str, int]:
        counts = {"error": 0, "warning": 0, "info": 0}
        for f in self.findings:
            counts[f.severity] = counts.get(f.severity, 0) + 1
        return counts

    @property
    def errors(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "error"]

    def to_json(self) -> dict[str, Any]:
        return {
            "created_at": datetime.now(timezone.utc).isoformat(),
            "mode": self.mode,
            "counts_by_severity": self.counts_by_severity,
            "findings": [asdict(f) for f in self.findings],
        }

    def dump(self, path: Path) -> None:
        atomic_write_json(path, self.to_json())


def _excerpt(text: str, start: int, end: int, radius: int = 60) -> str:
    return re.sub(r"\s+", " ", text[max(0, start - radius) : end + radius]).strip()


def audit_sections(
    sections: list[tuple[str, str]],
    *,
    index: CitationIndex,
    out_dir: Path,
    mode: str,
    missing: list[str] | None = None,
    check_numeric_claims: bool = False,
    window_chars: int = 600,
) -> AuditReport:
    report = AuditReport(mode=mode)
    for key in missing or []:
        report.findings.append(Finding("warning", "MISSING_SECTION", "Section has no generated content", key))
    for key, body in sections:
        if not body.strip():
            report.findings.append(Finding("warning", "EMPTY_SECTION", "Section body is empty", key))
            continue
        matches = find_citations(body, index)
        for match in matches:
            for token in match.keys:
                if not index.known(token):
                    report.findings.append(
                        Finding("error", "UNKNOWN_CITE_KEY", f"Citation '{token}' is not in the knowledge base index",
                                key, _excerpt(body, match.start, match.end))
                    )
        for match in _IMAGE_RE.finditer(body):
            target = match.group(1)
            if target.startswith(("http://", "https://", "data:")):
                continue
            path = (out_dir / target).resolve() if not Path(target).is_absolute() else Path(target)
            if not path.exists():
                report.findings.append(
                    Finding("error", "MISSING_FIGURE", f"Image '{target}' does not exist", key, _excerpt(body, match.start(), match.end()))
                )
        for match in _PLACEHOLDER_RE.finditer(body):
            report.findings.append(
                Finding("warning", "PLACEHOLDER", f"Placeholder text '{match.group(0)}'", key, _excerpt(body, match.start(), match.end()))
            )
        if check_numeric_claims:
            cite_positions = [m.start for m in matches]
            for match in _NUMBER_RE.finditer(body):
                if not any(abs(pos - match.start()) <= window_chars for pos in cite_positions):
                    report.findings.append(
                        Finding("warning", "NUMERIC_CLAIM_NO_EVIDENCE", "Numeric claim without a nearby citation", key,
                                _excerpt(body, match.start(), match.end()))
                    )
    return report
