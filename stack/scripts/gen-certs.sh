#!/usr/bin/env bash
# Postgres server certificate for the ephemeral stack.
#
# Flyway connects with sslmode=require (lucuma-odb Config.scala), so Postgres must speak
# SSL. lucuma-odb keeps a checked-in test-cert/ for this; we generate an equivalent
# throwaway pair per run instead, so nothing that looks like a key is ever committed.
# The Skunk pool uses SSL.Trusted.withFallback(true), so a self-signed cert is fine.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_cmd openssl

CERT_DIR="$STACK_DIR/certs"
mkdir -p "$CERT_DIR"

if [[ -f "$CERT_DIR/server.crt" && -f "$CERT_DIR/server.key" && -z "${FORCE:-}" ]]; then
  log "postgres certificate already present (FORCE=1 to regenerate)"
  exit 0
fi

log "generating a throwaway Postgres server certificate"
openssl req -new -x509 -days 365 -nodes \
  -newkey rsa:2048 \
  -subj "/CN=postgres" \
  -addext "subjectAltName=DNS:postgres,DNS:localhost" \
  -keyout "$CERT_DIR/server.key" \
  -out "$CERT_DIR/server.crt" 2>/dev/null

# Ownership and mode are fixed inside the container (see the postgres entrypoint in
# docker-compose.yml) because the host's uid mapping differs per platform.
chmod 600 "$CERT_DIR/server.key"
log "wrote $CERT_DIR/server.{crt,key}"
