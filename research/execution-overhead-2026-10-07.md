# Execution step overhead doubled on the 2026-10-07 odb builds

> **Follow-up for the odb team:** [`odb-ask-smart-gcal-full-scans.md`](odb-ask-smart-gcal-full-scans.md) (2026-10-09) — the cause, the ask and the numbers on one page.

A handoff for the odb team, from the gpp-tests load target. Everything below is from the
unattended AWS runs (`loadtest/aws-run.sh`): the same `m7i.4xlarge` target, the same
generator, the same parameters every time — 2 Observe instances, one GMOS long-slit step
every 5–10 s per instance for 20 minutes, the odb at a 15.7 GiB heap. Only the images
changed, because the target pulls the day's `-dev` builds.

## What moved

| Run (collect, UTC) | odb digest | step overhead p95 / p99 | RecordVisit p95 | any mutation p95 / median | ExecutionConfig read p95 |
|---|---|---|---|---|---|
| 2026-10-03 to 10-05, five runs | 5968… and earlier | 567–652 / 646–720 ms | 282–322 ms | 52–54 / 29–31 ms | — |
| 2026-10-06 00:39 | `5968…b4c7d` | 570 / 646 ms | 300 ms | 50 / 28 ms | 198 ms |
| 2026-10-07 16:13 | `5a91…392ce` | 1163 / 2080 ms | 982 ms | 142 / 52 ms | 360 ms |
| 2026-10-07 21:09 | `ea50…aa4408` | 1260 / 1930 ms | 885 ms | 146 / 53 ms | 321 ms |

Step overhead is the sum of the moments an executing Observe step cannot proceed until the
odb answers (`CONTEXT.md`, "Step ODB overhead"); RecordVisit is its largest component.
Every class moved: the median of every mutation went from 28 to 52 ms, the 95th percentile
from 50 to 145 ms; RecordVisit tripled; the execution-config read over the websocket
nearly doubled. Zero errors in every run, 303–313 steps each. The figures are still inside
the provisional stall budget (p95 < 2 s, p99 < 5 s) — this is a step change, not a breach.

Full digests, for `docker pull registry.heroku.com/lucuma-postgres-odb-dev/web@<digest>`:

- fast: `sha256:59686ce805fd60166d6144aef1bf141bdd702cd48e868db14d0c1990a18b4c7d` (run of 2026-10-06 00:00 UTC)
- slow: `sha256:5a91ea539a00677c2e83ffde85827a301961a43b30a95acbd72a6cd5c70392ce` (2026-10-07 15:36 UTC)
- slow: `sha256:ea502a62485168b1b37722c6cce7e9d561ae53e0c7f96d7cd12187c694aa4408` (2026-10-07 20:31 UTC)

obscalc, itc and sso also moved to new digests on the 7th (in `out/aws-run-20261007T*.log`),
but the slow operations are odb mutations and an odb websocket read, and obscalc is not on
the execution path once an observation's sequence exists.

## What landed upstream between the builds

`gemini-hlsw/lucuma-odb` main, 2026-10-05 night to 2026-10-07 (`gh api .../commits`):

- **#3154 "Remove natchez in favour of otel4s everywhere"** (2026-10-07). A tracing-library
  swap on every request would explain a uniform ~2× on every mutation's median. First
  candidate.
- **#3145 "Update calibration count depending on tellurics"** (2026-10-06): "observe visits
  spend tellurics", the calibration estimate refreshed on telluric changes, infrared digests
  invalidated by migration. Extra work on `recordVisit` would explain RecordVisit moving
  3× while the rest moved 2×. Second candidate, for the RecordVisit part.
- #3155 health endpoints, #3153/#3150 dependency bumps, #3152 angle precision — unlikely.

Not bisected from here: the target boots whatever `-dev` publishes. If the team can point
the stack at a build before and after #3154 (`ODB_IMAGE=…@sha256:…` to bootstrap), two
20-minute execution runs settle it; `loadtest/aws-run.sh --no-subscribers` is the command.

## Addendum 2026-10-08 — Postgres is where the time goes

The container samples the wizard takes every 30 s on the target (`out/odb-stats-aws-*.log`)
were not in the table above. They say the build change moved Postgres from idle to saturated
under the identical profile (2 instances, 5–10 s per step, 20 minutes, nothing else running):

| odb build | postgres CPU median / p90 / max | obscalc max | odb max |
|---|---|---|---|
| 2026-10-06 00:00 UTC (fast, `sha256:59686ce8…`) | 3.7 % / 32 % / 215 % | 28 % | 81 % |
| 2026-10-07 15:36 UTC (slow, `sha256:5a91ea53…`) | 1265 % / 1378 % / 1407 % | 324 % | 98 % |
| 2026-10-07 20:31 UTC (slow, `sha256:ea502a62…`) | 1290 % / 1379 % / 1404 % | 346 % | 107 % |

