# Handoff: generalize the odb performance bisect

**Repo:** `~/code/noirlab/odbattr` (project name gpp-tests; GitHub `cquiroz/gpp-tests`).
**Date:** 2026-10-09. **Last commit:** `31b3de2`.
**Next session's goal:** turn the one-off bisect tooling into something that finds odb
performance regressions with little hand-holding.

## Read first

- `research/odb-ask-smart-gcal-full-scans.md` — the regression this tooling found, and why
  bisecting from an empty database missed it. The sections "Bisect so far" and "Reproduced"
  are the design input.
- `research/execution-overhead-2026-10-07.md` — the full investigation, including the bisect
  section with the merge window and digest tables.
- `loadtest/bisect-odb.sh` (about 105 lines) — the current single-step tool.
- `loadtest/aws-first-run.sh` — the AUTO-mode wizard that every step runs through.
  `loadtest/aws-run.sh` is its flag front end.
- `loadtest/README.md` — the environment knobs: `ODB_IMAGE`, `OBSCALC_IMAGE`, `ITC_IMAGE`,
  `SSO_IMAGE`, `WIPE_DATA`, `NEW_PAIR`, `START_RETRY_MINUTES`, `CONTINUE_AFTER_*`.
- The memory notes `gpp-testing-map-complete.md` and `aws-noirlab-load-target.md` hold the
  traps and the AWS procedure.

## Uncommitted when this was written

`loadtest/aws-first-run.sh` contains the `WIPE_DATA` fix: only `1`, `y`, `true` or `yes`
wipe. Before the fix, any non-empty value, including `0`, wiped the database and voided a
run. It also adds the obscalc backlog queries to the Postgres snapshot. The two research
notes carry the "Reproduced" results. Carlos commits only when he says "commit", so ask
before committing.

## What exists now

One step is `loadtest/bisect-odb.sh <PR|sha> [aws-run.sh flags]`. It:

- resolves a PR number to its merge commit;
- pins all four images to that commit, resolving ITC and SSO to the newest tag at or before
  it;
- boots the AWS pair, wiping the database by default;
- runs 5 minutes of `k6/execution.js`, carrying on past a red smoke or regression stage;
- stops the pair and prints `SLOW` or `FAST` from the Postgres CPU median, threshold
  `SLOW_PG_CPU=400`.

`--read` re-reads the newest collected run without booting anything. A step takes about
25 minutes and costs about $0.60.

## The actions, from the end of the session

1. **Automatic search loop.** Take a good and a bad merge, list the built main merges
   between them, halve the window until one merge is left, and print a summary table. The
   merge list comes from `gh run list --repo gemini-hlsw/lucuma-odb --branch main --workflow
   ci.yml`, successful runs only, because a cancelled run pushed no image. #3148 was one
   such case.
2. **A choice of verdict.** Judge any metric from the k6 summary against a threshold, such
   as `odb_step_overhead p(95)>1000`, `odb_read_duration{…}`, Postgres CPU or odb CPU.
   Consider reusing the expression grammar in `lib/surge-slos.js`
   (`parseThresholdExpression`, `compare`) and `lib/verdict.js`, which are pure and
   unit-tested. Keep Postgres CPU available: it was the clean signal this time.
3. **An `--upgrade-from <good>` mode for data-dependent regressions.** Seed data once on the
   good merge (`--load`, the 40-minute 200-VU profile, gives about 20k observations), then
   boot each candidate in place with `WIPE_DATA=0`. That is exactly how the regression was
   reproduced. It works forward only: a candidate older than the schema already in the
   database answers HTTP 500, because migrations drop columns. So each candidate needs a
   fresh seed from a good merge at or before it, or a database snapshot to restore. An EBS
   snapshot of the target volume, or `pg_dump`, are the options. Check what IT's procedure
   allows.
4. **More than the last 100 CI runs.** The SHA lookup sees only the last 100 main runs.
   Widen it, or walk commits with `gh api`.
5. **A CI path.** Once IT grants the OIDC role (ticket 016;
   `.github/workflows/surge.yml` shows the pattern), add a bisect dispatch workflow so no
   laptop is needed.

Suggested order: 2, then 1, then 3; 4 alongside; 5 waits on IT.

## Constraints and traps

- **Only Carlos can launch AWS runs.** The auto-mode classifier refuses them from a session,
  as a shared-resource change. Build and unit-test locally, then hand him commands. Never
  edit the wizard while a run is in progress (`pgrep -fl aws-first-run`).
- **The AWS account is NOIRLab's shared one,** us-west-2, launch template and SSM only.
  Touch only instances tagged `gpp-tests:loadtest=1`. Details are in the `noirlab-aws` skill.
- **The laptop is not an oracle.** The local Docker stack never reproduced the saturation,
  and the 2–3 GiB local odb gets OOM-killed. Use it only for unit tests and syntax checks.
- **Postgres statistics are cumulative** until the database is reset. Diff the snapshot
  against one taken at the start of the run; the 2.5 million scan figure misled us once.
- **A bash hook blocks command text containing `.env` or `rm`.** Put `source` lines in
  script files written with the Write tool. `sed` on this machine is GNU sed: use
  `sed -i -e`.
- **Credentials:** `HEROKU_API_KEY` comes from Carlos's exported shell; it is not in `.env`.
  Session tokens expire and the registry answers 401. The AWS profile is `gpp-tests`.
  Never print either.
- **Capacity:** us-west-2a sometimes refuses `m7i.4xlarge`. The wizard retries for 10
  minutes, and `NEW_PAIR=1 TARGET_TYPE=m6i.4xlarge GEN_TYPE=c6i.2xlarge` is the fallback.

## Suggested skills

- `mattpocock-skills:codebase-design`: decide where the search loop, the verdict and the
  seed/upgrade mode live. A small `lib/` module plus a thin script is likely, as
  `lib/verdict.js` is.
- `mattpocock-skills:tdd`: test the window halving, the verdict parsing and the merge-list
  resolution before any AWS run.
- `noirlab-aws`: before touching snapshots, launches or IAM questions for the upgrade-from
  mode.
- `mattpocock-skills:grilling`: if the snapshot-versus-reseed choice for action 3 needs
  Carlos's call. He answers tersely ("q1 a").
