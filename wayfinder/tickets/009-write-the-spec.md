---
id: 009
title: "Write the testing-system spec"
labels: [wayfinder:task]
status: closed
assignee: carlos.quiroz
blocked-by: [003, 004, 005, 006, 007, 008]
---

## Question

Assemble the destination artifact: one spec document consolidating every decision on
this map into an implementable design — architecture, tooling (Playwright, k6),
environments (ephemeral regression stack, Heroku load target), the v1 scenario set,
CI workflows, Grafana Cloud integration, and the rollout phases (v1 scheduled runs →
phase 2 per-PR dispatch). Resolving this ticket ends the map.

## Resolution

The spec is written: [gpp-testing-system-spec.md](../../gpp-testing-system-spec.md)
(also published as a private artifact:
https://claude.ai/code/artifact/11523428-fa5b-445f-a377-b2b75c39b29f).

It consolidates every closed decision ticket into thirteen sections — purpose, tooling,
the ephemeral regression stack, the zero-credential guest auth strategy, the v1
scenarios, the load model, Grafana observability, CI workflows, the secrets inventory,
the three asks of the lucuma repos, five rollout milestones (M1 local stack → M5
thresholds armed), future work carried over from the map's fog, and out-of-scope
boundaries. Each section links back to the ticket holding its rationale and the
research file holding its evidence. Resolving this ticket ends the map: no open
tickets remain, and the way to implementation is clear.
