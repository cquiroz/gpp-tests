#!/usr/bin/env bash
# Provision the persistent load target (spec §6, milestone M4).
#
#   loadtest/provision.sh                 # dry run — prints every command, changes nothing
#   HEROKU_TEAM=<team> loadtest/provision.sh --apply
#
# Creates the `lucuma-*-loadtest` app set the nightly performance suite points at: three
# container-stack apps, a Postgres for the ODB and another for SSO, the ITC's Redis, a
# long-lived SSO signing keypair, every config var, and the service JWT the three services
# share. Dynos are left scaled to **zero** — the nightly release scales them up for the run
# and back down after, so the only continuous cost is the addons.
#
# Idempotent: re-running skips whatever already exists, so it doubles as a repair tool and as
# the documentation of what the target's configuration is meant to be.
#
# This is deliberately not run from CI. It creates billable resources and needs create-app
# rights in the team, which is a person's decision, not a cron job's.
set -euo pipefail

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
skip() { printf '\033[1;32m  ok\033[0m %s\n' "$*" >&2; }

APPLY=""
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown argument: $arg" ;;
  esac
done

# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------
ODB_APP="${LOADTEST_ODB_APP:-lucuma-postgres-odb-loadtest}"
SSO_APP="${LOADTEST_SSO_APP:-lucuma-sso-loadtest}"
ITC_APP="${LOADTEST_ITC_APP:-itc-loadtest}"

ODB_PG_PLAN="${ODB_PG_PLAN:-heroku-postgresql:essential-2}"
SSO_PG_PLAN="${SSO_PG_PLAN:-heroku-postgresql:essential-0}"
ITC_REDIS_PLAN="${ITC_REDIS_PLAN:-heroku-redis:mini}"
DYNO_SIZE="${DYNO_SIZE:-performance-m}"

# The ODB's connection pool must stay under the Postgres plan's limit, or the run measures
# connection exhaustion instead of the ODB. essential-2 allows more than this; the margin
# leaves room for the obscalc process, which shares the same database. Check the real ceiling
# with `heroku pg:info -a $ODB_APP` and raise this if there is headroom.
ODB_MAX_CONNECTIONS="${ODB_MAX_CONNECTIONS:-25}"

run() {
  if [[ -n "$APPLY" ]]; then
    printf '\033[2m  $ %s\033[0m\n' "$*" >&2
    "$@"
  else
    printf '  would run: %s\n' "$*" >&2
  fi
}

# Config vars carry secrets, so echo the key and not the value.
set_config() {
  local app="$1"; shift
  if [[ -n "$APPLY" ]]; then
    printf '\033[2m  $ heroku config:set %s -a %s\033[0m\n' "$(for kv in "$@"; do printf '%s=… ' "${kv%%=*}"; done)" "$app" >&2
    heroku config:set "$@" -a "$app" >/dev/null
  else
    printf '  would set on %s: %s\n' "$app" "$(for kv in "$@"; do printf '%s ' "${kv%%=*}"; done)" >&2
  fi
}

app_exists()   { heroku apps:info -a "$1" >/dev/null 2>&1; }
config_value() { heroku config:get "$2" -a "$1" 2>/dev/null || true; }
has_addon()    { heroku addons -a "$1" 2>/dev/null | grep -qi "$2"; }

# ---------------------------------------------------------------------------
# 0. Preflight
# ---------------------------------------------------------------------------
command -v heroku >/dev/null || die "the heroku CLI is not installed"
command -v gpg >/dev/null    || die "gpg is required to generate the SSO keypair"
command -v node >/dev/null   || die "node is required to validate the service JWT"

