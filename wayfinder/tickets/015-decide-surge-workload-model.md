---
id: 015
title: "Decide the surge workload model"
labels: [wayfinder:grilling]
status: closed
assignee: carlos.quiroz
blocked-by: [014]
---

## Question

Shape the surge run. Given the deadline telemetry (014) or explicit assumptions where
it's thin: how many VUs and of what kind (PIs editing/submitting proposals vs
background regular ops), the operation mix, ramp/hold/duration shaped like a deadline
(final-hour crescendo?), the 500-proposals-in-1h anchor expressed as arrival rate,
and — the claim's teeth — **pass criteria for "regular operations remain usable"**
(latency/error thresholds on the regular-ops mix measured *during* the surge).

## Resolution

Settled inside the 2026-09-06/07 grilling recorded in
[ticket 020](020-decide-stress-first-placement-and-surge-claim.md), which widened the
claim: the time-critical operation is **observation execution from Observe while
proposals are being accepted**, so the surge layers Observe execution VUs and websocket
subscribers over the proposal and regular-ops traffic. The full model — two tiers
(realistic 100–250 submissions/h, 2 telescopes; ceiling 500/h, 4 Observe instances),
75-minute shape, arrival-rate executor for submissions, PI/staff identity pools, and the
absolute per-class surge SLOs — is the table and sections in 020. This ticket holds no
separate content.
