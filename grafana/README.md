# Grafana Cloud setup

Everything lands in the org's existing Grafana Cloud stack (spec §7). Nothing here needs the
paid Grafana Cloud k6 product.

## Dashboards

1. **GPP test results** — `gpp-test-results.json` in this directory. Dashboards → New →
   Import → *Upload JSON file*, then pick the stack's Prometheus data source. It shows nightly
   read/write p95 per operation, the error trend, regression pass/fail history, scenario
   durations, and GraphQL errors, with the run annotations overlaid.
2. **k6 Prometheus** — official dashboard ID **19665**, for the internals of a single run.
   Import by ID.
3. **k6 Prometheus (Native Histograms)** — official dashboard ID **18030**. Only useful if
   this tenant ingests native histograms *and* the load run sets
   `K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM=true`; 19665 is the safe default.

### Metric names to check on the first armed run

The remote-write output prefixes everything with `k6_` and derives trend series from
`K6_PROMETHEUS_RW_TREND_STATS` (the performance workflow sets `avg,p(95),p(99)`), so
`odb_read_duration` arrives as `k6_odb_read_duration_p95`. Counter and Rate suffixes
(`_total`, `_rate`) follow Prometheus conventions but have changed across k6 versions — after
the first run that pushes metrics, open Explore, type `k6_` and confirm the six panel queries
resolve. Fixing a suffix here is a one-line dashboard edit; the metric definitions themselves
live in `k6/lib/metrics.js`.

## Labels, and why there is no `testid` label

Metric labels are capped at `suite`, `scenario`, `operation` and `status`
(`lib/tags.js` throws on anything else). The free tier allows 10 000 active series and that
budget is shared with production metrics, so run identity lives on **annotations** instead:
every run posts a start annotation, an end annotation tagged with its outcome, and one per
threshold breach — all tagged `odbattr`, the suite, the environment and the `testid`.

To slice metrics by run for a one-off investigation, run k6 with `K6_TAG_TESTID=true`; do not
leave it on.

## Finding the remote-write values

Two of the three are already recorded in Grafana's own Prometheus datasource, so they can be
read out rather than hunted for:

```bash
GRAFANA_URL=https://<stack>.grafana.net GRAFANA_ANNOTATIONS_TOKEN=glsa_... \
  tools/find-grafana-credentials.sh
```

It prints the write URL and the instance ID. Manually, the same values are at
grafana.com → your stack → **Prometheus** → **Details**: the *Remote Write Endpoint* and the
numeric *Instance ID* (which is the username).

The third, the token, cannot be read back from anywhere — tokens are shown once. Create one at
grafana.com → your org → **Access Policies** → create a policy scoped `metrics:write` on this
stack, then **Add token**.

Note these are a *different* credential system from the annotations token, and the two are not
interchangeable: remote write wants a Cloud **Access Policy** token (`glc_…`), the annotations
API wants an instance **service-account** token (`glsa_…`). Swapping them yields a 401 either
way.

Then check them before anything depends on them:

```bash
tools/verify-metrics.sh
```

This exists because **k6 logs a rejected push and still exits 0** — the same shape as the
annotation failures that took four CI runs to spot. The script pushes five seconds of metrics
and fails if any were rejected, naming the likely cause. It also catches the two easy mistakes
up front: using the query endpoint (`/api/prom`) where remote write needs `/api/prom/push`, and
putting a token in the username field instead of the instance ID.

## Secrets the workflows expect

| Secret | Used for |
|---|---|
| `GC_PROM_RW_URL` | Prometheus remote-write endpoint (`https://prometheus-prod-XX-<region>.grafana.net/api/prom/push`) |
| `GC_PROM_INSTANCE_ID` | remote-write username — the numeric Prometheus instance ID |
| `GC_PROM_TOKEN` | Access Policy token with `metrics:write` |
| `GRAFANA_URL` | stack URL, e.g. `https://myorg.grafana.net`, for the annotations API |
| `GRAFANA_ANNOTATIONS_TOKEN` | service-account token with annotation write permission |
| `ODB_OTEL_ENDPOINT` / `ODB_OTEL_KEY` | optional: makes the ephemeral stack ship ODB traces to Tempo |

If the remote-write secrets are absent the load run still runs and still writes its summary to
the ledger — it just has no live metrics. If the annotation secrets are absent, the annotation
payload is printed to the log instead. Neither turns a green run red.

## Finding a run in Tempo

Metrics and traces are correlated by **time window plus `environment`**, not by exemplar:

1. Find the run's start/end annotation on the dashboard (tags: `odbattr`, `load` or
   `regression`).
2. In Tempo, query that window with the environment the traffic carried, e.g.
   `{ resource.environment = "loadtest" && duration > 2s }`.

k6 injects a W3C `traceparent` into every request (`k6/vendor/http-instrumentation-tempo.js`),
so those spans exist as long as the target has `ODB_OTEL_ENDPOINT`/`ODB_OTEL_KEY` set. The
per-request trace ID is not on the metrics — that would be the cardinality disaster the label
budget exists to prevent.

## Alerts

None in v1, deliberately (spec §7). A threshold breach fails the CI run, and GitHub's
workflow-failure email is the single alerting path. Trend-based Grafana alerts are future work.
