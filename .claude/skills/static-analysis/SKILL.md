---
name: static-analysis
description: Run SonarQube + Semgrep static analysis over api/ and app/src (this repo's Docker-based setup, docs/STATIC_ANALYSIS.md) and summarize the bugs, vulnerabilities, and code smells found. Use when asked to run a Sonar/SonarQube scan, run Semgrep, run static analysis, or check/summarize code quality or security findings for this repo.
---

# Static analysis: run + summarize

This repo has a Docker-based static-analysis setup for `api/` and `app/src`
(the core CLI is out of scope - see `docs/STATIC_ANALYSIS.md`): SonarQube
Community Edition for coding standards/maintainability, and Semgrep for the
deeper security-vulnerability coverage Community Edition's free tier lacks.
This skill runs both and turns the raw output into a readable report.

## 1. Run SonarQube and fetch its findings

```bash
.claude/skills/static-analysis/run-sonar-scan.sh
```

This one command: starts the `sonarqube`/`sonarqube-db` containers if they
aren't already running, waits for SonarQube to come up, gets a working
project-analysis token (bootstraps one automatically on a fresh instance -
see "First-time bootstrap" below - or reuses a cached one), runs the scanner,
waits for SonarQube to finish processing the analysis, and prints a
structured report: overall measures, every bug/vulnerability in full detail,
and a code-smell breakdown by severity/rule/directory plus full detail for
BLOCKER/CRITICAL smells.

Takes 1-3 minutes on a cold start (SonarQube boot), a few seconds on a warm
one (containers already running, token cached).

## 2. Run Semgrep

```bash
scripts/semgrep_scan.sh
```

No server, no setup, ~30-60s. Covers taint-based security rules (SQLi, XSS,
SSRF, secrets, etc.) that SonarQube's free tier mostly doesn't.

## 3. Summarize both for the user

Don't just paste the raw output. Read through it and produce a summary in
this shape:

- **Bugs + vulnerabilities first, with real code context.** For each one,
  use the Read tool to pull the actual surrounding code (not just the
  Sonar/Semgrep message) and give your own read on whether it's a real,
  actionable issue or a low-stakes/context-dependent finding (e.g. a
  `Math.random()` fallback that's never used for anything
  security-sensitive is a very different risk than one seeding a session
  token) - say which, and why, rather than repeating the tool's message
  verbatim. Cite `file:line`.
- **Code smells grouped by theme, not listed one by one.** Use the
  severity/rule/directory facets from the report to group findings (e.g.
  "cognitive complexity, 14 functions, worst offenders: ...", "duplicated
  SQL string literals in models.py", "React prop-readonly rule, 59 hits,
  mechanical/low-value unless you want to lint for it going forward").
  Call out which groups are genuinely worth fixing vs. which are
  low-value/stylistic - don't present all 200+ as equally important.
  Mention directory hotspots if the facet data shows a clear concentration.
- **Note the dashboard URL** (printed by `run-sonar-scan.sh`) so the user can
  browse the full detail themselves.
- End by asking whether they want any of it fixed now, rather than fixing
  proactively - this skill's job is to run and summarize, not to fix.

## First-time bootstrap (only matters if you're curious/debugging)

`bootstrap-token.sh` handles SonarQube's default-credentials flow
automatically: on a genuinely fresh instance, `admin`/`admin` still works,
so it changes the password to a fixed, documented local-dev value
(`AutoGenBook-Local-Dev-1!` - loopback-only, throwaway, not a real
deployment) rather than a random one, so a human can still log into
`http://127.0.0.1:9000` afterward if they want to browse interactively. It
then creates the `autogenbook` project and a project-analysis token, and
caches that token outside the repo
(`~/.cache/autogenbook-static-analysis/sonar-token`) so later runs skip all
of this and just reuse it. If someone has already changed the admin
password to something else *and* there's no valid cached token, the script
fails with instructions to generate a token manually via the UI - it can't
guess a password it was never told.

## If you only need one signal quickly

Semgrep alone (step 2) is enough if the ask is specifically about security
vulnerabilities and doesn't need the standards/maintainability view - it's
much faster since there's no server to start.
