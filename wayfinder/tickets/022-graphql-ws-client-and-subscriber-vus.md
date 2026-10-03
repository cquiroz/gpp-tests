---
id: 022
title: "graphql-transport-ws client for k6 and the subscriber VUs"
labels: [wayfinder:task]
status: closed
assignee: claude
blocked-by: []
---

## Question

Websockets are in v1 (ticket 020, "crucial"). Write a `graphql-transport-ws` client on
k6's stable `k6/websockets` module — `connection_init` with the `Authorization` payload,
`subscribe`/`next`/`complete`, server `ping`→`pong`, reconnect with backoff — usable both
for long-lived subscriptions and for one-shot queries over the socket (Observe's
transport, ticket 021).

Then the two **subscriber VU** shapes: **Explore-tab** (PI identity from the pool, 017;
the subscriptions one open program produces, ~8, plus the sequence tile's when an
observation is selected) and **Observe-browser** (staff identity; observationEdit,
datasetEdit, executionEventAdded for one loaded observation). Measure the same-VU round
trip from a mutation's acknowledgement to the matching event on the VU's own
subscription, and socket health (drops, reconnects, unanswered pings). Cross-VU fan-out
lag is out of scope — record what correlation channel it would need. Developable against
the local compose stack. Resolution records the client's API and the first measured
round trip.

## Findings

**k6's own module is enough.** k6 v2's stable `k6/websockets` negotiates the
`graphql-transport-ws` subprotocol with the odb, a `connection_init` carrying the JWT is
acknowledged, and the odb answers client `ping` with `pong`. The protocol is five message types
plus ping, so a thin client was less work than an xk6 extension would have cost in build
plumbing (Nix flake, the generator's release binary, `setup-k6`), and no extension speaks the
protocol anyway. The older `k6/ws` blocks the VU inside its callback and was never an option.

**A k6 iteration ends only when the event loop is empty.** An open socket keeps it alive, so
a VU that holds a connection across iterations never gets a second one: the first attempt at
execution over the socket ran one step per VU and then hung until the graceful stop. The fix is
structural: a session (subscriber) closes its socket before returning, and the execution VU
runs its whole life inside one iteration and closes at the end.

**What the clients hold**, read from gemini-hlsw/lucuma-apps main on 2026-10-03:

| Client | Subscription (our name) | odb field | Source |
|---|---|---|---|
| Explore tab, per program | ProgramEditDetails | `programEdit` | `ProgramCacheController.programEditsSubscription` |
| | ProgramEditAttachments | `programEdit` (attachments) | `programAttachmentsDeltaSubscription` |
| | ProgramEditInfo | `programEdit` (program list) | `programDeltaSubscription` |
| | ProgramObservationsDelta | `observationEdit` by program | `programObservationsDeltaSubscription`, the measured one |
| | ProgramTargetsDelta | `targetEdit` by program | `programTargetsDeltaSubscription` |
| | ProgramGroupsDelta | `groupEdit` by program | `programGroupsDeltaEdits` |
| | ProgramConfigurationRequestsDelta | `configurationRequestEdit` | `programConfigurationRequestsDeltaSubscription` |
| | ObscalcUpdates | `obscalcUpdate` by program | `obsCalcSubscription` |
| Observe browser, per observation | ObservationEdits | `observationEdit` by observation | `observe/queries/ObsQueriesGQL.scala`, the measured one |
| | DatasetEdits | `datasetEdit` by observation | same, and Explore's sequence tile |
| | StepEventsAdded | `executionEventAdded` (STEP) | Explore's sequence tile |

Selections follow Explore's subqueries, trimmed where they would dwarf the event.

## Resolution

**Closed 2026-10-03 — built and green locally; the AWS numbers come with the next unattended run.**

- **Client** (`k6/lib/graphql-ws.js`, `GraphqlWsClient`): `connect()` opens the socket and
  awaits `connection_ack`; `subscribe(operation, onNext)` returns a handle with `complete()`
  and survives reconnects (re-sent with a new id); `query(operation)` is a one-shot over the
  socket judged and measured exactly like `gql`, same check, same error counter, same
  read/write trend by operation; server pings get pongs, our own ping every 15 s records
  `odb_ws_ping` or `odb_ws_unanswered_pings`; a drop reconnects with capped backoff and counts
  `odb_ws_reconnects`; `close()` completes everything, `drop()` leaves like a shut laptop.
- **Subscribers** (`k6/lib/subscribers.js`, `k6/subscribers.js`, `npm run k6:subscribers`):
  the **Explore tab** (TEST_PI, eight subscriptions on a program it created) and the **Observe
  browser** (TEST_STAFF, three on an observation). A session connects, edits a subtitle over
  HTTP on a cadence and waits for the matching event on its own subscription, holds, and
  leaves cleanly or by dropping. Steady population on `constant-vus` (`SUBSCRIBERS`, three
  tabs per browser), churn on `ramping-vus` with 1–3 minute sessions, half of them drops.
  Metrics: `odb_ws_round_trip` (from the HTTP acknowledgement, zero when the event wins),
  `odb_ws_event_latency` (from the send), `odb_ws_ping`, connections, reconnects, unanswered
  pings, lost events, messages by type. Catalog entries `explore-tab` and `observe-browser`.
- **Execution over the socket**: each `ObserveInstance` owns a `GraphqlWsClient` and reads the
  execution config through it (`EXECUTION_CONFIG_TRANSPORT=http` is the fallback); the
  ExecutionConfig blocking point is timed the same way. The regression suite runs one
  Observe-browser session (two round trips) after its execution step.
- **First measured round trip** (local stack, amd64 emulation, odb at its 2 GiB limit, so
  shape not numbers): 20 steady + 5 churning subscribers for 3 minutes, 47 sockets, 0
  reconnects, 0 unanswered pings. Ping med 4 ms, p95 10 ms. Round trip from the HTTP ack: med
  4 ms, p95 47 ms (Explore tab p95 74 ms, Observe browser p95 9 ms). Event latency from the
  send: med 98 ms, p95 1.0 s, with 4 events lost to the 10 s timeout and one HTTP edit timing
  out while the odb sat at 1.97 GiB of 2 GiB. Execution with socket reads, 2 instances at 3–5 s
  per step for 100 s: 45 steps, 0 errors, config read p95 252 ms, step overhead p95 959 ms.
  Regression suite: 97/97 checks, 9/9 scenarios.
- **Provisional subscription SLO** for ticket 023: event latency from send p95 < 1 s, round
  trip from ack p95 < 500 ms, zero unanswered pings, reconnects explained. Replace with the
  AWS figures after the next `loadtest/aws-run.sh`.
- **Cross-VU fan-out**, still out of scope, now has a design: every edit already stamps the
  subtitle with the VU id and a timestamp, and all VUs share one k6 clock, so a collector VU
  subscribing to `observationEdit` across the subscriber programs could time any other VU's
  edit from the stamp in the payload. No external store needed; a follow-up ticket.
- **Not done:** the wizard has no subscribers stage yet (noted in ticket 016); run it by hand
  on the generator or add a stage when the surge profile (018) composes the three populations.
