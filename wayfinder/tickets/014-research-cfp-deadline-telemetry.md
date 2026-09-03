---
id: 014
title: "Research: CfP-deadline production telemetry"
labels: [wayfinder:research]
status: closed
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

## Resolution

Closed as answered-as-far-as-reality-allows: there is no telemetry to mine (no real
standard CfP has ever run on GPP; XT1 drew 10 proposals and its data aged out of
free-tier retention). The capture plan for the next real call (H0-H4 PromQL/TraceQL
queries) lives in [the research file](../../research/cfp-deadline-telemetry.md) and is
tracked by the map's "post-deadline calibration" fog item.

## Findings so far

Written up in [research/cfp-deadline-telemetry.md](../../research/cfp-deadline-telemetry.md). The historical
question is effectively settled from public sources: GPP has never served a real standard CfP (PIT still runs
them through 2026B; first GPP standard call is earliest 2027B per NOIRLab sci26030). The only GPP call ever,
XT1 (deadline 2025-08-22 23:59 UT), drew **10 proposals**, and its telemetry has aged out of the free-tier
retention (14d metrics / ~30d traces). Assumption test from public stats: a full semester is ~417 proposals
across 4 staggered country deadlines, so **500/1h is a safe stress ceiling but ~5–10× any realistic final-hour
rate** (realistic peak ≈ 100 submission mutations/h; suggested for 015: pass criteria at ~100/h, stress at 500/h).
**Converts to HITL**: no query-side Grafana credential exists on this machine, so a human with stack access should
run the ready-made checks in the research file — H0 (tier/retention, 2 min), H1 (do `lucuma-odb` prod series
exist), and the H2/H3 PromQL+TraceQL capture plan for the next GPP call. 015 need not block on the HITL portion.
