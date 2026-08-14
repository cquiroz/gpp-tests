---
id: 007
title: "Design the Grafana dashboards and trace correlation"
labels: [wayfinder:grilling]
status: open
assignee:
blocked-by: [001]
---

## Question

Design the Grafana Cloud integration: what the test-results dashboard shows (pass rate
over time, per-scenario latency trends, k6 load results), how a test run is identified
end-to-end in Tempo (run-id tagging / trace baggage so a test-triggered request is
findable among production traffic), retention expectations, and whether alerts fire
when a regression or SLO threshold trips.