Twelve to fourteen of the box's sixteen vCPUs, continuously, driven by two Observe
instances. The first composed surge run (2026-10-08, odb `sha256:0eccc0455bc0…`, obscalc
`sha256:7c1eb178a779…`; 2 instances at the real 60–120 s cadence plus 200 guests, 100 Explore
tabs and 250 submissions/h) held Postgres at 1150–1295 % for its whole 75 minutes, with
RecordVisit p95 1.8 s, ExecutionConfig read p95 1.1 s, and obscalc at ~100 % while every new
proposal's observation took the full 180 s timeout to become defined.

So the 2× is not a per-request tracing cost alone: the 10-07 odb, or the obscalc that moved
with it, issues far more or far heavier queries. The obscalc figure points at #3145's
"infrared digests invalidated by migration": an obscalc that re-derives digests continuously
would look exactly like this, and so would a per-visit telluric query over a growing table.
`pg_stat_statements` is not enabled in the stack; the wizard now saves `pg_stat_activity` and
`pg_stat_user_tables` (sequential scans and tuples read per table) at the end of a surge
(`out/pg-activity-surge-aws-<stamp>.txt`), which should name the table.

### Bisecting it: every build is in the registry (2026-10-08)

lucuma-odb's CI pushes each main build to Heroku's registry tagged with its commit sha, web
and obscalc alike (`ci.yml`, "Push … Docker images to Heroku"), and the registry keeps them.
Resolving the tags (`docker manifest inspect`) pins the builds this note is about to merges:

| Build | main merge | odb digest | obscalc digest |
|---|---|---|---|
| fast, 2026-10-06 00:00 UTC | #3137 `34bd0453` | `sha256:59686ce8…` | `sha256:f0af96e6…` |
| slow, 2026-10-07 15:36 UTC | #3152 `1d6d308b` | `sha256:5a91ea53…` | `sha256:a9bbe13f…` |
| slow, 2026-10-07 20:31 UTC | #3155 `cb255dcc` | `sha256:ea502a62…` | `sha256:3a2860d0…` |

So the window is the eleven built merges after #3137 up to #3152, in main order: #3138,
#3140, #3143, #3147, #3146 (which also carries #3148, whose own CI run was cancelled and
pushed no image), #3145, #3151, #3144, #3150, #3154, #3152.

**Pin all four images from the same merge: odb, obscalc, ITC and SSO.** They are one
repository. The 10-06 odb with the day's other images (2026-10-08) and the #3146 odb and
obscalc with the day's ITC and SSO (2026-10-09) both booted green and then answered HTTP 500
to `observationCalculated` and `updateObservation` (and `recordVisit`); the #3146 odb with its
own ITC and SSO passes the whole regression suite. ITC and SSO images are only pushed by
merges that touched them, so `bisect-odb.sh` resolves each to the newest main build at or
before the commit that has one. The wizard refuses a run with only one of odb/obscalc set.

One step is one command, about 25 minutes and $0.60 on the pair:

```
loadtest/bisect-odb.sh 3146        # a PR number, or a main commit sha
```

It pins `registry.heroku.com/lucuma-postgres-odb-dev/{web,obscalc}:<sha>`, boots the stack,
runs the regression suite and five minutes of the standalone execution profile, stops the
pair, and prints `SLOW` or `FAST` from the Postgres CPU median over the run (the signature:
~1270 % against 4 %), with the step overhead p95 beside it. Four steps cover the window:

1. **#3146** (`1f9e5660`, the middle). SLOW → the culprit is in #3138, #3140, #3143, #3147,
   #3148 or #3146; FAST → in #3145, #3151, #3144, #3150, #3154 or #3152.
2. SLOW branch: **#3143** (the odb team's suspect; FAST here clears it and leaves #3147,
   #3148, #3146 — then #3147). FAST branch: **#3144** (SLOW → #3145 or #3151, then #3145;
   FAST → #3150, #3154 or #3152, then #3154).
3. and 4. as the tree says; the last step names the merge.

`loadtest/bisect-odb.sh --read` re-reads the newest collected run without booting anything.

**The target's database was never reset (found 2026-10-09).** `stack/scripts/bootstrap.sh`
migrates forward and drops nothing; only `down.sh` removes volumes, and the wizard never ran
it. The pair is stopped between runs, not terminated, so every run since 2026-10-02 — the
200-VU trend run, the execution and subscriber runs, the surge — wrote into the same
database. Three consequences:

- *The numbers above were measured on an accumulating database*, not a fresh one. The fast
  10-06 run and the slow 10-07 runs saw nearly the same data (one small run between them), so
  the step is still the build's; but a query that scales with table size would show as a
  much smaller step on an empty database, and the laptop's small database may be why it
  shows nothing at all (below).
