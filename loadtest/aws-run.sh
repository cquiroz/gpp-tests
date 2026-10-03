#!/usr/bin/env bash
# The standard unattended AWS run, one command (ticket 016):
#
#   loadtest/aws-run.sh                 regression + 20-min execution + 10-min subscribers, then stop
#   loadtest/aws-run.sh --load          … plus the 40-minute 200-VU trend profile
#   loadtest/aws-run.sh --no-subscribers   skip the websocket population
#   loadtest/aws-run.sh --realistic     execution at Observe's real cadence (60–120 s per step)
#   loadtest/aws-run.sh --minutes 40 --instances 4
#   loadtest/aws-run.sh --regression-only
#   loadtest/aws-run.sh --terminate     leave nothing behind instead of stopping the pair
#
# It is loadtest/aws-first-run.sh with AUTO=1 and the usual answers, kept awake with caffeinate
# on macOS. The stopped pair comes back as the same instances, the stack reboots on the target
# from tonight's -dev images, results land in out/ and the pair is stopped at the end or on any
# failure. About 45 minutes for the default; nothing to type.
#
# Needs HEROKU_API_KEY and the K6_PROMETHEUS_RW_* values in the repo's gitignored .env (direnv
# loads it), and the AWS CLI profile `gpp-tests` with the Session Manager plugin.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

RUN_EXECUTION=1
RUN_SUBSCRIBERS=1
RUN_LOAD=0
TEARDOWN=stop
EXEC_MINUTES="${EXEC_MINUTES:-20}"
OBSERVE_INSTANCES="${OBSERVE_INSTANCES:-2}"
STEP_SECONDS_MIN="${STEP_SECONDS_MIN:-5}"
STEP_SECONDS_MAX="${STEP_SECONDS_MAX:-10}"
SUBSCRIBERS="${SUBSCRIBERS:-50}"
CHURN_VUS="${CHURN_VUS:-10}"
SUBSCRIBER_MINUTES="${SUBSCRIBER_MINUTES:-10}"

usage() { sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while (( $# )); do
  case "$1" in
    --load)            RUN_LOAD=1 ;;
    --no-execution)    RUN_EXECUTION=0 ;;
    --no-subscribers)  RUN_SUBSCRIBERS=0 ;;
    --subscribers)     SUBSCRIBERS="$2"; shift ;;
    --regression-only) RUN_EXECUTION=0; RUN_SUBSCRIBERS=0; RUN_LOAD=0 ;;
    --realistic)       STEP_SECONDS_MIN=60; STEP_SECONDS_MAX=120 ;;
    --minutes)         EXEC_MINUTES="$2"; shift ;;
    --instances)       OBSERVE_INSTANCES="$2"; shift ;;
    --terminate)       TEARDOWN=terminate ;;
    --leave)           TEARDOWN=leave ;;
    -h|--help)         usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

missing=()
[[ -n "${HEROKU_API_KEY:-}" ]] || missing+=(HEROKU_API_KEY)
for v in K6_PROMETHEUS_RW_SERVER_URL K6_PROMETHEUS_RW_USERNAME K6_PROMETHEUS_RW_PASSWORD; do
  [[ -n "${!v:-}" ]] || missing+=("$v")
done
if (( ${#missing[@]} )); then
  echo "missing from the environment: ${missing[*]}" >&2
  echo "put them in the repo's .env (direnv loads it) — see .envrc for the names" >&2
  exit 1
fi

# caffeinate keeps a Mac from idle-sleeping for the run's length; elsewhere just run it.
keep_awake=()
if command -v caffeinate >/dev/null 2>&1; then keep_awake=(caffeinate -is); fi

echo "AWS run: execution=$RUN_EXECUTION ($OBSERVE_INSTANCES instances, $EXEC_MINUTES min, ${STEP_SECONDS_MIN}–${STEP_SECONDS_MAX} s/step) subscribers=$RUN_SUBSCRIBERS ($SUBSCRIBERS + $CHURN_VUS churn, $SUBSCRIBER_MINUTES min) load=$RUN_LOAD teardown=$TEARDOWN"
exec "${keep_awake[@]}" env \
  AUTO=1 \
  RUN_EXECUTION="$RUN_EXECUTION" RUN_SUBSCRIBERS="$RUN_SUBSCRIBERS" RUN_LOAD="$RUN_LOAD" TEARDOWN="$TEARDOWN" \
  SUBSCRIBERS="$SUBSCRIBERS" CHURN_VUS="$CHURN_VUS" SUBSCRIBER_MINUTES="$SUBSCRIBER_MINUTES" \
  EXEC_MINUTES="$EXEC_MINUTES" OBSERVE_INSTANCES="$OBSERVE_INSTANCES" \
  STEP_SECONDS_MIN="$STEP_SECONDS_MIN" STEP_SECONDS_MAX="$STEP_SECONDS_MAX" \
  loadtest/aws-first-run.sh
