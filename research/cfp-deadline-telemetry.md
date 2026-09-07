# CfP-deadline production telemetry: what exists, what doesn't, and the handoff queries

**Summary.** There is **no production CfP-deadline telemetry to mine, and there may never have been any that survives today**. Two independent reasons: (1) GPP has never run a real standard-semester Call for Proposals — every standard and Fast-Turnaround call through 2026B still uses the legacy Phase I Tool (PIT), whose submissions never touch the GPP/lucuma ODB; the *only* GPP-run call ever was the **XT1 Early Science Call** (2025-08-04 → deadline **2025-08-22 23:59 UT**), which received **10 proposals** in 18 days. (2) Even that window is unrecoverable: the org's Grafana Cloud stack is on the free tier (14-day metrics retention, per [grafana/README.md](../grafana/README.md) and ticket 007), so XT1 telemetry — 12.4 months old — expired long ago. This machine also holds no query-side Grafana credentials (only write-side OTLP vars, and those are empty locally; real secrets live in GitHub Actions), so nothing could be queried from here regardless. The deliverable therefore splits into: an **assessment of the 500-proposals/1h assumption from public proposal statistics** (verdict: a safe stress *ceiling* — it exceeds an entire semester's total volume — but ~5–10× any realistic final-hour rate), and the **exact PromQL/TraceQL a human with stack access should run**, both as a 10-minute verification now and as a capture plan for the next GPP call (the first GPP standard CfP is earliest **2027B**; GPP deployment was rescheduled to 2027 and explicitly will *not* run the 2027A call).

**Research date:** 2026-09-02. Sources: local repo (`grafana/README.md`, `.envrc`, `.github/workflows/*.yml`, spec §7, ticket 007), `gemini-hlsw/lucuma-odb` `main` via GitHub API (`OtelSetup.scala`, `OdbTelemetry.scala`, `ServerMiddleware.scala`, `GraphQLRoutes.scala`, `Main.scala`), and public Gemini/NOIRLab pages (linked inline).

---

## 1. Access check: what this machine can and cannot reach

| Credential | Present locally? | Grants |
|---|---|---|
| `GRAFANA_OTLP_ENDPOINT` / `GRAFANA_OTLP_TOKEN` | declared in `.envrc` but **empty** | write-only OTLP push (would not allow queries anyway) |
| `ODB_OTEL_ENDPOINT` / `ODB_OTEL_KEY` | declared but **empty** | write-only: makes an ephemeral ODB ship traces to Tempo |
| `GRAFANA_URL` / `GRAFANA_ANNOTATIONS_TOKEN` | **comments only** in `.envrc`; real values are GitHub Actions secrets | annotations + (with Editor role) datasource listing |
| `GC_PROM_*` (remote-write) | GitHub Actions secrets only | metrics **write** |

**No query-capable (`metrics:read` / Tempo read) credential exists anywhere on this machine.** Direct telemetry mining is not possible from here — and per §2, there is nothing left to mine even with access.

## 2. Does production ODB emit telemetry the org's Grafana can see? — Yes (verified in source)

From `gemini-hlsw/lucuma-odb` `main`:

- **Config**: `ODB_OTEL_ENDPOINT`/`ODB_OTEL_KEY` are *required* when `ODB_ENVIRONMENT` is non-local ([lucuma-deployment-shapes.md](lucuma-deployment-shapes.md)) — production ships OTLP (http/protobuf, Basic auth) by construction. `grafana/README.md` states the free tier's 10k-series budget "is shared with production metrics", i.e. prod lands in the **same org stack** gpp-tests uses.
- **Resource attributes** (`modules/otel/src/main/scala/lucuma/otel/OtelSetup.scala`): `service.name` = **`lucuma-odb`** (`Main.scala` L100), `service.version` = commit hash, `deployment.environment.name` = `production`, plus `dyno.id` on Heroku.
- **Traces** (`GraphQLRoutes.scala`): every GraphQL execution gets a server span named **`graphql-query`** (or **`graphql-subscription`**), *regardless of transport* — this matters because the middleware comment notes most Explore traffic rides **websockets**, which per-request HTTP metrics never see. Slow queries (> `OdbMapping.slowQueryThreshold`) get attribute `graphql.slow_query = true`. **Gap: the span does NOT record the GraphQL operation name** — request mix by operation is not directly queryable from span names/attributes today.
- **Metrics** (`ServerMiddleware.scala`): http4s otel4s middleware (`OtelMetrics.serverMetricsOps`) → OTel semconv HTTP server metrics (`http.server.request.duration` histogram; routes classified to stable templates: `/odb`, `/attachment/{id}`, `/scheduler/atoms`, …), plus JVM `RuntimeTelemetry` and cats-effect `IORuntimeMetrics`.

