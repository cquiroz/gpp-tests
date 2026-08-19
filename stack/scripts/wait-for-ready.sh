#!/usr/bin/env bash
# Readiness gate for the ephemeral stack (spec §3: "ready when ODB GraphQL responds and
# Hasura is healthy").
#
# Boot is slow and unevenly so: each JVM service runs its own Flyway migration first (900+
# ODB migrations from empty), and Hasura applies 48 prefs migrations. Everything is probed
# through Caddy, i.e. over exactly the paths the browser and k6 will use.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_cmd curl

TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS:-900}"
INTERVAL_SECONDS="${READY_INTERVAL_SECONDS:-5}"
# The internal CA is what we are booting; TLS trust is verified separately by trust-ca.sh.
CURL=(curl --silent --show-error --insecure --max-time 10)

deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))

# Prints an HTTP status, or 000 when the connection failed outright. curl already writes
# 000 in that case, so the fallback only covers curl printing nothing at all — appending a
# second 000 would produce "000000" and make every comparison below silently succeed.
http_status() {
  local status
  status="$("${CURL[@]}" --output /dev/null --write-out '%{http_code}' "$@" 2>/dev/null || true)"
  printf '%s' "${status:-000}"
}

# A JVM service behind Caddy answers 502/503 while it is still migrating; any real HTTP
# status (even 403 for an unauthenticated GraphQL call) means it is serving.
upstream_up() {
  local status
  status="$(http_status "$@")"
  [[ "$status" != "000" && "$status" != "502" && "$status" != "503" && "$status" != "504" ]]
}

check_odb() {
  upstream_up --request POST \
    --header 'content-type: application/json' \
    --data '{"query":"{__typename}"}' \
    "https://odb.$GPP_TEST_DOMAIN/odb"
}

# Also the first real exercise of the guest path the whole suite depends on (spec §4).
check_sso() {
  [[ "$(http_status --request POST "https://sso.$GPP_TEST_DOMAIN/api/v1/auth-as-guest")" == "201" ]]
}

check_hasura() {
  [[ "$(http_status "https://prefs.$GPP_TEST_DOMAIN/healthz")" == "200" ]]
}

check_itc() {
  upstream_up "https://itc.$GPP_TEST_DOMAIN/itc"
}

check_explore() {
  [[ "$(http_status "https://explore.$GPP_TEST_DOMAIN/")" == "200" ]]
}

# Our conf must win over the one baked into the upstream bundle, or Explore talks to the
# real dev environment — a silent, and very confusing, failure mode.
check_explore_conf() {
  "${CURL[@]}" "https://explore.$GPP_TEST_DOMAIN/environments.conf.json" \
    | grep -q "odb.$GPP_TEST_DOMAIN"
}

CHECKS=(check_sso check_odb check_itc check_hasura check_explore check_explore_conf)
# A space-delimited list rather than an associative array: stock /bin/bash on macOS is 3.2,
# which has no `declare -A`, and this script is run locally as often as in CI.
READY=" "
ready_count=0

is_ready() { [[ "$READY" == *" $1 "* ]]; }

log "waiting up to ${TIMEOUT_SECONDS}s for the stack to become ready"
while :; do
  for check in "${CHECKS[@]}"; do
    if is_ready "$check"; then continue; fi
    if "$check"; then
      READY="$READY$check "
      ready_count=$(( ready_count + 1 ))
      log "ready: ${check#check_}"
    fi
  done

  if [[ $ready_count -eq ${#CHECKS[@]} ]]; then
    log "stack is ready"
    exit 0
  fi

  if [[ $(date +%s) -ge $deadline ]]; then
    for check in "${CHECKS[@]}"; do
      is_ready "$check" || warn "never became ready: ${check#check_}"
    done
    warn "recent logs:"
    compose logs --tail 40 >&2 || true
    die "stack did not become ready within ${TIMEOUT_SECONDS}s"
  fi

  sleep "$INTERVAL_SECONDS"
done
