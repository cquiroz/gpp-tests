#!/usr/bin/env bash
# One bisect step for an odb regression on the AWS load target
# (research/execution-overhead-2026-10-07.md):
#
#   loadtest/bisect-odb.sh 3146            # a lucuma-odb PR number (its merge commit on main)
#   loadtest/bisect-odb.sh 1f9e5660993b…   # or a commit sha
#   loadtest/bisect-odb.sh --read          # only re-read the newest run's verdict
#
# lucuma-odb's CI pushes every main build to Heroku's registry tagged with the commit sha
# (web and obscalc alike), so a build needs no building: the step boots the stack on the pair
# with both images pinned to that commit, runs the regression suite and BISECT_MINUTES
# (default 5) of the standalone execution profile at the compressed cadence, stops the pair,
# then judges the run by BISECT_SIGNAL (default `cpu:postgres med>400`; the 2026-10-07
# regression's signature is ~1270 % median against 4 % before it; grammar in lib/bisect.js).
# About 25 minutes and $0.60. tools/bisect-odb.js runs a whole search of these steps.
#
# The sha must be a main-branch merge whose CI run succeeded (a cancelled run pushed no
# image); the step exits 3 when the registry has no image for it, so the search can skip it.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

REGISTRY="registry.heroku.com/lucuma-postgres-odb-dev"

# The verdict is tools/bisect-odb.js --judge (lib/bisect.js): BISECT_SIGNAL, default
# `cpu:postgres med>400`, read against the run's docker stats log and k6 summary.
read_verdict() { node tools/bisect-odb.js --judge "$@"; }

if [[ "${1:-}" == "--read" ]]; then read_verdict; exit; fi
[[ -n "${1:-}" ]] || { sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2; }

ref="$1"
if [[ "$ref" =~ ^[0-9]+$ ]]; then
  sha="$(gh pr view "$ref" --repo gemini-hlsw/lucuma-odb --json mergeCommit --jq .mergeCommit.oid)"
  [[ -n "$sha" ]] || { echo "PR #$ref has no merge commit" >&2; exit 1; }
  echo "PR #$ref → $sha"
else
  sha="$ref"
fi

for image in web obscalc; do
  docker manifest inspect "$REGISTRY/$image:$sha" >/dev/null 2>&1 \
    || { echo "no image $REGISTRY/$image:$sha in the registry (CI cancelled for that merge?)" >&2; exit 3; }
done

# The ITC and SSO are built from the same repository, and the odb of one commit must run with
# the ITC and SSO of that commit (an older odb with today's pair answered 500 to subtitle edits
# and calculated results, 2026-10-09). Their images are only pushed when a merge touched them,
# so each resolves to the newest main build at or before the commit that has one.
main_shas() {
  gh run list --repo gemini-hlsw/lucuma-odb --branch main --workflow ci.yml --limit 1000 \
    --json headSha,createdAt,conclusion \
    --jq '[.[] | select(.conclusion == "success")] | sort_by(.createdAt) | reverse | .[].headSha'
}
resolve_tag() { # resolve_tag <registry path> <sha> — the newest tag at or before <sha>
  local image="$1" from="$2" seen="" s
  while read -r s; do
    [[ -n "$seen" || "$s" == "$from" ]] || continue
    seen=1
    if docker manifest inspect "$image:$s" >/dev/null 2>&1; then echo "$s"; return 0; fi
  done < <(main_shas)
  return 1
}
itc_sha="$(resolve_tag registry.heroku.com/itc-dev/web "$sha")" \
  || { echo "could not find an itc image at or before $sha" >&2; exit 1; }
sso_sha="$(resolve_tag registry.heroku.com/lucuma-sso-dev/web "$sha")" \
  || { echo "could not find an sso image at or before $sha" >&2; exit 1; }
echo "images: $REGISTRY/{web,obscalc}:$sha · itc-dev/web:${itc_sha:0:8} · lucuma-sso-dev/web:${sso_sha:0:8}"

# A build inside the window may be broken in ways that have nothing to do with the question
# (#3146's subtitle edits answer 500 under ten VUs, 2026-10-09): the smoke and regression
# stages are allowed to fail, because the signal is the execution stage's Postgres CPU and the
# execution VU edits nothing. The verdict says so when they did.
# The target's database persists across runs and bootstrap only migrates forward, so a build
# older than the schema already there answers 500 (#3146 against V1339, 2026-10-09). A bisect
# step therefore starts from an empty database (WIPE_DATA=1) — which also means it measures
# the build on a small database, not on the one the regression was first seen on; see the
# handoff note before reading a FAST as final. WIPE_DATA=0 keeps the data.
started="$(mktemp)"; trap 'command rm -f "$started"' EXIT
ODB_IMAGE="$REGISTRY/web:$sha" OBSCALC_IMAGE="$REGISTRY/obscalc:$sha" \
ITC_IMAGE="registry.heroku.com/itc-dev/web:$itc_sha" SSO_IMAGE="registry.heroku.com/lucuma-sso-dev/web:$sso_sha" \
CONTINUE_AFTER_SMOKE_FAILURE=1 CONTINUE_AFTER_FAILURE=1 WIPE_DATA="${WIPE_DATA:-1}" \
  loadtest/aws-run.sh --no-subscribers --minutes "${BISECT_MINUTES:-5}" "${@:2}"

echo
echo "bisect step for $sha:"
# Judge only a run this step collected: the wizard carries on past failed stages, and the
# newest files in out/ could otherwise be an earlier step's.
newest="$(ls -t out/k6-aws-execution-*.json 2>/dev/null | head -1 || true)"
if [[ -n "$newest" && "$newest" -nt "$started" ]]; then
  stamp="${newest#out/k6-aws-execution-}"; read_verdict "${stamp%.json}"
else
  echo "no execution run collected by this step" >&2; exit 1
fi
