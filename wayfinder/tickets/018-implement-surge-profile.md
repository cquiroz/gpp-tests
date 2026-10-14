---
id: 018
title: "Implement the surge profile and its on-demand workflow"
labels: [wayfinder:task]
status: open
assignee:
blocked-by: [016]
---

## Question

*Reshaped by ticket 020.* Compose the surge run from its layers: the regular-ops guest
mix (ramping VUs), the proposal loop (017, arrival rate), Explore-tab and Observe-browser
subscriber VUs (022), and Observe execution VUs (021, constant VUs), with the two tiers
and the 75-minute shape from 020 selectable at dispatch. Wire the surge SLO file and
verdict (023). The `workflow_dispatch` workflow boots the AWS target (016), runs the
surge from the generator, and publishes results with run identity and Grafana
annotations like the other suites. Prove it with one full real run per tier. Resolution
records the run links and each class's verdict.

## Findings so far

**Built 2026-10-07: `k6/surge.js`, the composition.** One body per layer, lifted out of the
standalone scripts into `k6/lib/guest-vu.js`, `proposal-vu.js`, `execution-vu.js` and
`subscriber-vu.js` (the standalone scripts now import them, so a layer measured on its own
and the same layer inside the surge are the same code), and five scenarios over the
10/60/5-minute shape of ticket 020:

| Scenario | Executor | Realistic | Ceiling |
|---|---|---|---|
| `guests` — the regular-operations mix | ramping VUs, 0 → N → 0 | 200 | 200 |
| `proposals` — PIs submitting against one call | ramping arrival rate, per hour, 0 → N → 0; up to 50 PIs | 250/h | 500/h |
| `observe` — Observe instances executing (service JWT) | constant VUs for the whole run | 2 | 4 |
| `explore` — PIs holding Explore tabs, 8 subscriptions each | ramping VUs, 0 → N → 0 | 100 | 200 |
| `observe-browsers` — staff with Observe's browser open | constant VUs for the whole run | 2 | 4 |

`SURGE_TIER` picks the column; every figure, the three durations (`RAMP_MINUTES`,
`STEADY_MINUTES`, `DRAIN_MINUTES`) and Observe's cadence (the real 60–120 s per step by
default) can be overridden by name. Every class in `k6/surge-slos.json` is armed, so the k6
exit code is the verdict, and `summaryTrendStats` carries every stat the verdict reads. Two
rules the composition imposed:

- **The pool must cover every VU id.** k6 hands VU ids out across all scenarios from one
  counter and has no per-scenario id, so a PI or staff identity is `idInTest − 1` into its
  pool, and each pool has to be at least the run's total VU count (354 realistic, 458
  ceiling). `setup()` refuses otherwise; the AWS wizard fabricates 500 of each at bootstrap
  when the surge is on (`POOL_PI_COUNT`, `POOL_STAFF_COUNT`). Guests and Observe instances
  need no pool identity, but their ids still count.
- **`proposals` keeps its name**: the SLO file's arrival-rate claim is
  `dropped_iterations{scenario:proposals}` (ticket 023).

Found on the first local smoke: when the odb went away (the 8 GiB Docker VM OOM-killed it
90 s into the composed run — the VM, as in 023), each Explore tab reconnected 16 times in
130 ms, because a session that cannot connect ended at once and the next iteration began.
`subscriber-vu.js` now waits 5–15 s after a failed session (`WS_RETRY_SECONDS_MIN/MAX`),
which is what a person with a dead tab does; 200 tabs no longer storm a restarting odb.

**Validated locally** (the Docker VM, 2.5-minute shape, tiny populations: 2–4 guests, 2–4
PIs at 120–240/h, 2–3 tabs, one instance, one browser): all five scenarios ran, checks
100 %, no dropped iterations, 3 submissions, 9 steps, 9 sockets, and the verdict read every
class off one summary, including the two sub-metrics that exist only when the file is armed.
The breached rows (step overhead p95 2.5 s, event latency p95 2 s) are the starved local odb,
the same figures 023 saw per layer; the composition itself is the thing proven here.

