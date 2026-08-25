#!/usr/bin/env bash
# Point the load target at today's `-dev` images, reset its database and bring it up
# (spec §6, milestone M4).
#
#   .github/scripts/release-loadtest.sh            # release, reset, scale up
#   DRY_RUN=1 .github/scripts/release-loadtest.sh  # print what it would do
#
# The apps are *not* created here — that is `loadtest/provision.sh`, a one-off that creates
# billable resources. This script is the per-run half, and it assumes provisioning is done.
#
# Between runs the dynos sit at zero, so this scales them up and the workflow scales them back
# down when the run ends. Heroku bills dynos by the second, which makes a nightly 40-minute
# run cost a fraction of a permanently-on environment.
#
# Required (repository variables, set by provision.sh's closing instructions):
#   LOADTEST_ODB_APP   e.g. lucuma-postgres-odb-loadtest   (web + obscalc process types)
#   LOADTEST_SSO_APP   e.g. lucuma-sso-loadtest
#   LOADTEST_ITC_APP   e.g. itc-loadtest
set -euo pipefail

log() { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

run() {
  if [[ -n "${DRY_RUN:-}" ]]; then
    printf 'would run: %s\n' "$*" >&2
  else
    "$@"
  fi
}

: "${HEROKU_API_KEY:?HEROKU_API_KEY is required}"
ODB_APP="${LOADTEST_ODB_APP:?LOADTEST_ODB_APP is required}"
SSO_APP="${LOADTEST_SSO_APP:?LOADTEST_SSO_APP is required}"
ITC_APP="${LOADTEST_ITC_APP:?LOADTEST_ITC_APP is required}"
DYNO_SIZE="${DYNO_SIZE:-performance-m}"

command -v heroku >/dev/null || die "the heroku CLI is not installed"

log "logging in to registry.heroku.com"
echo "$HEROKU_API_KEY" | run docker login registry.heroku.com -u _ --password-stdin

# source app/process → target app/process. The same `-dev` images the ephemeral regression
# stack uses, so both suites exercise the same commits.
RELEASES=(
  "lucuma-postgres-odb-dev/web:$ODB_APP/web"
  "lucuma-postgres-odb-dev/obscalc:$ODB_APP/obscalc"
  "lucuma-sso-dev/web:$SSO_APP/web"
  "itc-dev/web:$ITC_APP/web"
)

for release in "${RELEASES[@]}"; do
  source_ref="registry.heroku.com/${release%%:*}:latest"
  target="${release#*:}"
  target_app="${target%%/*}"
  target_process="${target##*/}"
  target_ref="registry.heroku.com/$target_app/$target_process"

  log "$source_ref → $target_ref"
  run docker pull --quiet "$source_ref"
  run docker tag "$source_ref" "$target_ref"
  run docker push --quiet "$target_ref"
done

# Released after every image is pushed, so each app flips over in one go.
log "releasing $ODB_APP (web, obscalc), $SSO_APP (web), $ITC_APP (web)"
run heroku container:release web obscalc --app "$ODB_APP"
run heroku container:release web --app "$SSO_APP"
run heroku container:release web --app "$ITC_APP"

# Every run starts from a known state; Flyway migrates on boot and the k6 ramp seeds each VU's
# own working set (spec §6). This is why the workflow's concurrency group must never cancel.
#
# Only the ODB's database. The SSO's holds the service user that ODB_SERVICE_JWT refers to, and
# resetting it would orphan that token — the failure then surfaces inside obscalc as a
# signature error with nothing pointing back here. Guest rows do accumulate in SSO as a result;
# see loadtest/README.md for the (manual, deliberate) cleanup.
log "resetting the ODB database"
run heroku pg:reset --app "$ODB_APP" --confirm "$ODB_APP"

# Order matters on a cold start: the ODB needs the ITC's root at boot, and both need SSO.
log "scaling up: sso → itc → odb (+obscalc)"
run heroku ps:scale "web=1:$DYNO_SIZE" --app "$SSO_APP"
run heroku ps:scale "web=1:$DYNO_SIZE" --app "$ITC_APP"
run heroku ps:scale "web=1:$DYNO_SIZE" "obscalc=1:$DYNO_SIZE" --app "$ODB_APP"

log "load target released and scaling up — the workflow now waits for a guest login"
