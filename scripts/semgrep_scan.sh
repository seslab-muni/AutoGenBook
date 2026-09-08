#!/usr/bin/env bash
# Deeper security scan of api/ and app/src using Semgrep's free registry
# rulesets (taint-based checks SonarQube Community Edition doesn't cover:
# SQLi, XSS, SSRF, secrets, etc.). See docs/STATIC_ANALYSIS.md.
#
# Usage:
#   scripts/semgrep_scan.sh            # human-readable report to stdout
#   scripts/semgrep_scan.sh --json     # also write semgrep-results.json
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

RULESETS=(
  p/security-audit
  p/owasp-top-ten
  p/secrets
  p/python
  p/typescript
  p/react
)
CONFIG_ARGS=()
for ruleset in "${RULESETS[@]}"; do
  CONFIG_ARGS+=(--config "${ruleset}")
done

EXTRA_ARGS=()
if [[ "${1:-}" == "--json" ]]; then
  EXTRA_ARGS+=(--json --output /src/semgrep-results.json)
fi

docker run --rm \
  -v "$(pwd):/src" \
  -w /src \
  semgrep/semgrep \
  semgrep scan \
    "${CONFIG_ARGS[@]}" \
    --exclude app/_reference \
    --exclude app/node_modules \
    --exclude app/dist \
    --exclude app/src/routeTree.gen.ts \
    --exclude app/src/api/schema.gen.ts \
    --exclude app/src/components/ui \
    --exclude api/infrastructure/db/alembic/versions \
    "${EXTRA_ARGS[@]}" \
    api app/src
