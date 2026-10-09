# For the odb team: smart-GCAL lookups scan the whole table, and #3145 runs them far more often

**Written:** 2026-10-09. **Carried by:** Carlos. **Status (2026-10-09, evening): the
statement is identified, the merge is not.** The two bisect steps across #3145 both read FAST
from an empty database (below, "Bisect so far"), so #3145 alone does not reproduce it, and the
scan totals in the table below are cumulative since 2026-10-02, not one run's. Send ask 1; hold
ask 2 until the control run says whether the regression needs a large database.
**Control done (below): it needs the data. Send both asks, and the warning under "Bisect so far" about
the first production deploy of a post-#3145 build.** **Reproduced the same evening** (section
"Reproduced"): upgrading #3137 → #3152 in place on 20k observations sent ~12k of them back to
obscalc and saturated Postgres. The likely trigger is #3145's generator-hash change.
Full history, numbers and earlier hypotheses: [`execution-overhead-2026-10-07.md`](execution-overhead-2026-10-07.md).

## The ask

1. **Make the smart-GCAL lookup use its index.** `SmartGcalService` matches every search
   column with `IS NOT DISTINCT FROM` (around lines 533–543 for GMOS North, the same pattern
   for the other instruments), which Postgres cannot serve from a b-tree index. Every lookup
   reads all 310,183 rows of `t_smart_gmos_north`. Building the predicate in Scala as
   `c = $1` when the value is present and `c IS NULL` when it is absent lets the existing
   search index (V0231, first three key columns) apply. This is worth doing whatever the
   call rate.
2. **Check how often #3145's calibration estimate generates calibrations.** Since #3145
   ("Update calibration count depending on tellurics", merged 2026-10-06 22:22 UTC) the
   estimate is computed on read ("add the calibration estimate on read", `3256dc28`) and
   refreshed from obscalc. If it generates the calibration sequence each time, every
   sequence and execution-config read now pays several full scans. Caching the smart-GCAL
   result per configuration, or computing the estimate once per obscalc pass, would remove
   most of them.

## What we measured

Two Observe instances executing GMOS long-slit observations at a 5–10 s step cadence
(`k6/execution.js`), on an m7i.4xlarge running the compose stack. Nothing else was running.

| odb build | Postgres CPU (median) | step ODB overhead p95 | RecordVisit p95 |
|---|---|---|---|
| #3137, 2026-10-06 00:00 UTC | 4 % | 570 ms | 300 ms |
| #3152, 2026-10-07 15:36 UTC | 1265 % | 1163 ms | 982 ms |
| #3155, 2026-10-07 20:31 UTC | 1290 % | 1260 ms | 885 ms |
| day's build, 2026-10-09 | 1391 % | 1865 ms | 1041 ms |

Postgres goes from idle to 12–14 of 16 cores within 30 s of the profile starting, on every
build after #3145's window. In the 75-minute deadline-surge run (2026-10-08) it stayed
saturated throughout. The surge failed its execution stall budget, and new proposals waited
the full 180 s for obscalc to define their observations.

## What Postgres says

Snapshot at the end of the 2026-10-09 run (`pg_stat_user_tables`, `pg_stat_activity`):

| table | seq scans | rows read by seq scan | index scans | live rows |
|---|---|---|---|---|
| `t_smart_gmos_north` | 2,508,262 | 778,014,026,819 | 0 | 310,183 |
| `t_exposure_time_mode` | 805,713 | 81,923,514,938 | 1,723,011 | 193,386 |
| `t_observation` | 466,731 | 12,457,857,580 | 13,104,722 | 64,454 |

- 778 billion rows over 2.5 million scans is exactly the table's size per scan: every lookup
  is a full scan, and the index has never been used. These counters are cumulative: the
  target's database was never reset, so they cover every run since 2026-10-02, not one.
- 19 of the 21 active queries at that moment were the smart-GCAL select
  (`SELECT g.c_gcal_continuum, g.c_gcal_ar_arc, … FROM t_smart_gmos_north s …`).
- `t_exposure_time_mode` is second and also mostly sequentially scanned; worth a look in the
  same pass.

## Bisect so far (2026-10-09)

Each step from an empty database, all four images pinned to the merge, five minutes of the
same execution profile:

| build | Postgres CPU median | step overhead p95 | smart-GCAL full scans in the run |
|---|---|---|---|
| #3146 (just before #3145) | 4 % | 557 ms | 2,439 |
| #3145 | 2 % | 659 ms | 2,667 |

On a small database the full scans cost the same on both sides of #3145 and Postgres stays
idle. Two readings remain, and one run separates them:

- **The regression needs the accumulated data** (64k observations, 24k programs after a week
  of load runs): something whose work grows with the number of observations calls the lookup.
  Then #3145 stays the prime suspect, and a bisect from empty cannot find it.
