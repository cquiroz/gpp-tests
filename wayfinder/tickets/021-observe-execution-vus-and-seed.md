---
id: 021
title: "Observe execution VUs and the executable-observation seed"
labels: [wayfinder:task]
status: closed
assignee: claude
blocked-by: []
---

## Question

Build the **execution VU** (ticket 020, "Observe model"): a k6 VU impersonating one
Observe server instance with the service JWT. Faithful per-step call order from
`gemini-hlsw/lucuma-apps` main (2026-08-24): `recordVisit` then `addSequenceEvent(START)`
once; per step `addStepEvent(START_STEP)` acknowledged before anything else, the
configure/observe step events and the six dataset events sent **concurrently** (k6
`http.batch`), `recordDataset` synchronous, the step-end flush awaiting every ack, and
the `executionConfig` refetch **over the websocket** because the odb serializes per
socket. Cadence is a parameter (realistic 60–120 s per step, compressed 5–10 s).

Emit the **step ODB overhead** metric (sum of the blocking points) and per-mutation
metrics tagged by operation, feeding the surge SLOs (023). Add the execution operations
to `lib/odb-operations.js` (none exist today) and to the parity catalog as k6-only with
a reason.

Seed: as the service role at run start, create programs with GMOS observations that the
odb will serve an execution config for — targets, observing mode, whatever state
transitions the odb requires — and verify a config is returned before the run starts.
Developable against the local compose stack. Resolution records the operation list,
the seed recipe, and the first local step trace.

## Findings

**Observe's call order was re-verified against lucuma-apps main on 2026-10-02** (commit
`ecab7cc`), because the local Observe checkout (HEAD 2026-08-19) still sends every event
sequentially and awaited. Main does not: `OdbCommandsImpl` hands every event to
`OdbEventSender`, which sends them concurrently in the background, and the sequence blocks on
the ODB at exactly five points — `recordVisit`; the first step event's acknowledgement before
`recordDataset` (the ODB refuses a dataset for a step it has no record of); `recordDataset`
itself; the flush of every outstanding event at END_STEP (and at ABORT/STOP/PAUSE); and the
execution-config read after each step, over the websocket. Mutations go over HTTP with a
per-mutation UUID idempotency key, also sent as the `Idempotency-Key` header so http4s may
retry. The sequence commands are START once per visit, CONTINUE when the next step loads,
PAUSE when the acquisition atom completes. Observe records no atoms and no steps: their ids
come from `executionConfig(observationId, futureLimit: 100)`, read at load, at Start and after
every step. There is no "visit end" call.

**The seed needs no state machine.** As the service user, a program with a GMOS long-slit
observation (the observing-modes fixture, optical target) gets an execution config from the
first `executionConfig` read that finds the ITC done — ~6 s locally — while the workflow state
is still `UNDEFINED`. The acquisition sequence hands out 3 steps (1 s, 20 s, 3 s), the science
sequence 3 atoms of GCAL 120 s + GCAL 16 s + SCIENCE 930 s. Recording a step's events advances
`nextAtom` on the next read, so the executed sequence is driven by the ODB, as for Observe.

## Resolution

**Closed 2026-10-03 — built and green locally; first real numbers wait for the AWS target.**

- **Operations** (`lib/odb-operations.js`, schema-validated, replayed by
  `tools/verify-operations.js` under the service JWT): `RecordVisit`, `AddSequenceEvent`,
  `AddStepEvent` (6 stages), `RecordDataset`, `AddDatasetEvent` (6 stages), `ExecutionConfig`
  (both GMOS branches, Observe's step fields). Catalog entry `execution`, k6-only.
- **Execution VU** (`k6/lib/execution.js`, `ObserveInstance`): async, like the sender it
  mirrors — `gqlAsync` in `k6/lib/graphql.js` posts in the background with the idempotency
  header, a 20 s timeout and one idempotent retry, and the step awaits only at the five
  blocking points. Per step: START + 6 step events + `recordDataset` + 6 dataset events +
  CONTINUE, one execution-config read; the acquisition atom once, then science until the
  sequence runs out. Cadence `STEP_SECONDS_MIN/MAX` (default 60–120), 20 % configuring, 80 %
  exposing. Odd VUs are GMOS-N, even GMOS-S, with site-correct dataset filenames.
- **Metrics** (`k6/lib/metrics.js`): `odb_step_overhead` (sum of the blocking points, the
  stall metric), `odb_step_wait{operation: RecordVisit|StepRecorded|RecordDataset|Flush|
  ExecutionConfig}`, `gpp_execution_steps`; per-mutation latency in the existing
  read/write trends tagged by operation. Label budget unchanged.
- **Seed** (`seedExecutableObservations`): one program, N GMOS long-slit observations, each
  polled with `executionConfig(futureLimit: 0)` until a config comes back (180 s budget),
  unmeasured. `k6/execution.js` runs N instances on `constant-vus`, re-seeding when an instance
  runs out; `k6/regression.js` executes one step per nightly run as a smoke; `npm run
  k6:execution`.
- **First local step trace** (2026-10-03, 2 GiB odb under amd64 emulation on an M-series Mac,
  so timings are shape, not numbers): recordVisit 844 ms; START 108; START_STEP 100;
  START_CONFIGURE 109; END_CONFIGURE 106; START_OBSERVE 111; recordDataset 118; the six
  dataset events 72–123 each; END_OBSERVE 76; END_STEP 74; executionConfig 294 ms (6.1 s the
  first time, generating the sequence); CONTINUE 99. Runs: 2 instances at 3–5 s per step,
  75 s: 23 steps, 359/359 checks, 0 errors. Regression suite with the smoke: 92/92 checks,
  8/8 scenarios.
- **Deviations from the plan, deliberate:** events are concurrent via `http.asyncRequest`
  rather than `http.batch`, because a batch is a barrier and Observe has none between events;
  the execution-config read goes over HTTP until [ticket 022](022-graphql-ws-client-and-subscriber-vus.md)
  supplies the websocket client (same wait measured, transport swapped there); Observe's
  `resetAcquisition` at load is not sent (the seed is fresh).
- **Watch item, carried to the map:** the odb's resident memory climbed steadily from
  1.2 GiB to its 2 GiB limit over ~3 minutes of this traffic (2 instances, 3–5 s steps) and was
  OOM-killed, twice. Local emulation inflates memory, and the AWS target gives the odb 40 % of
  64 GiB, so the first AWS execution run must sample the odb's memory over its length. If it
  climbs there too, that is a finding for the odb team before any surge run.
