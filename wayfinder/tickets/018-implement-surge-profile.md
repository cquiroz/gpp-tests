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

**Parked:** pre-seeding proposals during the ramp so the steady state is mostly
retract/edit/resubmit churn (017's `RESUBMIT_SHARE` is 0.3 of later submissions); churn in
the Explore population (the standalone subscribers profile keeps it); candidate image
digests as a dispatch input, once runs fire before an odb promotion.
