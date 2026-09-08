#!/usr/bin/env python3
"""Fetch the current SonarQube analysis results for the "autogenbook" project
and print a structured plain-text report to stdout: overall measures, every
bug/vulnerability with full detail, and a code-smell breakdown (by severity,
rule, and directory) plus full detail for BLOCKER/CRITICAL smells.

This only *reports* what SonarQube found - it deliberately doesn't try to
guess which findings are real vs. false-positive-in-context (e.g. "is this
Math.random() call actually security-sensitive?"). That judgment needs to
read the surrounding code, which is what the invoking skill instructions do
with this report as input.

Usage: SONAR_TOKEN=... fetch-findings.py [project_key]
"""

from __future__ import annotations

import json
import os
import sys
import urllib.parse
import urllib.request

SONAR_URL = f"http://127.0.0.1:{os.environ.get('SONAR_PORT', '9000')}"
PROJECT_KEY = sys.argv[1] if len(sys.argv) > 1 else "autogenbook"
TOKEN = os.environ.get("SONAR_TOKEN")
if not TOKEN:
    print("error: SONAR_TOKEN is not set", file=sys.stderr)
    raise SystemExit(1)


def api_get(path: str, params: dict) -> dict:
    url = f"{SONAR_URL}{path}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(url)
    request.add_header(
        "Authorization",
        "Basic " + __import__("base64").b64encode(f"{TOKEN}:".encode()).decode(),
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def print_header(title: str) -> None:
    print(f"\n=== {title} ===")


def print_measures() -> None:
    data = api_get(
        "/api/measures/component",
        {
            "component": PROJECT_KEY,
            "metricKeys": "bugs,vulnerabilities,code_smells,security_hotspots,ncloc",
        },
    )
    print_header("Overall measures")
    for measure in data["component"]["measures"]:
        print(f"  {measure['metric']}: {measure['value']}")


def print_bugs_and_vulnerabilities() -> None:
    data = api_get(
        "/api/issues/search",
        {"componentKeys": PROJECT_KEY, "types": "BUG,VULNERABILITY", "ps": 200},
    )
    print_header(f"Bugs + vulnerabilities ({data['total']} total)")
    for issue in data["issues"]:
        path = issue["component"].split(":", 1)[1]
        print(
            f"  [{issue['type']}/{issue['severity']}] {path}:{issue.get('line', '?')} "
            f"({issue['rule']})\n      {issue['message']}"
        )


def rule_name(rule_key: str) -> str:
    data = api_get("/api/rules/show", {"key": rule_key})
    return data["rule"]["name"]


def print_code_smells() -> None:
    facet_data = api_get(
        "/api/issues/search",
        {
            "componentKeys": PROJECT_KEY,
            "types": "CODE_SMELL",
            "ps": 1,
            "facets": "rules,severities,directories",
        },
    )
    print_header(f"Code smells ({facet_data['total']} total) - by severity")
    facets = {f["property"]: f["values"] for f in facet_data["facets"]}
    for value in facets.get("severities", []):
        print(f"  {value['val']}: {value['count']}")

    print_header("Code smells - top rules (resolving names)")
    for value in facets.get("rules", [])[:20]:
        try:
            name = rule_name(value["val"])
        except Exception:
            name = "(name lookup failed)"
        print(f"  {value['count']:>4}  {value['val']:<22} {name}")

    print_header("Code smells - by directory")
    for value in facets.get("directories", [])[:20]:
        print(f"  {value['count']:>4}  {value['val']}")

    detail_data = api_get(
        "/api/issues/search",
        {
            "componentKeys": PROJECT_KEY,
            "types": "CODE_SMELL",
            "severities": "BLOCKER,CRITICAL",
            "ps": 100,
        },
    )
    print_header(
        f"Code smells - full detail for BLOCKER/CRITICAL ({detail_data['total']} total)"
    )
    for issue in detail_data["issues"]:
        path = issue["component"].split(":", 1)[1]
        print(
            f"  [{issue['severity']}] {path}:{issue.get('line', '?')} "
            f"({issue['rule']})\n      {issue['message']}"
        )


def main() -> None:
    print(f"SonarQube dashboard: {SONAR_URL}/dashboard?id={PROJECT_KEY}")
    print_measures()
    print_bugs_and_vulnerabilities()
    print_code_smells()


if __name__ == "__main__":
    main()