## 3. Retention kills the historical question

| Window of interest | When | Metrics (14-day free tier) | Traces (~30-day Tempo free tier) |
|---|---|---|---|
| XT1 deadline (only real GPP call) | 2025-08-22 23:59 UT | expired ~2025-09-05 | expired ~2025-09-21 |
| 2026B standard CfP deadlines | 2026-03-31 → 04-03 | expired — and **irrelevant: PIT, not GPP**, took those submissions | same |

So the historical half of ticket 014 has a definitive answer: **the data does not exist anymore, and what existed (XT1) was 10 proposals — no surge**. The only caveat: if the stack were actually on a paid tier (13-month metrics retention), XT1 metrics would sit right at the edge (12.4 months). A human with portal access should spend 2 minutes confirming the tier before declaring it fully closed (§5, query H0).

## 4. Testing the 500-proposals-in-the-final-hour assumption (public evidence)

| Evidence | Number | Source |
|---|---|---|
| Entire 2026B semester, all 6 partners, valid proposals | **417** (+45 LLP, +15 Subaru exchange) | [NOIRLab sci26032](https://noirlab.edu/science/news/announcements/sci26032), 2026-07-21 |
| 2026B deadline structure | staggered per-country, **31 Mar – 3 Apr 2026** (4 distinct "final hours") | [Gemini 2026B CfP](https://www.gemini.edu/observing/phase-i/standard-semester-program/2026b-call-proposals) |
| XT1 — only GPP-run call ever | **10 proposals** in 18 days | [Gemini Operations Development](https://www.gemini.edu/observing/operations-development), [GPP XT1 page](https://www.gemini.edu/observing/phase-i-proposing-time/gpp-xt1) |
| First possible GPP standard CfP | **2027B at earliest** (deployment rescheduled to 2027; explicitly not 2027A) | [NOIRLab sci26030](https://noirlab.edu/science/news/announcements/sci26030), 2026-07-21 |

**Assessment.** 500 submissions in one hour exceeds the *total* proposal volume of a full semester across all partners. Even the degenerate worst case — every proposal of the largest cycle submitted in a single final hour at a single shared deadline — stays under 500. So:

- **As a stress ceiling, the assumption is safe and roughly "one whole cycle in one hour".** Keep it for the surge run's headroom claim.
- **As a realistic forecast it is ~5–10× too high.** With staggered country deadlines, the largest single final-hour cohort is the US-share (~half of ~420 ≈ 210 proposals); even assuming half of those land in the last 3 hours, the final-hour *first-submission* rate is **~30–80/h**. One multiplier pushes it up: the XT1 rules (and Explore) allow **submit → retract → re-submit until the deadline**, so the `setProposalStatus`-style *mutation* rate plausibly runs 2–3× the proposal rate → **~100–250 submission mutations/h realistic peak**.
- Suggested shape for ticket 015: model the **realistic peak at ~100 submissions/h** (arrival rate ~0.03/s) as the pass/fail scenario, and keep **500/h (~0.14/s)** as the stress tier. Concurrent-user anchor (assumption, no telemetry): ~420 proposals ↔ roughly 300–600 distinct PIs per cycle; a final-day concurrent-editor peak of **100–200 websocket-connected users** is the defensible upper band, dominated by *editing* traffic (queries + subscriptions), not the submit mutation itself.

## 5. Handoff: exactly what a human with Grafana access should run

Two occasions: **(H0–H1) now**, 10 minutes, to close the loop on tier/series existence; **(H2+) live during the next GPP call** (any XT2-style call, then 2027B), because on the free tier the data evaporates in 14 days — export dashboard CSV/snapshots within that window.

**H0 — tier & retention (portal, 2 min).** grafana.com → org → stack → Prometheus/Tempo tiles: confirm free vs paid, metrics retention (14d vs 13mo), Tempo retention. If paid: immediately run H2 queries over **2025-08-15 → 2025-08-23** (XT1 final week) before it ages out entirely.

**H1 — do prod series exist at all? (Explore → Prometheus)**

```promql
count by (__name__) ({job="lucuma-odb"})                # any lucuma-odb series?
group by (deployment_environment_name) (target_info{job="lucuma-odb"})
```

(OTLP gateway maps `service.name`→`job`, dots→underscores in attribute names. If nothing matches, try label `service_name` and check whether prod really points `ODB_OTEL_*` at *this* stack — that would refute the shared-stack reading of grafana/README.md.)

**H2 — request mix & load (Prometheus, over the deadline window, 5m steps).** Metric name to confirm by typing `http_server_` in Explore; semconv candidate shown:

```promql
# rate by route (the mix at HTTP level; /odb dominates by construction)
sum by (http_route) (rate(http_server_request_duration_seconds_count{job="lucuma-odb"}[5m]))
# p95 / p99 per route
histogram_quantile(0.95, sum by (le, http_route) (rate(http_server_request_duration_seconds_bucket{job="lucuma-odb"}[5m])))
# error ratio
sum(rate(http_server_request_duration_seconds_count{job="lucuma-odb", http_response_status_code=~"5.."}[5m]))
  / sum(rate(http_server_request_duration_seconds_count{job="lucuma-odb"}[5m]))
# in-flight requests (concurrency proxy — websockets show up here as long-lived)
http_server_active_requests{job="lucuma-odb"}
# saturation context: JVM + CE runtime
jvm_memory_used_bytes{job="lucuma-odb"}   /   cats_effect_... (search "cats_effect")
```

**H3 — GraphQL-level behavior (Tempo → TraceQL, same window).**

```traceql
# all prod GraphQL executions (HTTP *and* websocket)
{ resource.service.name="lucuma-odb" && resource.deployment.environment.name="production" && name="graphql-query" }
# rate + p95 (TraceQL metrics)
{ resource.service.name="lucuma-odb" && name="graphql-query" } | rate()
{ resource.service.name="lucuma-odb" && name="graphql-query" } | quantile_over_time(duration, .95)
# slow + failed executions
{ resource.service.name="lucuma-odb" && name="graphql-query" && span.graphql.slow_query=true }
{ resource.service.name="lucuma-odb" && name="graphql-query" && status=error }
# live subscription pressure
{ resource.service.name="lucuma-odb" && name="graphql-subscription" } | rate()
```

**Record:** peak 5m request rate and its timestamp; `http_server_active_requests` peak; graphql-query rate/p95/error% in the final 3 hours vs a quiet baseline day; subscription span count; any 429/5xx bursts.

**H4 — proposal-submission rate.** Not derivable from spans today (no operation-name attribute). Options, best first: (a) after the deadline, query the ODB itself for programs whose proposal status transitioned to SUBMITTED, bucketed by timestamp (service JWT; the gpp-tests `SetProposalStatus` mutation in `lib/odb-operations.js` is the same operation PIs trigger); (b) Heroku router logs (`heroku logs --app lucuma-postgres-odb-production`) during the window; (c) **file the upstream fix now** — add `graphql.operation.name` (low-cardinality, semconv-standard) to the `graphql-query` span in `GraphQLRoutes.scala`, which turns the whole "request mix" question into one TraceQL `by(span.graphql.operation.name)` next call.

## Open questions / caveats

- **Stack tier unverified** (H0). Free tier is strongly implied by grafana/README.md and ticket 007; if paid, XT1 metrics may survive a few more weeks — check immediately.
- Whether prod's `ODB_OTEL_ENDPOINT` really targets the *same* stack as gpp-tests's credentials is inferred from grafana/README.md's shared-budget remark, not verified against Heroku config (`heroku config --app lucuma-postgres-odb-production | grep OTEL` would settle it; local Heroku credential is stale — see [production-shape.md](production-shape.md)).
- Exact Prometheus metric names post-OTLP-translation (`http_server_request_duration_seconds_*` vs `_milliseconds_`, `cats_effect_*` naming) need one Explore session to pin; the queries above are semconv-derived candidates.
- The 100–200 concurrent-user band and 2–3× resubmission multiplier are **assumptions**, clearly flagged for 015; no observatory publishes intra-hour submission timestamps. The operation *mix* for the surge model should come from gpp-tests's own instrumented Explore sessions ([v1-scenario-graphql-ui-map.md](v1-scenario-graphql-ui-map.md)) rather than waiting for prod telemetry.
- An XT2-style call may appear before 2027B — watch [Gemini Science Operations Announcements](https://www.gemini.edu/taxonomy/term/2); each such call is a capture opportunity under §5.
