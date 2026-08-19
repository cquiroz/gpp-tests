#!/usr/bin/env bash
# Point the dedicated load-target Heroku apps at today's `-dev` images and reset their
# database (spec §6, milestone M4).
#
#   .github/scripts/release-loadtest.sh            # release + pg:reset
#   DRY_RUN=1 .github/scripts/release-loadtest.sh  # print what it would do
#
# The apps are *not* created here: standing up `lucuma-*-loadtest` is a one-off provisioning
# job (M4), and creating dynos and databases implicitly from a nightly cron is not something a
# test suite should do. Set these repository variables to enable the nightly run:
#
#   LOADTEST_ODB_APP   e.g. lucuma-postgres-odb-loadtest   (web + obscalc process types)
#   LOADTEST_SSO_APP   e.g. lucuma-sso-loadtest
#   LOADTEST_ITC_APP   e.g. itc-loadtest
set -euo pipefail

log() { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }
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

command -v heroku >/dev/null || die "the heroku CLI is not installed"

log "logging in to registry.heroku.com"
echo "$HEROKU_API_KEY" | run docker login registry.heroku.com -u _ --password-stdin

# source app/process → target app/process. The same `-dev` images the regression stack uses,
# so both suites test the same commits.
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

# Release after all images are pushed, so the app flips over in one go.
log "releasing $ODB_APP (web, obscalc), $SSO_APP (web), $ITC_APP (web)"
run heroku container:release web obscalc --app "$ODB_APP"
run heroku container:release web --app "$SSO_APP"
run heroku container:release web --app "$ITC_APP"

# Every run starts from a known state; Flyway migrates again on boot, and the k6 ramp seeds
# the working set (spec §6). This is why the concurrency group must never be cancelled.
log "resetting the load target database"
run heroku pg:reset --app "$ODB_APP" --confirm "$ODB_APP"

log "restarting so the services migrate the empty database"
run heroku ps:restart --app "$ODB_APP"
run heroku ps:restart --app "$SSO_APP"

log "load target released"
