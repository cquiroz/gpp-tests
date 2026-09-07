---
id: 021
title: "Observe execution VUs and the executable-observation seed"
labels: [wayfinder:task]
status: open
assignee:
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