- *A pinned older build breaks on it.* #3146's odb still reads `c_calibration_count`, which
  V1339 (from #3145, merged four hours later) drops; the target's schema was already at
  V1339 and beyond, so the smoke run's subtitle edits and calculated-results reads answered
  500. The same explains the 10-08 "mixed images" failure. The ITC/SSO pairing rule above
  stands on its own, but it was not what broke those runs.
- *The 10-07 and 10-08 odb team hypothesis about an empty migration loop* was about a fresh
  database; the target's was not, and V1324/V1339's one-off loops ran over tens of thousands
  of observations at the first boot of each build. One-off, though, and the saturation
  recurs every run.

The wizard now says so at bootstrap, and `WIPE_DATA=1` runs `down.sh` first; the bisect
steps wipe by default, because an older build cannot run on a newer schema. That means the
bisect measures each build on a small database. If every step reads FAST, the regression is
build × data: the next move is one run of the current build on the accumulated database
with the per-table scan counts the wizard now collects (`loadtest/aws-run.sh --no-subscribers
--minutes 5`, no wipe), which names the table, before the data is ever wiped. **Do that run
first, before any wipe.**

**Obscalc is behind on the accumulated database (2026-10-09 15:03 UTC, the day's build, odb
`sha256:66a64313…`, no wipe).** The regression suite, which passes in a minute on an empty
database, took five: the proposal's observation waited 28 s to become defined (3 s is
normal) and none of the eleven calculated observing modes got a sequence and time estimate
within the suite's 60 s, while reads and writes themselves were quick (smoke 662/662 checks,
0 GraphQL errors). Obscalc was not reaching new observations. Together with obscalc at ~330 %
CPU through the slow 10-07 runs and the surge's 180 s definition waits, the shape is a
backlog or a loop in obscalc over the accumulated data — for example calibration
invalidation re-marking rows that obscalc's own updates touch — rather than a slow query on
the execution path; the execution overhead would then be the odb queueing behind it on
Postgres. The run stopped at the regression gate, before the snapshots; the wizard now takes
the odb and obscalc logs and the Postgres snapshot at a red regression too.

**Postgres names the statement (2026-10-09 16:32–16:38 UTC, day's build, accumulated
database).** The execution stage reproduced the regression (Postgres CPU median 1391 %,
step overhead p95 1.9 s, RecordVisit p95 1.0 s), and the snapshots taken at the end of the
regression and execution stages agree:

| table | seq scans | rows read by seq scan | index scans | rows |
|---|---|---|---|---|
| `t_smart_gmos_north` | 2,508,262 | 778,014,026,819 | **0** | 310,183 |
| `t_exposure_time_mode` | 805,713 | 81,923,514,938 | 1,723,011 | 193,386 |
| `t_observation` | 466,731 | 12,457,857,580 | 13,104,722 | 64,454 |

and 19 of the 21 active queries were one statement: the smart-GCAL lookup
(`SmartGcalService.selectGcal("t_smart_gmos_north", …)`, `SELECT g.c_gcal_continuum, …`).

- **Every smart-GCAL lookup reads the whole table.** 778 billion rows over 2.5 million scans
  is exactly 310,183 rows per scan, and the table has never been read through an index.
  `t_smart_gmos_north` has a search index (on its first three key columns, `SmartGcalTable`,
  V0231), but the lookup matches every column with `IS NOT DISTINCT FROM` (`SmartGcalService`
  lines 533–543), which Postgres cannot use a b-tree index for. That is old code, unchanged in
  the window — each lookup has always cost a full scan of a 310k-row reference table.
