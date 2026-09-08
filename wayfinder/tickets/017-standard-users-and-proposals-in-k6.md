---
id: 017
title: "Standard-user pool and the proposal loop in k6"
labels: [wayfinder:task]
status: open
assignee:
blocked-by: [028]
---

## Question

*Reshaped by ticket 020; no longer blocked on the migration — it lands on the `surge`
branch here.* Surge traffic is proposal traffic, and guests can't touch proposals. Build
the **standard-user pool**: per-run fabricated PIs (about 250, one per VU) and a handful
of staff users via the existing SSO insert script, tokens through the SSO API, a k6 auth
helper alongside the guest one. Then the **proposal loop**: one CfP seeded with a
far-future deadline; each PI creates a program and proposal, edits, **uploads a Science and
a Team attachment** (the odb refuses to submit without them since 2026-09-07 — two REST
uploads per proposal, through the odb's attachment endpoint into the stack's object store,
ticket 028), submits, and churns through retract/resubmit — driven by an **arrival-rate
executor** so the tier's submissions-per-hour figure (realistic 100–250, ceiling 500) is
literal. Upload size and count per submission become part of the workload model. Proposal
scenarios enter the scenario-parity catalog alongside the existing e2e proposal specs.
Developable against the local compose stack.
