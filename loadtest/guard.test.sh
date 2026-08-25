#!/usr/bin/env bash
# Tests for loadtest/guard.sh — the rails that keep this tooling off production.
#
#   loadtest/guard.test.sh
#
# Each case runs the guard in a subshell with a stubbed `heroku`, because a violation is
# supposed to exit the process. What is being asserted is the exit status: zero means "would
# have proceeded to destroy something", non-zero means "refused".
set -uo pipefail

GUARD="$(cd "$(dirname "$0")" && pwd)/guard.sh"
STUB_DIR="$(mktemp -d)"
trap 'rm -rf "$STUB_DIR"' EXIT

# Stub heroku: MARKED lists the apps that carry the marker; every other app returns empty,
# which is what a real production app would do.
cat > "$STUB_DIR/heroku" <<'STUB'
#!/bin/bash
if [[ "$1" == "config:get" ]]; then
  app=""
  for ((i=1; i<=$#; i++)); do
    [[ "${!i}" == "-a" ]] && { j=$((i+1)); app="${!j}"; }
  done
  if [[ "$2" == "ODBATTR_LOADTEST" && " ${MARKED:-} " == *" $app "* ]]; then
    echo 1
  else
    echo ""
  fi
  exit 0
fi
exit 0
STUB
chmod +x "$STUB_DIR/heroku"
export PATH="$STUB_DIR:$PATH"

pass=0
fail=0

# expect <refuse|allow> <description> <function> <args...>
expect() {
  local want="$1" desc="$2"; shift 2
  local output status
  output="$(source "$GUARD" >/dev/null 2>&1; "$@" 2>&1)"
  status=$?

  local got="allow"
  [[ $status -ne 0 ]] && got="refuse"

  if [[ "$got" == "$want" ]]; then
    printf '  \033[1;32mok\033[0m   %s\n' "$desc"
    pass=$((pass + 1))
  else
    printf '  \033[1;31mFAIL\033[0m %s (wanted %s, got %s)\n' "$desc" "$want" "$got"
    [[ -n "$output" ]] && printf '       %s\n' "$(printf '%s' "$output" | head -2 | tr '\n' ' ')"
    fail=$((fail + 1))
  fi
}

echo "names that must be refused outright:"
expect refuse "production ODB"          assert_loadtest_name lucuma-postgres-odb-production
expect refuse "staging ODB"             assert_loadtest_name lucuma-postgres-odb-staging
expect refuse "the -dev image source"   assert_loadtest_name lucuma-postgres-odb-dev
expect refuse "production SSO"          assert_loadtest_name lucuma-sso-production
expect refuse "the ITC dev app"         assert_loadtest_name itc-dev
expect refuse "an unsuffixed app"       assert_loadtest_name lucuma-postgres-odb
expect refuse "an empty name"           assert_loadtest_name ""
expect refuse "a prod-ish loadtest name" assert_loadtest_name lucuma-odb-production-loadtest

echo
echo "names that are allowed:"
expect allow  "the ODB load target"     assert_loadtest_name lucuma-postgres-odb-loadtest
expect allow  "the SSO load target"     assert_loadtest_name lucuma-sso-loadtest
expect allow  "the ITC load target"     assert_loadtest_name itc-loadtest

echo
echo "the marker check (a correctly-named app that is not ours):"
MARKED="lucuma-postgres-odb-loadtest" \
  expect allow  "marked app passes"     assert_loadtest_marker lucuma-postgres-odb-loadtest
MARKED="" \
  expect refuse "unmarked app refused"  assert_loadtest_marker lucuma-postgres-odb-loadtest
MARKED="something-else-loadtest" \
  expect refuse "another app's marker"  assert_loadtest_marker lucuma-sso-loadtest

echo
echo "a whole set is refused if any member is bad:"
expect refuse "one production app spoils the batch" \
  assert_all_loadtest_names lucuma-sso-loadtest lucuma-postgres-odb-production itc-loadtest
expect allow  "an all-loadtest batch" \
  assert_all_loadtest_names lucuma-sso-loadtest lucuma-postgres-odb-loadtest itc-loadtest

echo
echo "pushing images back at their source:"
expect refuse "same source and target" \
  assert_distinct_source_and_target lucuma-postgres-odb-dev lucuma-postgres-odb-dev
expect allow  "dev to loadtest" \
  assert_distinct_source_and_target lucuma-postgres-odb-dev lucuma-postgres-odb-loadtest

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
