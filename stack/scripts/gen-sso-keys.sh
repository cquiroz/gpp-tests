#!/usr/bin/env bash
# Throwaway GPG keypair for staging-mode SSO (spec §3).
#
# SSO in `local` mode mints a random keypair per boot that ODB cannot verify, so the stack
# runs SSO in `staging` mode with a keypair we control: SSO signs JWTs with the private key
# and ODB verifies them with the public key. The keypair protects nothing — it exists for
# one run against one throwaway database — but it is generated per run in an isolated
# GNUPGHOME rather than committed, so it can never be confused for a real credential and
# never touches the developer's own keyring.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_cmd gpg

KEY_DIR="$STACK_DIR/keys"
PASSPHRASE_FILE="$KEY_DIR/passphrase"

if [[ -f "$KEY_DIR/sso-public.asc" && -f "$KEY_DIR/sso-private.asc" && -f "$PASSPHRASE_FILE" && -z "${FORCE:-}" ]]; then
  log "SSO keypair already present (FORCE=1 to regenerate)"
  exit 0
fi

mkdir -p "$KEY_DIR"
chmod 700 "$KEY_DIR"

# Not a secret by any stretch — SSO simply requires a passphrase on the private key.
echo "odbattr-test-only" > "$PASSPHRASE_FILE"

GNUPGHOME="$(mktemp -d)"
export GNUPGHOME
trap 'rm -rf "$GNUPGHOME"' EXIT
chmod 700 "$GNUPGHOME"

log "generating a throwaway SSO GPG keypair (test-only, per run)"
gpg --batch --quiet --pinentry-mode loopback \
  --passphrase-file "$PASSPHRASE_FILE" \
  --quick-generate-key "odbattr test SSO <odbattr@example.com>" rsa2048 sign,cert never

gpg --batch --quiet --armor --export "odbattr@example.com" > "$KEY_DIR/sso-public.asc"
gpg --batch --quiet --armor --pinentry-mode loopback \
  --passphrase-file "$PASSPHRASE_FILE" \
  --export-secret-keys "odbattr@example.com" > "$KEY_DIR/sso-private.asc"

chmod 600 "$KEY_DIR"/sso-*.asc "$PASSPHRASE_FILE"

[[ -s "$KEY_DIR/sso-public.asc" && -s "$KEY_DIR/sso-private.asc" ]] \
  || die "gpg produced an empty key export"

log "wrote $KEY_DIR/sso-{public,private}.asc"
