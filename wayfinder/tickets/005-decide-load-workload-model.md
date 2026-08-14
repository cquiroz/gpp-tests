---
id: 005
title: "Decide the load-test workload model and target"
labels: [wayfinder:grilling]
status: open
assignee:
blocked-by: [004]
---

## Question

Define the nightly performance set: the workload mix (read/write ratio across the v1
scenarios), the virtual-user ramp profile and target concurrency ("a few hundred"),
run duration, and the pass/fail thresholds (latency and error-rate SLOs). And the
target: which Heroku-deployed environment the load points at, whether hammering it is
safe (shared with humans? dyno limits?), and how data created by load runs is cleaned
up afterwards.
