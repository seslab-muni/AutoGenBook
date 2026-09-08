#!/usr/bin/env bash
# Runs a SonarQube scan of api/ and app/src against a SonarQube server
# started via docker-compose.sonar.yml. See docs/STATIC_ANALYSIS.md.
#
# Usage:
#   docker compose -f docker-compose.sonar.yml up -d sonarqube sonarqube-db
#   SONAR_TOKEN=<project-token> scripts/sonar_scan.sh
#
# Optional coverage import (generate before running this script):
#   (cd api && pytest ../tests/api --cov=. --cov-report=xml:coverage.xml)
#   (cd app && pnpm test:ci -- --coverage)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ -z "${SONAR_TOKEN:-}" ]]; then
  echo "error: SONAR_TOKEN is not set. Generate a project token in SonarQube" >&2
  echo "  (My Account > Security) and re-run: SONAR_TOKEN=... $0" >&2
  exit 1
fi

LOCAL_SONAR_URL="http://127.0.0.1:${SONAR_PORT:-9000}"

echo "Waiting for SonarQube at ${LOCAL_SONAR_URL} to report status UP..."
status=""
for _ in $(seq 1 60); do
  status="$(curl -fsS "${LOCAL_SONAR_URL}/api/system/status" 2>/dev/null | grep -o '"status":"[A-Z]*"' || true)"
  if [[ "${status}" == '"status":"UP"' ]]; then
    break
  fi
  sleep 5
done
if [[ "${status}" != '"status":"UP"' ]]; then
  echo "error: SonarQube did not come up in time. Is it running?" >&2
  echo "  docker compose -f docker-compose.sonar.yml up -d sonarqube sonarqube-db" >&2
  exit 1
fi

docker compose -f docker-compose.sonar.yml run --rm sonar-scanner
