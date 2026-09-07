---
id: 024
title: "Telemetry for the surge: Grafana stack decision (HITL) and the collector on the target"
labels: [wayfinder:task, wayfinder:hitl]
status: open
assignee:
blocked-by: []
---

## Question

Two halves. **HITL:** the shared Grafana Cloud stack is free-tier and its series budget
is production's; ticket 020 prefers a **separate paid Grafana Cloud stack** for load
telemetry but the budget is unknown — find the owner, get a yes/no, record it. If no,
the fallback is self-hosted Prometheus + Tempo + Grafana on the AWS box with dashboards
exported into the run artifacts.

**Build:** Grafana Alloy on the AWS target box receiving the odb's OTLP traces and
metrics, scraping `postgres_exporter` and container metrics, forwarding to whichever
destination won; k6 remote-writes to the same place. Note the ticket 019 dependency:
until odb spans carry the operation name, per-operation server-side attribution comes
from k6 tags only. Resolution records the destination, credentials' home, and the
dashboard that pairs k6 latency with JVM/Postgres panels for one run.
