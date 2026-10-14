#!/usr/bin/env bash
# Read production's dyno and Postgres sizing from Heroku (wayfinder ticket 027):
#
#   heroku login                          # once, as someone on the Gemini Heroku team
#   tools/read-production-sizing.sh       # writes out/production-sizing-<stamp>.txt
#
# Read-only: every call is a GET, either through the CLI (ps, addons, pg:info) or through the
# Platform API with the CLI's own token (formation, autoscaling monitors, app info). It
# answers the questions in research/production-shape.md §5:
#
#   - dyno type and quantity per process type on each production app, and autoscaling;
#   - pg:info for every database: plan, version, connections against the limit, data size;
#   - add-on plans (the ITC's Redis Cloud, the odb's Cloudcube and Mailgun);
#   - Private Space or Common Runtime, region and stack;
#   - the odb's *_MAX_CONNECTIONS overrides.
#
# It never prints a config value except the *_MAX_CONNECTIONS ones: for the rest of each app's
# config it prints the variable names only. pg:info shows no credentials. The token is passed
# to curl in a header and never echoed. The prefs (Hasura) app's name is not known; the script
# lists every app with "production" or "prefs" in its name that the login can see, and
# PREFS_APP=<name> adds it to the apps read.
#
# A command the login has no access to is recorded as such and the script carries on, so a
# partial read still lands in the file. Paste the file's findings into research/production-
# shape.md §1 (or hand the file to Claude), then close ticket 027.
set -uo pipefail
cd "$(dirname "$0")/.."

apps=(lucuma-postgres-odb-production lucuma-sso-production itc-production lucuma-resource-production)
[[ -n "${PREFS_APP:-}" ]] && apps+=("$PREFS_APP")

if ! command -v heroku >/dev/null || ! command -v jq >/dev/null; then
  echo "needs the heroku CLI and jq on PATH" >&2
  exit 2
fi
if ! account=$(heroku auth:whoami 2>/dev/null); then
  echo "the heroku CLI is not logged in (or its token is stale): run 'heroku login' first" >&2
  exit 2
fi
token=$(heroku auth:token 2>/dev/null) || { echo "could not read the CLI's token" >&2; exit 2; }

mkdir -p out
stamp=$(date -u +%Y%m%dT%H%M%SZ)
file="out/production-sizing-$stamp.txt"

api() {
  curl -fsS "https://api.heroku.com$1" \
    -H "Accept: application/vnd.heroku+json; version=3" \
    -H "Authorization: Bearer $token"
}

section() { printf '\n==> %s\n' "$*"; }

# Run a command, keep its output, and say so plainly when it fails.
try() {
  local out
  if out=$("$@" 2>&1); then
    printf '%s\n' "$out"
  else
    printf '(failed: %s)\n%s\n' "$*" "$(printf '%s\n' "$out" | grep -v -i 'update available' | head -3)"
  fi
}

{
  echo "production sizing read $stamp by $account (ticket 027)"

  section "apps this login can see (production or prefs in the name)"
  try sh -c "heroku apps --all --json 2>/dev/null | jq -r '.[] | select(.name | test(\"production|prefs\")) | \"\(.name)\t\(.space.name // \"common runtime\")\t\(.region.name)\"'"

  for app in "${apps[@]}"; do
    section "$app"

    echo "-- app: region, Private Space, stack"
    if info=$(api "/apps/$app" 2>/dev/null); then
      jq '{region: .region.name, space: .space.name, internal_routing, stack: .build_stack.name, team: .team.name}' <<<"$info"
    else
      echo "(failed: GET /apps/$app — no access, or no such app)"
    fi

    echo "-- formation: process type, size, quantity"
    formation=$(api "/apps/$app/formation" 2>/dev/null) || formation=""
    if [[ -n "$formation" ]]; then
      jq -r '.[] | "\(.type)\t\(.size)\t× \(.quantity)"' <<<"$formation"
      echo "-- autoscaling monitors per process type (empty: none configured)"
      for type in $(jq -r '.[].type' <<<"$formation"); do
        monitors=$(api "/apps/$app/formation/$type/monitors" 2>/dev/null) || monitors="(not readable)"
        printf '%s\t%s\n' "$type" "$(jq -c '[.[] | {action_type, is_active, min_quantity, max_quantity, value, operation}]' <<<"$monitors" 2>/dev/null || echo "$monitors")"
      done
    else
      echo "(failed: GET /apps/$app/formation — no access, or no such app)"
    fi

    echo "-- dynos running now"
    try heroku ps -a "$app"

    echo "-- add-ons and plans"
    try heroku addons -a "$app"

    echo "-- databases (pg:info, every attached Postgres)"
    try heroku pg:info -a "$app"

    echo "-- config: *_MAX_CONNECTIONS values, every other variable by name only"
    config=$(api "/apps/$app/config-vars" 2>/dev/null) || config=""
    if [[ -n "$config" ]]; then
      jq -r 'to_entries[] | select(.key | test("MAX_CONNECTIONS$")) | "\(.key)=\(.value)"' <<<"$config"
      jq -r '[keys[] | select(test("MAX_CONNECTIONS$") | not)] | "names: " + join(" ")' <<<"$config"
    else
      echo "(failed: GET /apps/$app/config-vars — no access)"
    fi
  done
} 2>&1 | tee "$file"

echo
echo "saved $file"