- **The regression is a later merge** (#3151, #3144, #3150, #3154 or #3152).

The control is the known-slow #3152 from empty: `loadtest/bisect-odb.sh 3152`. SLOW means a
later merge, and the bisect continues with `3144`. FAST means the data matters.

**Control result: #3152 from empty reads FAST** (Postgres 4 %, step overhead p95 582 ms,
2,751 full scans in the run). This is the exact image that saturated Postgres on 2026-10-07.
**So the regression is build × data.** On a database holding a week of load-test data
(64k observations, 24k programs) the post-#3145 builds saturate Postgres. On an empty one
they do not, and the fast #3137 build ran on nearly the same data on 2026-10-06 without
saturating it.

The reading that fits everything we have: an upgrade to a post-#3145 build leaves obscalc a
recompute backlog over the existing observations — the new calibration estimate for each
one. Each recompute generates sequences, and each generation pays several full scans of the
smart-GCAL table. Obscalc ran at ~330 % CPU on 10-07, and on the accumulated database new
observations waited 28 s to 180 s to be defined because they queued behind the backlog. The
execution path then waits on a saturated Postgres. **If this is right, production will see
the same on its first deploy of a post-#3145 build, in proportion to its observation count.**
That is the reason to send this before the next promotion. The odb team can check it faster
than we can: count the observations obscalc must revisit after V1339 on a copy of a large
database.

**Our reproduction**, two runs, about $3 (the accumulated database was wiped by the bisect
steps, so it has to be rebuilt):

```
loadtest/bisect-odb.sh 3137 --load            # fast build, from empty, then the 40-min 200-VU profile builds the data
WIPE_DATA=0 loadtest/bisect-odb.sh 3152       # upgrade in place, expected SLOW
```

The second run's `out/pg-activity-execution-aws-<stamp>.txt` now also lists obscalc's
backlog by state (`c_obscalc_state`) and the count of stale calibration estimates, which
shows whether the upgrade queued a recompute of every existing observation.

## Reproduced (2026-10-09 21:00–21:46 UTC)

1. **#3137 from empty, then the 40-minute 200-user profile.** Regular class PASS (reads p95
   47 ms, writes ≤ 196 ms). The database is left with 20,242 observations and 7,561 programs.
   Obscalc state: **20,241 `ready`**, no backlog. This build made 478,623 full scans of the
   smart-GCAL table during the load and stayed healthy.
2. **#3152 booted in place on that database, then the execution profile.** **SLOW**:
   Postgres CPU median 1308 % (obscalc 153 %), step overhead p95 1846 ms, RecordVisit p95
   1057 ms. Obscalc state at the end of the run:

   | state | observations |
   |---|---|
   | `pending` | 11,697 |
   | `calculating` | 559 |
   | `ready` | 7,883 |

   `c_calibrations_stale` was 0 on every row, and the active queries were again the
   smart-GCAL select.

**What this shows.** The upgrade itself put the existing observations back through obscalc:
about 12,000 of 20,000 were still waiting some 20 minutes after boot. V1339's own
invalidation loop only touches infrared modes, and every observation here is GMOS. The
likely trigger is #3145's change to the generator-parameters hash (`3256dc28`, "Keep
tellurics out of the generator hash"): tellurics were dropped from `HashBytes[GeneratorParams]`,
so no stored hash matches the new build and every observation is recomputed. Each recompute
generates sequences and pays the smart-GCAL full scans, which saturates Postgres, and the
execution path queues behind it. On an empty database there is nothing to recompute, which
is why every bisect step from empty read FAST.

**What it means for production.** The first deploy of any build that changes that hash
recomputes every observation, at full-scan cost each, while Observe is executing. The
backlog lasts in proportion to the number of observations. Ours drained at roughly 8,000 in
20 minutes on 16 cores with nothing else running.

**What would fix it**, for the odb team to choose from:

- **Make the lookup indexable** (ask 1). This cuts the cost of every recompute, not only
  during a backlog.
- **Avoid invalidating everything when the hash format changes**, or throttle obscalc's
  recompute so execution traffic keeps its share of Postgres.
- **Treat a hash change as a deployment step.** Recompute before promotion, or during a
  window with no observing.

## Why #3145 was the first suspect (unconfirmed)

The lookup itself did not change between #3137 and #3152. The only merge in that window that
touches the sequence-generation path is #3145: `ObscalcService` +97, `CalibrationsUtils` +91,
`GeneratorParamsService` +74, `Generator` +25, `ExecutionDigestService`. Its new telluric
queries are gated to infrared modes, but the calibration estimate is computed for GMOS too.

The two-run confirmation across #3145 was run and did not confirm it from an empty database
(above). On your side, `EXPLAIN (ANALYZE, BUFFERS)` of the smart-GCAL select with a GMOS North
long-slit configuration shows the sequential scan directly.

## Notes for reproducing

- A laptop does not reproduce it. The local stack runs too few steps to issue the lookups at
  the target's rate.
- To pin a build, the odb, obscalc, ITC and SSO images must all come from the same merge. CI
  tags each of them by commit sha in the Heroku registry; ITC and SSO only exist for merges
  that touched them, so take the newest one at or before the commit.
- A database migrated by a newer build cannot run an older one. #3146 reads
  `c_calibration_count`, which V1339 drops.
