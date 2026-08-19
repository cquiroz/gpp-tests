#!/usr/bin/env bash
# Export (and optionally install) Caddy's internal root CA.
#
# The stack mints its own certificates, so clients need the root:
#   * Node (Playwright's GraphQL read-backs)  → NODE_EXTRA_CA_CERTS, printed below
#   * k6                                      → insecureSkipTLSVerify (spec §3)
#   * Chromium on Linux                       → its own NSS store, hence INSTALL_NSS=1
#
# By default Playwright is configured with ignoreHTTPSErrors, so installing into NSS is
# optional; do it (and set PW_IGNORE_HTTPS_ERRORS=false) when you want a strict-TLS run.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

CA_PATH="${CA_PATH:-$STACK_DIR/certs/caddy-root.crt}"
mkdir -p "$(dirname "$CA_PATH")"

log "exporting Caddy's internal root CA"
compose cp caddy:/data/caddy/pki/authorities/local/root.crt "$CA_PATH" >/dev/null \
  || die "could not copy the root CA out of the caddy container (is the stack up?)"

[[ -s "$CA_PATH" ]] || die "exported CA is empty: $CA_PATH"

if [[ -n "${INSTALL_NSS:-}" ]]; then
  if command -v certutil >/dev/null 2>&1; then
    NSSDB="$HOME/.pki/nssdb"
    mkdir -p "$NSSDB"
    [[ -f "$NSSDB/cert9.db" ]] || certutil -N -d "sql:$NSSDB" --empty-password
    certutil -d "sql:$NSSDB" -A -t "C,," -n odbattr-caddy-root -i "$CA_PATH"
    log "installed the root CA into Chromium's NSS store ($NSSDB)"
  else
    warn "certutil not found (install libnss3-tools) — skipping the NSS install"
  fi
fi

log "root CA at $CA_PATH"
echo "export NODE_EXTRA_CA_CERTS=$CA_PATH"