- **What changed is how often it runs, and #3145 is where.** Between the fast build (#3137)
  and the first slow one (#3152), the only changes on the sequence-generation path are
  #3145's: `ObscalcService` (+97), `CalibrationsUtils` (+91), `GeneratorParamsService` (+74),
  `Generator` (+25), `ExecutionDigestService`, with commit messages such as "add the
  calibration estimate on read" (`3256dc28`) and "Refresh the calibration estimate on telluric
  changes" (`e3e06858`). An estimate that generates the calibration sequence — smart-GCAL
  lookups included — on every sequence and execution-config read, and again from obscalc,
  multiplies the full scans. This corrects the addendum above: #3145's *new queries* are
  gated to infrared modes, but its calibration estimate is computed for GMOS too.
- **Why the laptop does not show it:** the local runs barely executed (30-odd steps in three
  minutes, the odb starved and killed), so they never issued the lookups at the rate the
  target does. The accumulated database is not needed: the smart-GCAL table is reference
  data, the same 310k rows in a fresh database.

**Two cheap confirmations**, both on the target:

1. Bisect across #3145 only: `loadtest/bisect-odb.sh 3146` (expected FAST) and
   `loadtest/bisect-odb.sh 3145` (expected SLOW), each from empty. Two runs, about $1.20.
2. For the odb team, independent of the bisect: rewrite the lookup's equality tests so the
   index applies (`c = $1` when the value is present, `c IS NULL` when absent, chosen in
   Scala), or index the expression the query uses. Either removes the full scans whatever
   the call rate, and `EXPLAIN` on the statement shows it at once.

**The laptop is not an oracle for this (2026-10-09).** Three builds were booted on the local
Docker stack with all four images pinned (#3137-era `latest`, #3146, #3152) and driven with
the same two-instance execution profile for three minutes; Postgres sat at a 3–4 % median on
every one, the slow #3152 included, with the regression suite's observations present and
with the wizard's smoke stage's 165 guest iterations on top. Whatever saturates Postgres on
the AWS target needs something the VM does not have — most likely the week of accumulated
data described above, possibly the 16 cores and full-size containers — and the local odb at
its 2–3 GiB cap is killed by the kernel within minutes of the profile anyway. The bisect runs on the target. Each step now also saves
`out/pg-activity-execution-aws-<stamp>.txt` (per-table scan counts and the active queries at
the end of the profile), which should name the table before the bisect even finishes.

## How to see it yourself

- The raw summaries: `out/k6-aws-execution-20261006T003932Z.json` (fast),
  `out/k6-aws-execution-20261007T161334Z.json` and `…T210956Z.json` (slow); each has
  `odb_step_overhead`, `odb_step_wait{operation:…}` per blocking point and `odb_write_duration`.
- Grafana Cloud carries the same series, remote-written during each run.
- Locally: `OBSERVE_INSTANCES=2 STEP_SECONDS_MIN=5 STEP_SECONDS_MAX=10 DURATION=3m npm run k6:execution`
  against a stack booted with each image; absolute numbers differ on a laptop, the ratio
  should not.

## Why it matters now

The surge SLO file (ticket 023) is about to pin the execution budget. A 2× step on a
routine `-dev` build, a week before the composed deadline run, is the case for the nightly
execution trend the trend run does not yet carry — and the kind of change the odb team
would want to know about before it reaches a telescope.

## Addendum 2026-10-08 (odb side) — the candidate window, corrected, and a better suspect

From reading the `lucuma-odb` source; nothing below has been run.

**The window is wider than listed above.** The fast build is 2026-10-06 00:00 UTC
(10-05 21:00 in the repo's -03 commit times). Merged to `main` after it and before the
first slow build (10-07 15:36 UTC): #3138, #3140, #3143, #3146, #3147, #3148, #3145, #3151,
#3144, #3150, #3154, #3152, #3153. #3155 (health endpoints) merged after 15:36 UTC and is
only in the 20:31 build.

**#3145 is unlikely for a GMOS load.** All of its new work is limited to infrared modes:
- the per-read calibration-group telluric query (`GeneratorParamsService.addCalibrationGroupTellurics`)
  runs only for science in modes that take tellurics (Flamingos-2, IGRINS-2, GNIRS);
- the new triggers on `t_observation` act only on tellurics, and those on `t_visit` and
  `t_obscalc` do one primary-key lookup and stop for a non-telluric;
- the migration's one-off `invalidate_obscalc` loop covers infrared science only, and is
  empty on a freshly bootstrapped database;
- the obscalc `refreshCalibrationsStream` polls a partial index on `c_calibrations_stale`
  that GMOS observations never set.

**#3143 ("Avoid querying topic feeds LISTEN session", merged 10-06 13:07 -03) is the
better suspect.** Before it, each `OdbTopic` feed ran its program-users lookup on the same
session it LISTENed on; the PR's own comment says that deadlocks silently during a burst of
notifications. If the old feeds were freezing under the execution load, the "fast" build
was a stalled system: the odb's topics stopped delivering, obscalc saw work only through
its poll, and the calibrations daemon's event stream went quiet. With the fix every event
gets through and drives the whole cascade (for example `cascade_calibration_invalidation`,
which fires on every `t_obscalc` update). That fits Postgres moving from idle to saturated,
and obscalc from 28 % to ~330 %, under an identical profile. If this is right, the 10-06
figures are not a healthy baseline, and the question becomes whether the cascade costs more
than it should.

**Check before bisecting.** Every feed logs `"<name> channel: <event>"` at INFO for each
event (`OdbTopic.scala`). Grep the odb and obscalc container logs of the fast 10-06 run for
`channel:`:
- the lines stop a few minutes into the run → the feeds deadlocked and the baseline is wrong;
- they continue for the whole run → #3143 is cleared, and #3154 (otel4s) is the lead again.

**Bisect points**, if needed: builds on either side of #3143 (10-06 13:07 -03) and of #3154
(10-07 09:33 -03).
