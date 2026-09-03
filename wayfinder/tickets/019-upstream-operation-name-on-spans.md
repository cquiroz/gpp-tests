---
id: 019
title: "Upstream ask: GraphQL operation name on odb spans"
labels: [wayfinder:task]
status: open
assignee:
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
