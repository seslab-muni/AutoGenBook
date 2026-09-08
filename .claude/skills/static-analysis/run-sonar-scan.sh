#!/usr/bin/env bash
# Starts SonarQube (if not already up), bootstraps/reuses a project-analysis
# token, runs the scan, waits for SonarQube to finish processing it, then
# prints the findings report (fetch-findings.py). One command, safe to
# re-run any time - see ../../../docs/STATIC_ANALYSIS.md for the underlying
# pieces this wires together.
set -euo pipefail
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

SONAR_URL="http://127.0.0.1:${SONAR_PORT:-9000}"

echo "Starting SonarQube (if not already running)..." >&2
docker compose -f docker-compose.sonar.yml up -d sonarqube sonarqube-db >&2

echo "Waiting for SonarQube to report status UP..." >&2
status=""
for _ in $(seq 1 60); do
  status="$(curl -fsS "${SONAR_URL}/api/system/status" 2>/dev/null | grep -o '"status":"[A-Z]*"' || true)"
  [[ "$status" == '"status":"UP"' ]] && break
  sleep 5
done
if [[ "$status" != '"status":"UP"' ]]; then
  echo "error: SonarQube did not come up in time" >&2
  exit 1
fi

echo "Getting a project-analysis token..." >&2
TOKEN="$("$SKILL_DIR/bootstrap-token.sh")"
export SONAR_TOKEN="$TOKEN"

echo "Running the scan..." >&2
scan_output="$(./scripts/sonar_scan.sh 2>&1)"
echo "$scan_output" >&2

task_id="$(python3 -c "
import re, sys
m = re.search(r'api/ce/task\?id=([\w-]+)', sys.argv[1])
print(m.group(1) if m else '')
" "$scan_output")"

if [[ -n "$task_id" ]]; then
  echo "Waiting for SonarQube to finish processing analysis task ${task_id}..." >&2
  for _ in $(seq 1 30); do
    task_status="$(curl -fsS -u "${TOKEN}:" "${SONAR_URL}/api/ce/task?id=${task_id}" \
      | python3 -c "import json,sys; print(json.load(sys.stdin)['task']['status'])" 2>/dev/null || true)"
    [[ "$task_status" == "SUCCESS" ]] && break
    if [[ "$task_status" == "FAILED" || "$task_status" == "CANCELED" ]]; then
      echo "error: analysis task ended with status ${task_status}" >&2
      exit 1
    fi
    sleep 3
  done
else
  echo "Couldn't find a task id in scanner output, waiting a fixed 12s instead..." >&2
  sleep 12
fi

SONAR_TOKEN="$TOKEN" python3 "$SKILL_DIR/fetch-findings.py"
