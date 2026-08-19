#!/usr/bin/env bash
# Tear the ephemeral stack down, volumes included (spec §3: every run starts from empty).
#
#   stack/scripts/down.sh          # containers, networks and volumes
#   CLEAN=1 stack/scripts/down.sh  # also the generated certificate, keypair and caches
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

load_generated_env

# Teardown must work even when nothing was generated (a half-finished bootstrap, a fresh
# checkout after a crashed run). The compose file requires the keys to *interpolate*, not to
# be real, and `down` never starts a container — so placeholders are enough, and leaving
# volumes behind would break the "every run starts from empty" guarantee.
export GPG_SSO_PUBLIC_KEY="${GPG_SSO_PUBLIC_KEY:-teardown-placeholder}"
export GPG_SSO_PRIVATE_KEY="${GPG_SSO_PRIVATE_KEY:-teardown-placeholder}"
export GPG_SSO_PASSPHRASE="${GPG_SSO_PASSPHRASE:-teardown-placeholder}"

log "removing containers, networks and volumes"
compose down --volumes --remove-orphans

if [[ -n "${CLEAN:-}" ]]; then
  log "removing generated material"
  rm -rf "$STACK_DIR/certs" "$STACK_DIR/keys" "$STACK_DIR/.cache" "$GENERATED_ENV"
fi

log "down"
