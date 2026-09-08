# Static Analysis (FE + API)

Static code analysis for the web surfaces of this repo — the FastAPI service
(`api/`) and the React frontend (`app/src`) — using two complementary,
Docker-based tools. Neither requires network access beyond pulling images;
neither is wired into CI (this is a local/manual workflow for now).

Scope is deliberately limited to `api/` and `app/src`. The core CLI
(`autogenbook/`, `main.py`, `prompts/`, etc.) is kept as a mergeable fork of
upstream `pkonas/AutoGenBook` (see `CLAUDE.md`), so it's excluded to avoid
flagging code this repo doesn't intend to restyle.

If you're using Claude Code against this repo, `.claude/skills/static-analysis/`
is a project-wide skill that runs both tools end to end (including the
one-time SonarQube credential/token bootstrap below) and summarizes the
results — ask it to "run static analysis" / "run a Sonar scan" rather than
following the manual steps below yourself.

## Why two tools

- **SonarQube Community Edition**: coding-standards, maintainability, and
  duplication analysis with a persistent dashboard and quality gate, across
  both Python and TypeScript/TSX.
- **Semgrep**: SonarQube's Community Edition has real but limited
  security-vulnerability coverage — deep taint-based checks (SQL injection,
  XSS, SSRF, hardcoded secrets, etc. tracked across a call chain) are mostly
  a paid-tier (Developer Edition+) feature. Semgrep's free `p/security-audit`,
  `p/owasp-top-ten`, and `p/secrets` rulesets fill that gap and need no
  server.

Run Semgrep for security; run SonarQube for the standards/quality-gate view
and to track trend over time.

## SonarQube Community Edition

### First-time setup

```bash
# Linux only: SonarQube's embedded Elasticsearch needs this host-level.
sudo sysctl -w vm.max_map_count=262144

docker compose -f docker-compose.sonar.yml up -d sonarqube sonarqube-db
```

SonarQube takes 1-2 minutes to become ready. Watch `docker compose -f
docker-compose.sonar.yml logs -f sonarqube` for `SonarQube is operational`,
or just let `scripts/sonar_scan.sh` poll for you (below).

Then, once at `http://127.0.0.1:9000`:

1. Log in with the default `admin` / `admin` and set a new password when
   prompted.
2. Create a project manually (**Projects > Create Project > Local Project**),
   project key `autogenbook`, and choose **Locally** for analysis method.
3. Generate a project token (or **My Account > Security > Generate Token**)
   and copy it — SonarQube shows it only once.

### Running a scan

```bash
SONAR_TOKEN=<paste-the-token> scripts/sonar_scan.sh
```

This waits for SonarQube to report `UP`, then runs
`sonarsource/sonar-scanner-cli` against `sonar-project.properties` (repo
root), which scopes analysis to `api` and `app/src`, treats co-located
`*.test.ts(x)` and `tests/api/**` as test code, and excludes generated files
(`app/src/routeTree.gen.ts`, `app/src/api/schema.gen.ts`,
`api/infrastructure/db/alembic/versions/**`).

Results land at `http://127.0.0.1:9000/dashboard?id=autogenbook`.

### Optional: importing coverage

`sonar-project.properties` already points at report paths that don't exist
until you generate them:

```bash
(cd api && pytest ../tests/api --cov=. --cov-report=xml:coverage.xml)
(cd app && pnpm test:ci -- --coverage)   # writes app/coverage/lcov.info
```

Generate these before `scripts/sonar_scan.sh` if you want coverage-aware
findings (e.g. "uncovered lines in new code") on the dashboard.

### Stopping / tearing down

```bash
docker compose -f docker-compose.sonar.yml down          # keep data volumes
docker compose -f docker-compose.sonar.yml down -v        # also wipe them
```

## Semgrep

No server, no setup — one command:

```bash
scripts/semgrep_scan.sh            # human-readable findings to stdout
scripts/semgrep_scan.sh --json     # also writes semgrep-results.json (gitignored)
```

This runs the `semgrep/semgrep` image with `p/security-audit`,
`p/owasp-top-ten`, `p/secrets`, `p/python`, `p/typescript`, and `p/react`
rulesets against `api` and `app/src`, with the same generated-file
exclusions as the SonarQube config.

## What this doesn't cover

- No CI wiring yet — both tools run manually/locally. If this repo later
  wants a quality gate on PRs, SonarQube's GitHub Actions integration or a
  `semgrep ci` step would be the next addition — out of scope here.
- Dependency/SCA scanning (`pip-audit`, `npm audit`, Dependabot) is a
  separate concern from source static analysis and isn't included.
- The core CLI package (`autogenbook/`) is out of scope per the scoping note
  above.
