---
id: 019
title: "Upstream ask: GraphQL operation name on odb spans"
labels: [wayfinder:task]
status: closed
assignee: carlos.quiroz
blocked-by: []
---

## Question

Ticket 014 verified production odb emits OTLP telemetry (`graphql-query` /
`graphql-subscription` spans, http4s metrics) but the spans carry **no GraphQL
operation name** — so "request mix by operation", the evidence the surge model wants
from the next real CfP, cannot be measured. File the ask on `gemini-hlsw/lucuma-odb`
(the research file sketches the one-line fix location) and see it through — it must
land before the next call closes or the capture plan in
`research/cfp-deadline-telemetry.md` loses its main query.

## Resolution

Per ticket 020, the deliverable is a written ask Carlos takes to the odb team rather
than an issue filed from here:
[`research/odb-ask-operation-name-on-spans.md`](../../research/odb-ask-operation-name-on-spans.md).
It matters twice now: for the next real CfP capture, and for server-side per-operation
attribution on the load target (without it, surge "why" analysis relies on k6's
client-side tags alone). Whether it lands is tracked upstream; the capture plan and
[ticket 024](024-telemetry-stack-and-collector.md) note the dependency.