**On the load target** the run is `loadtest/aws-run.sh --surge realistic` and `--surge
ceiling`: stage 10 of the wizard runs `k6/surge.js` detached on the generator with the pool,
the service JWT and the Grafana credentials sourced, samples the odb throughout, and the
collect stage prints one line per layer and the whole-file verdict beside the JSON
(`out/k6-aws-surge-<tier>-<stamp>-verdict.md`). The on-demand workflow is `surge.yml`
(ticket 016 — written, waiting on IT's role). Not yet run: the two full-length runs that
close this ticket need a laptop to start them, and that is the next step.

**Run 1, realistic tier, 2026-10-08 13:22–14:38 UTC** (`out/k6-aws-surge-realistic-20261008T143855Z.*`,
odb `sha256:0eccc0455bc0…`, obscalc `sha256:7c1eb178a779…`, the day's `-dev` images):
**FAIL on two rows, PASS on the other sixteen.**

| Class | Result | Observed |
|---|---|---|
| Execution | **FAIL** | step overhead p95 **2817 ms** (budget 2000), p99 3618 ms (pass); RecordVisit p95 1776 ms, ExecutionConfig read p95 1111 ms, Flush 412 ms; mutations p95 310 ms; 102 steps; 0 timeouts |
| Proposals | **FAIL** | submit p95 748 ms (pass); **2 dropped iterations** (budget 0); 135 first submissions + 86 resubmissions; every new observation waited the full 180 s for obscalc (`gpp_proposal_definition_wait` p95 183 s), so PIs stayed busy and the arrival rate was missed twice |
| Regular | PASS | open program p95 176 ms, edit 375 ms, create observation 629 ms, create program 88 ms |
| Subscriptions | PASS | event latency p95 386 ms, round trip 66 ms, 308 sockets, 0 lost, 0 reconnects |
| Errors | PASS | checks 99.99 % of 771k requests, 0 GraphQL errors |

Two things behind the numbers that the verdict table does not show:

- **Postgres was saturated for the whole run** — 1150–1295 % CPU (12–13 of 16 vCPUs) from the
  seventh minute on; odb ~200 %, obscalc ~100 %, caddy 13 %. This is the 2026-10-07 odb
  regression, not the composition: the standalone execution runs on the 10-07 builds already
  show Postgres at ~1270 % median where the 10-06 build sat at 4 % (addendum in
  `research/execution-overhead-2026-10-07.md`). The execution breach and the obscalc
  definition timeouts are what that regression looks like with the rest of the deadline on top.
- **Explore tabs stopped being able to connect 30 minutes in.** 22,479 failed websocket
  connects from the tabs and 551 from the Observe browsers, from 13:52 to the end, at about
  10 a second (the 5–15 s backoff held it there). The tabs had connected and reconnected
  cleanly twice before; the third wave failed, and so did every later one. The error k6
  reports is only "closed" — the odb's refusal is in its own log, which was not collected.
  The 308 sockets that did connect measured fine, so the subscription class passed on a
  population far smaller than the tier asks for; that pass should not be read as the claim.
  The wizard now saves the odb log and `pg_stat_activity` at the end of a surge.

What this run settles: the composition runs for 75 minutes on the pair with 354 VUs, every
class reaches the verdict, and the generator was nowhere near its limit. What it does not
settle is the claim, because the odb under test was mid-regression. The remaining runs are
only comparable if they share a build: `ODB_IMAGE=…@sha256:59686ce8…` (the 10-06 build) pins
one for the surge measurement, and one run on the current build stays the record for the odb
team.

**Runs 2 and 3, on the fixed odb (2026-10-11 realistic, 2026-10-13 ceiling).** The 10-07
regression was fixed by lucuma-odb #3174 (`research/odb-ask-smart-gcal-full-scans.md`), so
both runs used the day's `-dev` images with `WIPE_DATA=1`. Both verdicts read **PASS on every
row**, but the subscriptions class was measured on a population that stopped reconnecting
30 minutes in. It is a bug in our subscriber VU, fixed below, and those two rows need a rerun.

| | Run 2 · realistic · 10-11 21:22 UTC | Run 3 · ceiling · 10-13 13:07 UTC |
|---|---|---|
| Files | `out/k6-aws-surge-realistic-20261011T212249Z.*` | `out/k6-aws-surge-ceiling-20261013T142352Z.*` |
| odb | `-dev` `sha256:2da16923f0d1…` | `-dev` `sha256:920ab68a64df…` |
| Peak VUs | 315 | 427 |
| Execution | PASS · step overhead p95 346 ms, p99 395 ms · 98 steps | PASS · p95 354 ms, p99 408 ms · 206 steps |
| Proposals | PASS · submit p95 149 ms · 281 submissions · 0 dropped | PASS · submit p95 153 ms · 562 submissions · 0 dropped |
| Regular | PASS · open program p95 27 ms, edit 80 ms, create observation 113 ms | PASS · 28 ms, 81 ms, 113 ms |
| Subscriptions | PASS on what connected (event latency p95 74 ms, round trip 12 ms, 0 lost) · **22,487 + 549 failed connects** | PASS on what connected (81 ms, 14 ms, 0 lost) · **44,978 + 1,076 failed connects** |
| Errors | PASS · checks 100 % of 826k | PASS · checks 100 % of 837k |
| Postgres CPU | median 304 %, max 634 % | median 325 %, max 584 % |
| odb CPU · memory | median 197 % · 6.4 → 10.9 GiB | median 214 % · 6.4 → 11.2 GiB |

Against run 1 on the regressed build, Postgres fell from ~1270 % to ~310 % median. Step overhead
p95 fell from 2817 ms to about 350 ms. Obscalc's definition wait for new proposal observations
fell from 183 s to 22–24 ms. The ceiling tier doubles the submissions and steps at the same
latencies, so the pair has headroom at this shape.

**The failed connects are ours: expired JWTs.** The subscriber VUs logged in once and reused
that token for every later session. The surge holds a session for 600 s, which is SSO's
whole JWT lifetime. The odb checks the token only at `connection_init`, so held sockets carried
on, but reconnects with the old token were refused. The odb log ends with 337
`4403 Forbidden: Access denied` closes, each after `JwtExpirationException: The token is expired
since 13:18–13:19`. That log keeps only the last 20,000 lines. Connects at +10 and +20 minutes
still succeeded with the expired token; from +30, every one was refused, in run 1 too. Why the
odb accepted them for a while (a cache in its SSO client?) was not checked. The standalone
subscribers profile never ran long enough to show it.

Two changes, 2026-10-13:

- **`k6/lib/subscribers.js`** refreshes the identity's JWT before every connect, every
  in-session reconnect and every HTTP edit, as the guest and proposal VUs already did.
- **The verdict now catches it.** `odb_ws_connect_failures` counts every connect that never
  reached `connection_ack`: refused, errored or timed out, first connect or reconnect. A new
  subscriptions SLO in `k6/surge-slos.json` budgets it `count==0`, and the wizard's subscriber
  summary prints it. Runs 2 and 3 would have failed that row.

Local proof: 14 minutes of `k6/subscribers.js`, 12 VUs on 2-minute sessions, well past the JWT
lifetime. Result: 75 sessions, 75 connections, **0 failed connects**, 0 lost events. The VUs
made 10 refresh calls (437 requests = 415 checked operations + 12 logins + 10 refreshes). Its
failed checks were HTTP 500s on subtitle edits from the local stack, which still runs odb #3146
from the bisect against a database migrated past V1339 (`c_calibration_count`). They are not
from the change.

**What stood and what needed a rerun** (done: runs 4 and 5 below). The execution, proposals, regular and errors rows stand
for both tiers. The subscriber population was smaller than the tier for the last 45 minutes,
which made those runs lighter than the claim. The other classes passed with room to spare under
the lighter load, but the rerun is the measurement. The subscriptions row needs both tiers run
again with the fix: `WIPE_DATA=1 loadtest/aws-run.sh --surge realistic`, then `… ceiling`.
Watch item for the reruns: odb memory climbed 6.4 → ~11 GiB over 75 minutes in both runs, under
the 15.7 GiB heap cap. That may be the heap growing into its cap rather than a leak; a flat end
of the line would settle it.

**Runs 4 and 5, the reruns with the JWT fix (2026-10-14).** Both tiers again, on the same
`-dev` images for both (odb `sha256:9fcf04d12d34…`, obscalc `sha256:2944a0338b6c…`),
`WIPE_DATA=1`, `cf7d6f4` on the generator. Both read **PASS on every row, failed connects
included**, so the subscriptions class is now measured on the whole population.

| | Run 4 · realistic · 10-14 01:34 UTC | Run 5 · ceiling · 10-14 08:12 UTC |
|---|---|---|
| Files | `out/k6-aws-surge-realistic-20261014T025023Z.*` | `out/k6-aws-surge-ceiling-20261014T092820Z.*` |
| Peak VUs | 315 | 427 |
| Execution | PASS · step overhead p95 354 ms, p99 389 ms · 99 steps | PASS · p95 405 ms, p99 477 ms · 201 steps |
| Proposals | PASS · submit p95 171 ms · 190 + 91 resubmissions · 0 dropped | PASS · submit p95 250 ms · 402 + 160 resubmissions · 0 dropped |
| Regular | PASS | PASS |
| Subscriptions | PASS · 751 sockets · event latency p95 100 ms, round trip 14 ms · **0 failed connects** · 0 lost · 0 reconnects | PASS · 1502 sockets · 151 ms, 21 ms · **0 failed connects** · 0 lost · 0 reconnects |
| Errors | PASS · checks 100 % | PASS · checks 100 % |
| Postgres CPU | median 343 %, max 628 % | median 368 %, max 712 % |
| odb CPU · memory | median 241 % · 6.4 → 11.15 GiB | median 328 % · 6.2 → 11.4 GiB |

Against runs 2 and 3, the full subscriber population costs some latency but stays well
inside every budget. Event latency p95 rose from 74 to 100 ms (realistic) and from 81 to
151 ms (ceiling). Ceiling step overhead p95 went from 354 to 405 ms. odb CPU went from
214 % to 328 % median on the ceiling tier.

**odb memory settles the watch item, mostly.** The odb jumps from about 6.3 to 10.7 GiB in the
first five minutes, which is the JVM heap sizing up under load. It then creeps about
0.5 GiB over the remaining 70 minutes (10.66 → 11.15 GiB realistic, 10.69 → 11.40 GiB
ceiling) and does not hand memory back when the load stops, as a JVM in a container usually
does not. That is not the shape of a leak at this length, and it is 4+ GiB under the
15.7 GiB cap. A run several hours long would be the way to rule out a slow leak.

**New watch item: Postgres CPU climbs through the steady state.** It does not hold flat
over the 60-minute plateau: realistic goes about 190 % → 520 %, ceiling about 200 % → 360–660 %
in its last 25 minutes, while the offered load stays constant. The likely cause is the
tables growing under the run (every surge creates observations, proposals and steps from an
empty database), with some query whose cost scales with them. It fits inside the budgets
today. A longer plateau, or a run on a seeded database, would show whether it keeps
climbing, and `out/pg-activity-surge-aws-<stamp>.txt` is the place to start looking.

An attempt between the two (`out/aws-run-20261014T074735Z.log`) failed before the surge:
the generator stopped answering ssh over SSM, and k6 never started. Its teardown then
refused to stop the target, because its tag lookup read both tags empty. That was a failed
lookup in the same outage, not changed tags: the next run reused the same pair, and both
instances are stopped now with `gpp-tests:loadtest=1` and their names intact.

**What remains:** "one full real run per tier" is done, and every class passes on both. The
open part is the on-demand workflow running those runs from CI, which waits on IT's OIDC role
(016).

**Parked:** pre-seeding proposals during the ramp so the steady state is mostly
retract/edit/resubmit churn (017's `RESUBMIT_SHARE` is 0.3 of later submissions); churn in
the Explore population (the standalone subscribers profile keeps it); candidate image
digests as a dispatch input, once runs fire before an odb promotion.
