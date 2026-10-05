#!/usr/bin/env bash
# Build the JVM truststore the odb boots with: the odb image's own cacerts plus Caddy's
# internal root CA (ticket 028).
#
# Why: the odb emails on proposal submission, and its Mailgun base URL is hardcoded to
# https://api.mailgun.net/v3 (lucuma-odb Config.scala). The stack answers for that name
# itself — a compose alias points it at Caddy, which mints a certificate for it — so the
# odb's JVM has to trust Caddy's CA. Replacing the truststore outright would cut the odb
# off from the public CAs it needs for the Gaia and Simbad catalogues, hence the merge.
#
# Output: stack/certs/cacerts, mounted read-only into the odb by docker-compose.yml.
# Runs keytool inside the odb image so the base cacerts is exactly the one it ships with.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

CA_PATH="${CA_PATH:-$STACK_DIR/certs/caddy-root.crt}"
OUT="$STACK_DIR/certs/cacerts"
IMAGE="${ODB_IMAGE:-registry.heroku.com/lucuma-postgres-odb-dev/web:latest}"

[[ -s "$CA_PATH" ]] || die "no Caddy root CA at $CA_PATH — stack/scripts/trust-ca.sh exports it once caddy is up"

log "building the odb's truststore: image cacerts + Caddy root"
docker run --rm --entrypoint sh -v "$STACK_DIR/certs:/certs" "$IMAGE" -c '
  set -e
  cp "$JAVA_HOME/lib/security/cacerts" /certs/cacerts.tmp
  keytool -importcert -noprompt -alias gpp-tests-caddy-root \
    -file /certs/caddy-root.crt -keystore /certs/cacerts.tmp -storepass changeit >/dev/null
  chmod 644 /certs/cacerts.tmp
  mv /certs/cacerts.tmp /certs/cacerts
' 2>&1 | grep -v "requested image's platform" || true

[[ -s "$OUT" ]] || die "truststore was not written: $OUT"
log "truststore at $OUT"
