#!/usr/bin/env bash
# Stop or terminate the AWS pair the wizard launched, from the state it saved (ticket 016):
#
#   loadtest/aws-teardown.sh                 stop both instances
#   loadtest/aws-teardown.sh --terminate     terminate them and forget their ids
#   loadtest/aws-teardown.sh --delete-key-pair   also delete the run's key pair (gpp-tests-ci-* only)
#
# The wizard tears down on its own, on success and on any failure (AUTO mode traps the exit).
# This is the backstop the surge workflow runs under `always()`: a runner that was killed, a
# job cancelled between two ssh calls, or a wizard that never got as far as saving the ids
# must not leave two instances billing until the safety stop. It is idempotent — nothing to
# do is a success — and refuses, like the wizard, to touch any instance it cannot prove was
# launched by this tooling (the gpp-tests:loadtest=1 tag and a gpp-tests-* Name, re-read
# from AWS). This run's attachment prefix in the bucket is deleted too, when saved.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

ACTION=stop
DELETE_KEY_PAIR=""
while (( $# )); do
  case "$1" in
    --stop)            ACTION=stop ;;
    --terminate)       ACTION=terminate ;;
    --delete-key-pair) DELETE_KEY_PAIR=1 ;;
    -h|--help)         sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

ENV_FILE="${ENV_FILE:-out/aws-loadtest-us-west-2.env}"
TAG_KEY="gpp-tests:loadtest"
TAG_VALUE="1"
NAMES_WE_LAUNCH="gpp-tests-target gpp-tests-generator"

saved() { [[ -f "$ENV_FILE" ]] && grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true; }

AWS_REGION="${AWS_REGION:-$(saved AWS_REGION)}"
AWS_REGION="${AWS_REGION:-us-west-2}"
# `none` (the workflow): credentials in the environment, no profile. Un-exported, because the
# AWS CLI reads AWS_PROFILE itself and would look for a profile called "none".
profile="${AWS_PROFILE:-$(saved AWS_PROFILE)}"
unset AWS_PROFILE
[[ "$profile" == "none" ]] && profile=""
awsx() {
  # shellcheck disable=SC2086
  aws --region "$AWS_REGION" ${profile:+--profile "$profile"} "$@"
}

TARGET_ID="$(saved TARGET_ID)"
GEN_ID="$(saved GEN_ID)"
KEY_NAME="${KEY_NAME:-$(saved KEY_NAME)}"
S3_BUCKET="$(saved S3_BUCKET)"
S3_PREFIX="$(saved S3_PREFIX)"

# ours ID — the instance exists, carries our tag and one of our names.
ours() {
  local id="$1" tag name
  tag="$(awsx ec2 describe-instances --instance-ids "$id" \
    --query "Reservations[0].Instances[0].Tags[?Key=='$TAG_KEY']|[0].Value" --output text 2>/dev/null || true)"
  name="$(awsx ec2 describe-instances --instance-ids "$id" \
    --query "Reservations[0].Instances[0].Tags[?Key=='Name']|[0].Value" --output text 2>/dev/null || true)"
  [[ "$tag" == "$TAG_VALUE" && " $NAMES_WE_LAUNCH " == *" $name "* ]]
}

ids=()
for id in $TARGET_ID $GEN_ID; do
  if ours "$id"; then
    ids+=("$id")
  else
    echo "refusing to touch $id: not an instance this tooling launched (or it no longer exists)" >&2
  fi
done

if (( ${#ids[@]} )); then
  states="$(awsx ec2 describe-instances --instance-ids "${ids[@]}" \
    --query 'Reservations[].Instances[].[InstanceId,State.Name]' --output text | tr '\t' ' ' | tr '\n' ';')"
  echo "instances: $states"
  case "$ACTION" in
    terminate)
      awsx ec2 terminate-instances --instance-ids "${ids[@]}" >/dev/null && echo "terminating ${ids[*]}"
      # Nothing to reuse: drop the ids so a later run never offers them back.
      if [[ -f "$ENV_FILE" ]]; then
        grep -vE '^(TARGET_ID|GEN_ID|TARGET_PRIVATE_IP)=' "$ENV_FILE" > "$ENV_FILE.tmp" || true
        mv "$ENV_FILE.tmp" "$ENV_FILE"
      fi
      ;;
    *)
      awsx ec2 stop-instances --instance-ids "${ids[@]}" >/dev/null && echo "stopping ${ids[*]}"
      ;;
  esac
else
  echo "no instances to tear down"
fi

if [[ -n "$S3_BUCKET" && -n "$S3_PREFIX" && -z "${KEEP_ATTACHMENTS:-}" ]]; then
  if awsx s3 rm --recursive --quiet "s3://$S3_BUCKET/$S3_PREFIX/" >/dev/null 2>&1; then
    echo "deleted s3://$S3_BUCKET/$S3_PREFIX"
  else
    echo "could not delete s3://$S3_BUCKET/$S3_PREFIX (already gone, or no access from here)" >&2
  fi
fi

# Only a per-run CI key pair is ever deleted: a laptop's key pair is reused across runs and
# its private key is the only way back into a stopped pair.
if [[ -n "$DELETE_KEY_PAIR" && "$KEY_NAME" == gpp-tests-ci-* ]]; then
  if awsx ec2 delete-key-pair --key-name "$KEY_NAME" >/dev/null 2>&1; then
    echo "deleted key pair $KEY_NAME"
  else
    echo "key pair $KEY_NAME not deleted (already gone, or no access)" >&2
  fi
elif [[ -n "$DELETE_KEY_PAIR" ]]; then
  echo "not deleting key pair $KEY_NAME: only gpp-tests-ci-* key pairs are per run" >&2
fi
