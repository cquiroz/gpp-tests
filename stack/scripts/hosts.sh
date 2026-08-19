#!/usr/bin/env bash
# Point the stack's hostnames at the local Caddy (spec §3).
#
# The browser must reach Explore and SSO under one registrable domain, because staging-mode
# SSO sets its refresh cookie with Domain=<cookie domain> and SameSite=Strict. On a GitHub
# runner this is a passwordless sudo; locally it prompts once.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

HOSTS_FILE="${HOSTS_FILE:-/etc/hosts}"
NAMES=(
  "explore.$GPP_TEST_DOMAIN"
  "sso.$GPP_TEST_DOMAIN"
  "odb.$GPP_TEST_DOMAIN"
  "itc.$GPP_TEST_DOMAIN"
  "prefs.$GPP_TEST_DOMAIN"
)

missing=()
for name in "${NAMES[@]}"; do
  grep -qE "^[^#]*[[:space:]]$name(\$|[[:space:]])" "$HOSTS_FILE" || missing+=("$name")
done

if [[ ${#missing[@]} -eq 0 ]]; then
  log "$HOSTS_FILE already resolves all ${#NAMES[@]} stack hostnames"
  exit 0
fi

line="127.0.0.1 ${missing[*]}"
log "adding to $HOSTS_FILE: $line"

if [[ -w "$HOSTS_FILE" ]]; then
  printf '\n# odbattr ephemeral stack\n%s\n' "$line" >> "$HOSTS_FILE"
elif command -v sudo >/dev/null 2>&1; then
  printf '\n# odbattr ephemeral stack\n%s\n' "$line" | sudo tee -a "$HOSTS_FILE" >/dev/null
else
  die "cannot write $HOSTS_FILE — add this line manually:
  $line"
fi

log "hostnames resolved"
