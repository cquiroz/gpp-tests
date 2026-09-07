---
id: 020
title: "Decide where stress testing lives and what the surge run claims"
labels: [wayfinder:grilling]
status: closed
assignee: carlos.quiroz
blocked-by: []
---

## Question

Stress testing is now the highest priority: expand the scenarios and find out whether
the odb handles the expected load without degrading time-critical operations. Should
the stress-testing part be split into its own repository, or moved inside the odb
codebase? Both were rejected earlier (map constraint "one repo, not three"; ticket 010
"test code stays canonical here") — what has changed, and what exactly must the surge
run prove?

## Resolution

Grilled 2026-09-06/07. Glossary additions in `CONTEXT.md`: **Observe**, **standard-user
pool**, **execution VU**, **subscriber VU**, **realistic tier**, **ceiling tier**, **step
ODB overhead**, **surge SLO**, **surge verdict**; **surge run**, **load target**, **guest
VU** and **gpp-tests** revised.

### Placement: no split, no move — reaffirmed with a new priority

- Nothing in the answers overturns the earlier decisions: authorship stays with the
  observatory plus odb developers contributing in PRs (not odb developers owning it);
  runs fire on demand and before releases, never per merge; `lucuma-odb` gets a dispatch
  step at most, "maybe eventually" a `load/` directory of the same k6 code — never a
  rewrite in the odb's toolchain.
- The stated motive — "give priority to stress testing and expose less code" — is met
  inside one repo: the load suite becomes the repo's front door (README leads with it,
  `k6/` plus the operations library are the only surface odb developers touch), e2e keeps
  its own folder and workflow. Public visibility is not a concern; all the team's code is
  public.
- The ticket 010 dev-process items (Explore per-merge lane, Slack alerts, promote gate)
  wait behind the stress work.
- Working branch: `surge` in odbattr, mirrored to `cquiroz/gpp-tests` for CI; ticket 012
  later migrates main plus surge to `gemini-hlsw/gpp-tests` in one move.

### The surge claim

*Under end-of-CfP load, the odb keeps observation execution from Observe within its
stall budget, proposal submission usable, and regular operations within spec.* Two
tiers, both 75 minutes (10 ramp, 60 steady, 5 drain):

| Layer | Realistic | Ceiling |
|---|---|---|
| Proposal submissions (arrival-rate executor, PI identities) | 100–250 / h | 500 / h |
| Explore-tab subscribers (PI identities, 8–12 subscriptions each) | 100–200 | 100–200 |
| Observe server instances (execution VUs, service JWT) | 2 | 4 (2 + 2 engineering) |
| Observe-browser subscribers (staff identities) | 2 | 4 |
| Regular-operations guest mix | as the trend run | as the trend run |

Proposal loop per PI: create program and proposal, edit, submit, retract/resubmit churn,
against one CfP seeded with a far-future deadline. Regular ops on ramping VUs, Observe on
constant VUs, submissions on arrival rate so "500 per hour" is a literal claim.

### Observe model (verified against `gemini-hlsw/lucuma-apps` main, 2026-08-24)

- Events are per-event mutations sent concurrently in the background — **not** the
  `addEventBatch` path (the ADR for batching exists but was superseded). Still blocking:
  `recordVisit`, `recordDataset`, the first step event's acknowledgement before any
  dataset event, the flush at step end awaiting every outstanding ack, and the
  execution-config refetch per step. Mutations over HTTP, queries over the websocket; the
  odb serializes operations per socket, so the transport split is modelled faithfully.
- Cadence is a parameter: realistic default one step per 60–120 s per instance; a
  compressed variant (5–10 s) probes the execution path.
- Executable observations are seeded via GraphQL as the service role at run start (fresh
  database rule holds). Guest self-seeding cannot produce them.
- **Stall budget (provisional until Observe developers see real numbers):** step ODB
  overhead p95 < 2 s, p99 < 5 s; per-mutation p95 < 500 ms, p99 < 2 s; execution-config
  fetch p95 < 3 s; zero timeouts (Observe's is 20 s, with idempotent retry).

### Websockets — in v1, "crucial"

- A `graphql-transport-ws` client on k6's stable `k6/websockets` module (global event loop:
  one VU holds the socket while issuing HTTP). Auth in the `connection_init` payload.
- Explore-tab shape (the subscriptions one open program produces) and Observe-browser
  shape (observationEdit, datasetEdit, executionEventAdded per loaded observation).
- Measured: same-VU round trip from a mutation's ack to the matching event on that VU's
  subscription, plus socket health (drops, reconnects, unanswered pings). Cross-VU fan-out
  lag is a recorded follow-up — it needs a correlation channel k6 does not have.

### Surge SLOs and verdict

- Absolute, per class, in one file: execution as above; proposal submit p95 < 2 s;
  regular reads p95 < 2 s, writes p95 < 5 s; error rate < 1 %. Ledger-derived thresholds
  remain the trend run's.
- Verdict: GitHub job summary with one table per class, the k6 summary artifact, Grafana
  annotations. Slack later, per ticket 010.

### Target, telemetry, triggers

- Iterate on the AWS compose target (the only proven 200-VU environment) with the k6
  generator on AWS, driven from a GitHub workflow; the nine-stage manual wizard becomes a
  scripted boot. Read production sizing now (ticket 013's commands); provision a
  production-shaped Heroku target only once the profile is stable, for the capacity claim.
- Server-side "why": Grafana Alloy on the target collects odb OTLP, Postgres and container
  metrics. Preferred destination is a **separate paid Grafana Cloud stack** (budget
  unknown — HITL); fallback is self-hosted Prometheus/Tempo/Grafana on the box with
  dashboards exported per run. The shared free stack's series budget is production's.
- Release confidence: manual `workflow_dispatch` with candidate image digests before
  promoting the odb; hooking the fleet promote script comes after a few clean firings.
- Ticket 019 (operation name on odb spans) becomes a written ask Carlos carries to the
  odb team, not an issue filed from here.

### Order of work

Developed against the local compose stack: Observe execution ops and seed (021),
websocket client and subscriber VUs (022), standard users and the proposal loop (017),
surge profile with SLO file and verdict (018, 023). AWS boot automation (016) runs as a
parallel track; full-scale runs start when the tracks meet.

### Out of scope, still

Absolute-capacity hunting (a knee run is not a standing profile), load-testing SSO,
cross-VU fan-out lag, a Scala/Gatling rewrite.
