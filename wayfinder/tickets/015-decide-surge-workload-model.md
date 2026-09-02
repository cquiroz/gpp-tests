---
id: 015
title: "Decide the surge workload model"
labels: [wayfinder:grilling]
status: open
assignee:
blocked-by: [014]
---

## Question

Shape the surge run. Given the deadline telemetry (014) or explicit assumptions where
it's thin: how many VUs and of what kind (PIs editing/submitting proposals vs
background regular ops), the operation mix, ramp/hold/duration shaped like a deadline
(final-hour crescendo?), the 500-proposals-in-1h anchor expressed as arrival rate,
and — the claim's teeth — **pass criteria for "regular operations remain usable"**
(latency/error thresholds on the regular-ops mix measured *during* the surge).
