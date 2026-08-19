#!/usr/bin/env bash
# Shared helpers for the stack scripts. Source it, don't run it.

set -euo pipefail

STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$STACK_DIR/.." && pwd)"
export STACK_DIR REPO_DIR

GPP_TEST_DOMAIN="${GPP_TEST_DOMAIN:-gpp-test.internal}"
export GPP_TEST_DOMAIN

GENERATED_ENV="$STACK_DIR/.env.generated"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

require_cmd() {
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || die "required command not found: $cmd"
  done
}

# All compose invocations go through here so the project name, file and generated
# environment are identical everywhere (including teardown).
compose() {
  docker compose \
    --project-name "${COMPOSE_PROJECT_NAME:-odbattr}" \
    --file "$STACK_DIR/docker-compose.yml" \
    "$@"
}

# Load what previous bootstrap steps generated (keys, service JWT). Safe to call when the
# file does not exist yet.
load_generated_env() {
  if [[ -f "$GENERATED_ENV" ]]; then
    # shellcheck disable=SC1090
    source "$GENERATED_ENV"
  fi
}

# The list of services whose image digests are recorded with each run, so a red run can be
# attributed to the day's commits (spec §3).
STACK_IMAGE_SERVICES=(sso odb itc obscalc)
export STACK_IMAGE_SERVICES
