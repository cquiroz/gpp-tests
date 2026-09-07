# Ask for the odb team: put the GraphQL operation name on odb spans

*Written 2026-09-07 for ticket 019 in `wayfinder/`. Carry this to `gemini-hlsw/lucuma-odb`
as an issue or a PR conversation; nothing here depends on odbattr.*

## The ask, in one sentence

Add the semconv attributes **`graphql.operation.name`** and **`graphql.operation.type`**
to the server span the odb opens for every GraphQL execution (the one currently named
`graphql-query` / `graphql-subscription`, regardless of transport), so a trace can be
grouped by operation.

## Why

Two consumers, both blocked today:

1. **The next real Call for Proposals.** The surge load model (odbattr ticket 015/020)
   is built on assumptions — realistic peak ≈ 100–250 submission mutations per hour,
   500/h as a stress ceiling — because no real standard CfP has run on GPP yet (the first
   is 2027B at the earliest). The capture plan for that deadline
   (`cfp-deadline-telemetry.md`, queries H3/H4) wants "request mix by operation over the
   final hours". With the attribute it is one TraceQL query:

   ```
   { resource.service.name = "lucuma-odb" && span.graphql.operation.name = "SetProposalStatus" }
   | rate() by (span.graphql.operation.name)
   ```

   Without it, submission rate has to be reconstructed after the fact from the database.

2. **The load target.** Surge runs will ship odb traces to a Grafana stack next to the
   k6 metrics. k6 tags every request client-side by operation, so the *verdict* is fine,
   but the server-side *why* — which operation's SQL grew, which held the per-socket
   queue — needs the same key on the server span. Today the only distinguishing
   attribute is `graphql.slow_query = true`.

## Where (as far as could be read from here)

`cfp-deadline-telemetry.md` §2 located the span in the GraphQL routes middleware
(`GraphQLRoutes.scala` in lucuma-odb), which already has the parsed request in hand when
it names the span. The operation name and type are available at that point; adding them
is a one-line attribute set per span. The local `lucuma-odb` checkout on the machine
this was written on is hollow, so line numbers are not cited — please verify.

## Shape

- **`graphql.operation.name`**: the client-supplied operation name, or the literal
  `anonymous` when absent. Low cardinality by construction: the set is the union of the
  named documents Explore, Observe, Navigate and the tests ship (dozens, not thousands).
- **`graphql.operation.type`**: `query` | `mutation` | `subscription`.
- **Not asked for:** `graphql.document` (the full query text) or variables — high
  cardinality, and variables can carry user data. If the team wants the document, keep it
  behind the existing slow-query flag only.
- Same attributes on the subscription span, and on each subscription *event* span if
  there is one, so websocket traffic — most of Explore's — is attributable too.

## Acceptance

On a dev deployment, open Explore, edit one observation, then in Tempo:

```
{ resource.service.name = "lucuma-odb" } | select(span.graphql.operation.name)
```

shows operation names on the spans instead of nothing. That is the whole check.

## Timing

Before the next GPP-run call closes — every call is a capture opportunity and the
free-tier retention is short, so the attribute has to be live *before* the deadline, not
added after.
