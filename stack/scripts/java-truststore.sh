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
# Runs keytool inside the odb image so the base cacerts is exactly the one it ships with —
# but as the *host* user, not the image's: the image runs as uid 3624, which cannot write
# into a bind-mounted directory on a Linux host (it can on macOS, which hid this). The first
# version swallowed that failure and accepted whatever `cacerts` was already there; on the
# AWS target that was the laptop's copy, synced with the repo, holding the laptop's Caddy root
# — and every proposal submission answered 500 (2026-10-07). So this always rebuilds, fails
# when it cannot, and proves the Caddy root is in the result before installing it.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

CERT_DIR="$STACK_DIR/certs"
CA_PATH="${CA_PATH:-$CERT_DIR/caddy-root.crt}"
OUT="$CERT_DIR/cacerts"
IMAGE="${ODB_IMAGE:-registry.heroku.com/lucuma-postgres-odb-dev/web:latest}"
ALIAS="gpp-tests-caddy-root"

[[ -s "$CA_PATH" ]] || die "no Caddy root CA at $CA_PATH — stack/scripts/trust-ca.sh exports it once caddy is up"
[[ "$(dirname "$CA_PATH")" == "$CERT_DIR" ]] || die "the Caddy root must live in $CERT_DIR to be mounted into the build"

log "building the odb's truststore: image cacerts + Caddy root"
# The container runs as the host user, so it can write next to the CA it reads. keytool as an
# arbitrary uid wants a writable HOME; the image's platform warning on an arm64 laptop is
# noise. Exit status is kept: a failed build must stop bootstrap, not log and go on.
set +e
output="$(docker run --rm --entrypoint sh \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$CERT_DIR:/certs" "$IMAGE" -c '
  set -e
  cp "$JAVA_HOME/lib/security/cacerts" /certs/cacerts.tmp
  chmod 644 /certs/cacerts.tmp
  keytool -importcert -noprompt -alias '"$ALIAS"' \
    -file /certs/'"$(basename "$CA_PATH")"' -keystore /certs/cacerts.tmp -storepass changeit >/dev/null
  keytool -list -alias '"$ALIAS"' -keystore /certs/cacerts.tmp -storepass changeit >/dev/null
' 2>&1)"
status=$?
set -e
printf '%s\n' "$output" | grep -v "requested image's platform" | grep -v '^$' >&2 || true
(( status == 0 )) || die "truststore build failed (exit $status, output above) — the odb would not trust the stack's Mailgun stand-in"
[[ -s "$OUT.tmp" ]] || die "truststore build produced no file"

# Install atomically; a stale cacerts from another host (or an earlier failure) is replaced,
# never kept.
mv -f "$OUT.tmp" "$OUT"
log "truststore at $OUT (contains $ALIAS)"
