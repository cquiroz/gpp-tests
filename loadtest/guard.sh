#!/usr/bin/env bash
# Safety rails for every Heroku app this repo mutates. Source it; do not run it.
#
# The load-test tooling issues `pg:reset`, `container:release`, `ps:scale` and `config:set`
# against app names that come from environment variables. Those are all destructive, and the
# same Heroku account owns the production GPP environment — so a single mistyped variable
# (`…-production` instead of `…-loadtest`) would be enough to wipe a production database or
# deploy dev images over it. Nothing else in the chain would object.
#
# So no script here touches an app without passing all three checks below. They are
# independent on purpose: a typo has to defeat every one of them, and the third cannot be
# defeated by a typo at all.
#
#   1. the name must look like a load-test app
#   2. the name must not look like a protected environment
#   3. the app must carry the marker config var this tooling puts there itself
#
# Every check fails closed: an unreachable API, an empty response or an unreadable app all
# count as "do not touch it".

# Set on every app by loadtest/provision.sh. Production, staging and the -dev apps do not have
# it and never will, which is what makes it a reliable discriminator rather than a convention.
ODBATTR_MARKER_VAR="ODBATTR_LOADTEST"
ODBATTR_MARKER_VALUE="1"

# Deliberately strict: the suffix is the whole point. Override only if your app names genuinely
# differ, and keep something distinctive in the pattern.
LOADTEST_APP_PATTERN="${LOADTEST_APP_PATTERN:-^[a-z0-9][a-z0-9-]*-loadtest$}"

# Substrings that must never appear in a target, whatever the pattern says. `-dev` is here
# because those apps are the *source* of the images: we pull from them and must never push to
# them.
PROTECTED_PATTERNS=(
  "production"
  "prod"
  "staging"
  "stage"
  "-dev"
  "master"
)

guard_die() {
  printf '\033[1;31mREFUSING TO CONTINUE:\033[0m %s\n' "$*" >&2
  exit 1
}

# Checks 1 and 2 — pure string tests, no API calls, so they work in a dry run.
# usage: assert_loadtest_name <app>
assert_loadtest_name() {
  local app="${1:-}"
  [[ -n "$app" ]] || guard_die "an empty app name was passed to a destructive operation"

  for pattern in "${PROTECTED_PATTERNS[@]}"; do
    if [[ "$app" == *"$pattern"* ]]; then
      guard_die "\"$app\" contains \"$pattern\", which marks a protected environment.
    This tooling only ever operates on dedicated load-test apps. If this really is a
    load-test app, rename it — do not loosen this check."
    fi
  done

  if [[ ! "$app" =~ $LOADTEST_APP_PATTERN ]]; then
    guard_die "\"$app\" does not look like a load-test app (expected it to match
    $LOADTEST_APP_PATTERN, i.e. to end in -loadtest).
    Check LOADTEST_ODB_APP / LOADTEST_SSO_APP / LOADTEST_ITC_APP."
  fi
}

# Check 3 — the app itself must say it belongs to this tooling. A typo cannot satisfy this,
# because the marker exists only on apps provision.sh created.
# usage: assert_loadtest_marker <app>
assert_loadtest_marker() {
  local app="${1:-}"
  assert_loadtest_name "$app"

  local value
  if ! value="$(heroku config:get "$ODBATTR_MARKER_VAR" -a "$app" 2>/dev/null)"; then
    guard_die "could not read $ODBATTR_MARKER_VAR from \"$app\".
    Treating that as \"not ours\" and stopping. If the app exists and is a load-test app,
    run loadtest/provision.sh --apply to mark it."
  fi

  if [[ "$(printf '%s' "$value" | tr -d '[:space:]')" != "$ODBATTR_MARKER_VALUE" ]]; then
    guard_die "\"$app\" is not marked as a load-test app.
    $ODBATTR_MARKER_VAR is not set to $ODBATTR_MARKER_VALUE, so this tooling did not create
    it — and it will not reset, release to, or rescale an app it does not own.
    If this is genuinely your load-test app:
        heroku config:set $ODBATTR_MARKER_VAR=$ODBATTR_MARKER_VALUE -a $app"
  fi
}

# Convenience for the scripts: check a whole set before doing anything to any of them, so a
# bad name stops the run before the first mutation rather than halfway through.
# usage: assert_all_loadtest_names app...
assert_all_loadtest_names() {
  local app
  for app in "$@"; do
    [[ -n "$app" ]] && assert_loadtest_name "$app"
  done
}

# usage: assert_all_loadtest_markers app...
assert_all_loadtest_markers() {
  local app
  for app in "$@"; do
    [[ -n "$app" ]] && assert_loadtest_marker "$app"
  done
}

# The images are pulled from the -dev apps and pushed to the load-test ones. Pushing to the
# source would deploy over a shared environment, so assert the direction explicitly.
# usage: assert_distinct_source_and_target <source-app> <target-app>
assert_distinct_source_and_target() {
  local source="${1:-}" target="${2:-}"
  if [[ "$source" == "$target" ]]; then
    guard_die "the image source and target are the same app (\"$source\").
    That would push dev images back over the app they came from."
  fi
}
