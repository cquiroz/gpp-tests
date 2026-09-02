---
id: 014
title: "Research: CfP-deadline production telemetry"
labels: [wayfinder:research]
status: open
assignee: carlos.quiroz
blocked-by: []
---

## Question

What does end-of-CfP traffic actually look like? Mine the org's Grafana Cloud (prod
odb metrics/traces) around a past Call-for-Proposals close: request mix (which
operations dominate), peak concurrency, proposal-submission rate over the final
hours, error/latency behavior. Test the working assumption of **up to 500 proposals
in the final hour**. Deliverable: `research/cfp-deadline-telemetry.md` feeding the
surge workload model (015). If Grafana access isn't available to the agent, record
the exact queries a human should run instead — the ticket then converts to HITL.
