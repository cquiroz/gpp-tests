# Execution step overhead doubled on the 2026-10-07 odb builds

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
