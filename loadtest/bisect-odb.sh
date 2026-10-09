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
# then reads the signal: Postgres CPU over the run (the regression's signature is ~1270 %
# median against 4 % before it) and the step overhead p95. About 25 minutes and $0.60.
#
# The sha must be a main-branch merge whose CI run succeeded (a cancelled run pushed no
# image); `gh run list --repo gemini-hlsw/lucuma-odb --branch main --workflow ci.yml` lists them.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

REGISTRY="registry.heroku.com/lucuma-postgres-odb-dev"
SLOW_PG_CPU="${SLOW_PG_CPU:-400}" # percent, median over the execution run; fast builds sit near 4

read_verdict() {
  local stats summary
  stats="$(ls -t out/odb-stats-aws-*.log 2>/dev/null | head -1 || true)"
  summary="$(ls -t out/k6-aws-execution-*.json 2>/dev/null | head -1 || true)"
  [[ -n "$stats" && -n "$summary" ]] || { echo "no execution run collected yet" >&2; return 1; }
  node -e '
    const fs = require("fs");
    const [stats, summary, slow] = process.argv.slice(1);
    const pg = [], odb = [], ob = [];
    for (const l of fs.readFileSync(stats, "utf8").trim().split("\n")) {
      for (const p of l.slice(21).split(";")) {
        const f = p.trim().split(/\s+/); if (f.length < 5) continue; const c = parseFloat(f[4]);
        if (f[0].includes("postgres")) pg.push(c); else if (f[0].includes("odb-1")) odb.push(c); else if (f[0].includes("obscalc")) ob.push(c);
      }
    }
    const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
    const m = JSON.parse(fs.readFileSync(summary, "utf8")).metrics;
    const p95 = (k) => m[k]?.["p(95)"]?.toFixed(0) ?? "—";
    const verdict = med(pg) > Number(slow) ? "SLOW" : "FAST";
    console.log(`${verdict}  postgres cpu median ${med(pg).toFixed(0)}% (odb ${med(odb).toFixed(0)}%, obscalc ${med(ob).toFixed(0)}%, ${pg.length} samples) · step overhead p95 ${p95("odb_step_overhead")} ms · RecordVisit p95 ${p95("odb_step_wait{operation:RecordVisit}")} ms · steps ${m.gpp_execution_steps?.count ?? "—"}`);
    console.log(`  ${stats}\n  ${summary}`);
  ' "$stats" "$summary" "$SLOW_PG_CPU"
}

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
    || { echo "no image $REGISTRY/$image:$sha in the registry (CI cancelled for that merge?)" >&2; exit 1; }
done

# The ITC and SSO are built from the same repository, and the odb of one commit must run with
# the ITC and SSO of that commit (an older odb with today's pair answered 500 to subtitle edits
# and calculated results, 2026-10-09). Their images are only pushed when a merge touched them,
# so each resolves to the newest main build at or before the commit that has one.
main_shas() {
  gh run list --repo gemini-hlsw/lucuma-odb --branch main --workflow ci.yml --limit 100 \
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
ODB_IMAGE="$REGISTRY/web:$sha" OBSCALC_IMAGE="$REGISTRY/obscalc:$sha" \
ITC_IMAGE="registry.heroku.com/itc-dev/web:$itc_sha" SSO_IMAGE="registry.heroku.com/lucuma-sso-dev/web:$sso_sha" \
CONTINUE_AFTER_SMOKE_FAILURE=1 CONTINUE_AFTER_FAILURE=1 WIPE_DATA="${WIPE_DATA:-1}" \
  loadtest/aws-run.sh --no-subscribers --minutes "${BISECT_MINUTES:-5}" "${@:2}"

echo
echo "bisect step for $sha:"
read_verdict
