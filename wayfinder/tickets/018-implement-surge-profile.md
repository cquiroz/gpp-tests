---
id: 018
title: "Implement the surge profile and its on-demand workflow"
labels: [wayfinder:task]
status: open
assignee:
blocked-by: [015, 016, 017]
---

## Question

Build the surge run: the k6 profile implementing the workload model (015) against the
provisioned target (016) using the standard-user machinery (017); a `workflow_dispatch`
workflow (on-demand cadence) that releases/resets the target, runs the surge, and
publishes results with run identity + Grafana annotations like the other suites; the
pass verdict wired to the regular-ops-usability thresholds. Prove it with one full
real run. Resolution records the run link and the verdict machinery.
