#!/usr/bin/env bash
# Ensures a working SonarQube project-analysis token for the "autogenbook"
# project and prints it on stdout (nothing else - callers do
# `TOKEN="$(bootstrap-token.sh)"`). Everything else goes to stderr.
#
# The token is cached outside the repo (~/.cache, never git) so this only
# needs to talk to SonarQube once per machine; later runs just validate the
# cached token and reuse it.
set -euo pipefail

SONAR_URL="http://127.0.0.1:${SONAR_PORT:-9000}"
PROJECT_KEY="autogenbook"
# Fixed and documented (not random) so a human can still log into the UI
# afterward - this is a loopback-only, throwaway local dev instance, not a
# real deployment; see SKILL.md.
LOCAL_ADMIN_PASSWORD="AutoGenBook-Local-Dev-1!"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/autogenbook-static-analysis"
TOKEN_FILE="${CACHE_DIR}/sonar-token"

token_is_valid() {
  local tok="$1"
  [[ -n "$tok" ]] || return 1
  curl -fsS -u "${tok}:" "${SONAR_URL}/api/authentication/validate" 2>/dev/null \
    | grep -q '"valid":true'
}

mkdir -p "$CACHE_DIR"

if [[ -f "$TOKEN_FILE" ]]; then
  cached="$(cat "$TOKEN_FILE")"
  if token_is_valid "$cached"; then
    echo "$cached"
    exit 0
  fi
  echo "Cached token no longer valid (instance reset?) - re-bootstrapping..." >&2
fi

# First-time setup on a fresh SonarQube instance: default admin/admin still
# works, and SonarQube requires the password to be changed before any other
# API call succeeds.
if curl -fsS -u admin:admin -X POST "${SONAR_URL}/api/users/change_password" \
    --data-urlencode "login=admin" \
    --data-urlencode "previousPassword=admin" \
    --data-urlencode "password=${LOCAL_ADMIN_PASSWORD}" >/dev/null 2>&1; then
  echo "Changed default admin password (now: ${LOCAL_ADMIN_PASSWORD} - loopback-only local dev instance)." >&2
elif curl -fsS -u admin:"${LOCAL_ADMIN_PASSWORD}" "${SONAR_URL}/api/authentication/validate" 2>/dev/null \
    | grep -q '"valid":true'; then
  : # admin/admin already changed to our own known password by a previous bootstrap run
else
  echo "error: no valid cached token, and neither admin/admin nor the local dev" >&2
  echo "  password (${LOCAL_ADMIN_PASSWORD}) works - someone changed the admin" >&2
  echo "  password to something else. Generate a project token yourself in" >&2
  echo "  SonarQube (My Account > Security > Generate Token, project key" >&2
  echo "  '${PROJECT_KEY}') and save it to: ${TOKEN_FILE}" >&2
  exit 1
fi

curl -fsS -u admin:"${LOCAL_ADMIN_PASSWORD}" -X POST "${SONAR_URL}/api/projects/create" \
  --data-urlencode "project=${PROJECT_KEY}" \
  --data-urlencode "name=AutoGenBook" >/dev/null 2>&1 || true # ignore "already exists"

token_json="$(curl -fsS -u admin:"${LOCAL_ADMIN_PASSWORD}" -X POST "${SONAR_URL}/api/user_tokens/generate" \
  --data-urlencode "name=static-analysis-skill-$(date +%s)" \
  --data-urlencode "type=PROJECT_ANALYSIS_TOKEN" \
  --data-urlencode "projectKey=${PROJECT_KEY}")"

token="$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['token'])" "$token_json")"
echo "$token" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
echo "Bootstrapped and cached a new project-analysis token at ${TOKEN_FILE}." >&2
echo "$token"
