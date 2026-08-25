#!/usr/bin/env bash
# Return the load target to zero dynos after a run.
#
#   .github/scripts/scale-down-loadtest.sh
#
# Run from the workflow with `if: always()`. A nightly 40-minute run costs a fraction of a
# permanently-on environment only if this actually happens — a failed run that leaves four
# performance dynos up would quietly bill for a month.
#
# Deliberately best-effort: it never fails the job. A run that produced good numbers must not
# go red because the scale-down API call timed out; the worst case is idle dynos until the next
# run scales them again, and the notice below is there to make that visible.
set -uo pipefail

log() { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }

if [[ -z "${HEROKU_API_KEY:-}" ]]; then
  warn "HEROKU_API_KEY is not set — cannot scale down"
  exit 0
fi

# Scaling an app to zero is an outage if the app is the wrong one, so the same rails apply
# here as to the release. The guard exits non-zero on a violation, which is the one thing that
# *should* fail this otherwise best-effort script: better a red run than a scaled-down
# production service.
# shellcheck source=../../loadtest/guard.sh
source "$(dirname "${BASH_SOURCE[0]}")/../../loadtest/guard.sh"

failed=()
scale() {
  local app="$1"; shift
  if [[ -z "$app" ]]; then return 0; fi

  assert_loadtest_name "$app"
  assert_loadtest_marker "$app"

  log "scaling $app to zero"
  if ! heroku ps:scale "$@" --app "$app"; then
    failed+=("$app")
  fi
}

scale "${LOADTEST_ODB_APP:-}" web=0 obscalc=0
scale "${LOADTEST_SSO_APP:-}" web=0
scale "${LOADTEST_ITC_APP:-}" web=0

if [[ ${#failed[@]} -gt 0 ]]; then
  # A GitHub warning annotation, so it surfaces on a green run rather than only in the log.
  echo "::warning title=Load target still running::Could not scale down: ${failed[*]}. These dynos are still billing — run 'heroku ps:scale web=0 obscalc=0 -a <app>' by hand."
  warn "scale-down failed for: ${failed[*]}"
else
  log "load target is back to zero dynos"
fi

exit 0
