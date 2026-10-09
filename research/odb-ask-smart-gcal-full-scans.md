# For the odb team: smart-GCAL lookups scan the whole table, and #3145 runs them far more often

**Written:** 2026-10-09. **Carried by:** Carlos. **Status:** cause identified from Postgres's
own statistics; the two-step bisect that confirms the merge is not yet run.
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
  is a full scan, and the index has never been used.
- 19 of the 21 active queries at that moment were the smart-GCAL select
  (`SELECT g.c_gcal_continuum, g.c_gcal_ar_arc, … FROM t_smart_gmos_north s …`).
- `t_exposure_time_mode` is second and also mostly sequentially scanned; worth a look in the
  same pass.

## Why #3145, and what would confirm it

The lookup itself did not change between #3137 and #3152. The only merge in that window that
touches the sequence-generation path is #3145: `ObscalcService` +97, `CalibrationsUtils` +91,
`GeneratorParamsService` +74, `Generator` +25, `ExecutionDigestService`. Its new telluric
queries are gated to infrared modes, but the calibration estimate is computed for GMOS too.

Confirmation is two runs on our load target, each from an empty database with all four
images pinned to the merge (`loadtest/bisect-odb.sh` in gpp-tests):

```
loadtest/bisect-odb.sh 3146     # just before #3145 — expected FAST
loadtest/bisect-odb.sh 3145     # expected SLOW
```

On your side, `EXPLAIN (ANALYZE, BUFFERS)` of the smart-GCAL select with a GMOS North
long-slit configuration shows the sequential scan directly.

## Notes for reproducing

- A laptop does not reproduce it. The local stack runs too few steps to issue the lookups at
  the target's rate.
- To pin a build, the odb, obscalc, ITC and SSO images must all come from the same merge. CI
  tags each of them by commit sha in the Heroku registry; ITC and SSO only exist for merges
  that touched them, so take the newest one at or before the commit.
- A database migrated by a newer build cannot run an older one. #3146 reads
  `c_calibration_count`, which V1339 drops.