heroku auth:whoami >/dev/null 2>&1 \
  || die "not logged in to Heroku. Run \`heroku login\`, or export a HEROKU_API_KEY
    (\`heroku authorizations:create -d 'odbattr provisioning'\`)."

TEAM="${HEROKU_TEAM:-}"
[[ -n "$TEAM" ]] || die "HEROKU_TEAM is required — the team that owns the lucuma-*-dev apps.
    List what you can see with:  heroku teams"

if [[ -z "$APPLY" ]]; then
  warn "DRY RUN — nothing will be created. Re-run with --apply to go ahead."
fi

log "team          $TEAM"
log "apps          $ODB_APP · $SSO_APP · $ITC_APP"
log "dynos         $DYNO_SIZE (scaled to 0 between runs)"
log "postgres      odb=$ODB_PG_PLAN  sso=$SSO_PG_PLAN"

# ---------------------------------------------------------------------------
# 1. The apps
#
# --stack container is required: these are released from pre-built Docker images with
# `heroku container:release`, which a buildpack app cannot do.
# ---------------------------------------------------------------------------
log "apps"
for app in "$ODB_APP" "$SSO_APP" "$ITC_APP"; do
  if app_exists "$app"; then
    skip "$app exists"
  else
    run heroku apps:create "$app" --team "$TEAM" --stack container
  fi
done

# ---------------------------------------------------------------------------
# 2. Databases
#
# Two of them, deliberately. The ODB and SSO each run their own Flyway migrations, and Flyway
# keeps its history in a `flyway_schema_history` table in the database it is pointed at — so a
# shared database would have each service rejecting the other's migrations on boot. The SSO's
# is tiny (users and sessions) and gets the cheapest plan.
# ---------------------------------------------------------------------------
log "databases"
if has_addon "$ODB_APP" postgres; then
  skip "$ODB_APP already has Postgres"
else
  run heroku addons:create "$ODB_PG_PLAN" -a "$ODB_APP" --wait
fi

if has_addon "$SSO_APP" postgres; then
  skip "$SSO_APP already has Postgres"
else
  run heroku addons:create "$SSO_PG_PLAN" -a "$SSO_APP" --wait
fi

# The ITC treats Redis as mandatory when it detects a Heroku dyno (it is only optional off
# Heroku, which is why the ephemeral compose stack omits it).
log "ITC cache"
if has_addon "$ITC_APP" redis; then
  skip "$ITC_APP already has Redis"
else
  run heroku addons:create "$ITC_REDIS_PLAN" -a "$ITC_APP" --wait
fi

# ---------------------------------------------------------------------------
# 3. The SSO signing keypair
#
# Long-lived, unlike the ephemeral stack's per-run pair: the service JWT is signed by it, so
# rotating it means re-minting that token. Heroku's config is the only copy — nothing is
# written to disk here, and there is nothing to commit.
# ---------------------------------------------------------------------------
log "SSO keypair"
EXISTING_PUBLIC_KEY="$(config_value "$SSO_APP" GPG_SSO_PUBLIC_KEY)"
if [[ -n "$EXISTING_PUBLIC_KEY" ]]; then
  skip "$SSO_APP already has a keypair (delete GPG_SSO_* to rotate)"
elif [[ -z "$APPLY" ]]; then
  printf '  would generate a keypair and set GPG_SSO_{PUBLIC,PRIVATE}_KEY, GPG_SSO_PASSPHRASE on %s\n' "$SSO_APP" >&2
else
  GNUPGHOME="$(mktemp -d)"; export GNUPGHOME; chmod 700 "$GNUPGHOME"
  trap 'rm -rf "$GNUPGHOME"' EXIT
  PASSPHRASE="odbattr-loadtest-$(date +%s)"

  log "generating an RSA-2048 keypair for $SSO_APP"
  gpg --batch --quiet --pinentry-mode loopback --passphrase "$PASSPHRASE" \
    --quick-generate-key "odbattr loadtest SSO <odbattr@example.com>" rsa2048 sign,cert never
  PUBLIC_KEY="$(gpg --batch --quiet --armor --export odbattr@example.com)"
  PRIVATE_KEY="$(gpg --batch --quiet --armor --pinentry-mode loopback \
    --passphrase "$PASSPHRASE" --export-secret-keys odbattr@example.com)"
  [[ -n "$PUBLIC_KEY" && -n "$PRIVATE_KEY" ]] || die "gpg produced an empty key"

  set_config "$SSO_APP" \
    "GPG_SSO_PUBLIC_KEY=$PUBLIC_KEY" \
    "GPG_SSO_PRIVATE_KEY=$PRIVATE_KEY" \
    "GPG_SSO_PASSPHRASE=$PASSPHRASE"
  EXISTING_PUBLIC_KEY="$PUBLIC_KEY"
fi

# ---------------------------------------------------------------------------
# 4. Config
#
# Hostnames are the plain *.herokuapp.com ones: the load suite is k6 only, so nothing here
# needs the shared parent domain that the browser journey's SameSite cookie does. SSO's cookie
# is scoped to its own exact host, which k6's cookie jar handles.
# ---------------------------------------------------------------------------
SSO_HOST="$SSO_APP.herokuapp.com"
ODB_HOST="$ODB_APP.herokuapp.com"
ITC_HOST="$ITC_APP.herokuapp.com"

log "config: $SSO_APP"
set_config "$SSO_APP" \
  "LUCUMA_SSO_ENVIRONMENT=staging" \
  "LUCUMA_SSO_COOKIE_DOMAIN=$SSO_HOST" \
  "LUCUMA_SSO_HOSTNAME=$SSO_HOST" \
  "LUCUMA_ODB_HOSTNAME=$ODB_HOST" \
  "LUCUMA_ORCID_CLIENT_ID=odbattr-not-a-real-client" \
  "LUCUMA_ORCID_CLIENT_SECRET=odbattr-not-a-real-secret"

log "config: $ODB_APP (shared by the web and obscalc process types)"
ODB_CONFIG=(
  "ODB_SSO_ROOT=https://$SSO_HOST"
  "ODB_ITC_ROOT=https://$ITC_HOST/itc"
  "ODB_DOMAIN=$ODB_HOST"
  "CORS_OVER_HTTPS=true"
  "EXPLORE_URL=https://$ODB_HOST"
  "ODB_MAX_CONNECTIONS=$ODB_MAX_CONNECTIONS"
  # Required to boot, never exercised by the load scenarios (ODB-README).
  "CLOUDCUBE_ACCESS_KEY_ID=odbattr"
  "CLOUDCUBE_SECRET_ACCESS_KEY=odbattr"
  "CLOUDCUBE_URL=https://cube.example.com/odbattr"
  "FILE_UPLOAD_MAX_MB=10"
  "MAILGUN_API_KEY=odbattr"
  "MAILGUN_DOMAIN=mail.example.com"
  "MAILGUN_WEBHOOK_SIGNING_KEY=odbattr"
  "INVITATION_SENDER_EMAIL=odbattr@example.com"
  "PROPOSAL_EMAIL_DEFAULT=odbattr@example.com"
)
if [[ -n "$EXISTING_PUBLIC_KEY" ]]; then
  ODB_CONFIG+=("ODB_SSO_PUBLIC_KEY=$EXISTING_PUBLIC_KEY")
else
  # Only reachable on a dry run, or if the SSO app's keypair was deleted. The ODB cannot
  # verify a JWT without it, so say so rather than leaving a silently broken target.
  warn "no SSO public key available — ODB_SSO_PUBLIC_KEY will not be set on $ODB_APP"
fi

# Traces from the load target are the point of the Grafana integration (spec §7). A non-local
# ODB_ENVIRONMENT makes both OTel variables mandatory, so they move together.
if [[ -n "${ODB_OTEL_ENDPOINT:-}" && -n "${ODB_OTEL_KEY:-}" ]]; then
  ODB_CONFIG+=(
    "ODB_ENVIRONMENT=${ODB_ENVIRONMENT:-staging}"
    "ODB_OTEL_ENDPOINT=$ODB_OTEL_ENDPOINT"
    "ODB_OTEL_KEY=$ODB_OTEL_KEY"
    "OTEL_RESOURCE_ATTRIBUTES=environment=loadtest,service.namespace=odbattr"
  )
  log "OpenTelemetry enabled (environment=loadtest)"
else
  ODB_CONFIG+=("ODB_ENVIRONMENT=local")
  warn "ODB_OTEL_ENDPOINT/ODB_OTEL_KEY not set — the load target will not emit traces."
  warn "Re-run with both set to turn them on (spec §7)."
fi
set_config "$ODB_APP" "${ODB_CONFIG[@]}"

log "config: $ITC_APP"
set_config "$ITC_APP" "ODB_BASE_URL=https://$ODB_HOST"

# ---------------------------------------------------------------------------
# 5. Dynos to zero
#
# Nothing should be running between nightly runs. The formation is set here so the scale-up in
# the release script has a size to return to.
# ---------------------------------------------------------------------------
# Never scale down something that is up: this script is re-run to repair config, and a
# nightly run takes 40 minutes. Killing the target mid-run would look like a load failure.
running_dynos() {
  heroku ps -a "$1" --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);process.stdout.write(String(Array.isArray(a)?a.length:0))}catch{process.stdout.write("0")}})' \
    2>/dev/null || echo 0
}

LIVE=0
for app in "$ODB_APP" "$SSO_APP" "$ITC_APP"; do
  count="$(running_dynos "$app")"
  [[ "${count:-0}" -gt 0 ]] && LIVE=$(( LIVE + count ))
done

if [[ "$LIVE" -gt 0 ]]; then
  warn "$LIVE dyno(s) are running — a load run may be in progress, so not scaling down."
  warn "Re-run this once the run finishes, or scale by hand:"
  warn "    heroku ps:scale web=0 obscalc=0 -a $ODB_APP"
else
  log "scaling dynos to zero (the nightly release scales them up)"
  run heroku ps:scale "web=0:$DYNO_SIZE" "obscalc=0:$DYNO_SIZE" -a "$ODB_APP"
  run heroku ps:scale "web=0:$DYNO_SIZE" -a "$SSO_APP"
  run heroku ps:scale "web=0:$DYNO_SIZE" -a "$ITC_APP"
fi

# ---------------------------------------------------------------------------
# 6. The service JWT
#
# Needs an SSO image on the app, so this only works after the first release. Left until last
# and skipped cleanly when the app has nothing deployed yet.
# ---------------------------------------------------------------------------
log "service JWT"
EXISTING_JWT="$(config_value "$ODB_APP" ODB_SERVICE_JWT)"
if [[ -n "$EXISTING_JWT" ]]; then
  skip "$ODB_APP already has ODB_SERVICE_JWT (unset it to re-mint)"
elif [[ -z "$APPLY" ]]; then
  printf '  would mint one with: heroku run -a %s -- create-service-user odb\n' "$SSO_APP" >&2
else
  log "minting via a one-off dyno on $SSO_APP"
  MINT_OUTPUT="$(heroku run --no-tty -a "$SSO_APP" -- create-service-user odb 2>&1 || true)"
  SERVICE_JWT="$(printf '%s\n' "$MINT_OUTPUT" \
    | grep -oE 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+' | tail -1 || true)"

  if [[ -z "$SERVICE_JWT" ]]; then
    printf '%s\n' "$MINT_OUTPUT" >&2
    warn "could not mint a service JWT (output above)."
    warn "This is expected before the first image release. Run:"
    warn "    .github/scripts/release-loadtest.sh"
    warn "then re-run this script to finish."
  else
    # Same validator the ephemeral bootstrap uses: catches a token signed by a keypair the
    # app is no longer running, which otherwise surfaces much later inside obscalc.
    PUBLIC_KEY_FILE="$(mktemp)"
    printf '%s' "$EXISTING_PUBLIC_KEY" > "$PUBLIC_KEY_FILE"
    if node "$(dirname "$0")/../tools/check-service-jwt.js" "$SERVICE_JWT" \
         --public-key "$PUBLIC_KEY_FILE"; then
      set_config "$ODB_APP" "ODB_SERVICE_JWT=$SERVICE_JWT"
      set_config "$ITC_APP" "ODB_SERVICE_JWT=$SERVICE_JWT"
    else
      warn "the minted token did not validate — not storing it"
    fi
    rm -f "$PUBLIC_KEY_FILE"
  fi
fi

# ---------------------------------------------------------------------------
# 7. What the workflow needs
# ---------------------------------------------------------------------------
cat >&2 <<EOF

$(printf '\033[1;34m==>\033[0m') provisioning $([[ -n "$APPLY" ]] && echo complete || echo "dry run finished")

Set these repository variables so performance.yml stops skipping itself:

  gh variable set LOADTEST_ODB_APP --body '$ODB_APP'
  gh variable set LOADTEST_SSO_APP --body '$SSO_APP'
  gh variable set LOADTEST_ITC_APP --body '$ITC_APP'
  gh variable set LOADTEST_ODB_GRAPHQL_URL --body 'https://$ODB_HOST/odb'
  gh variable set LOADTEST_SSO_URL --body 'https://$SSO_HOST'

Then, in order:

  1. .github/scripts/release-loadtest.sh    push today's -dev images and release
  2. loadtest/provision.sh --apply          again, to mint the service JWT
  3. gh workflow run performance.yml        a real run, on demand

Dynos are at zero, so only the addons are billing. \`heroku ps -a $ODB_APP\` to confirm.
EOF
