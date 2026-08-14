# k6 → Grafana Cloud (Mimir + Tempo) pipeline with free/OSS components

**Summary.** Open-source k6 can feed an existing Grafana Cloud stack without the paid Grafana Cloud k6 product. Metrics: k6 ships a built-in (still experimental-flagged) Prometheus remote-write output — `k6 run -o experimental-prometheus-rw` — that pushes directly to Grafana Cloud's hosted Prometheus/Mimir endpoint using HTTP Basic auth (username = stack's Prometheus **instance ID**, password = an **Access Policy token** with `metrics:write` scope). Traces: k6 does not export its own traces; instead the official jslib module `http-instrumentation-tempo` (the successor to the removed `k6/experimental/tracing`) injects a W3C `traceparent` header into every HTTP request, so the *system under test's* own OTel instrumentation (already shipping to the stack's Tempo) produces the traces; the generated `trace_id` is attached to k6 datapoint metadata for correlation. Dashboards: official grafana.com dashboards **19665** ("k6 Prometheus") and **18030** ("k6 Prometheus (Native Histograms)") are built for the remote-write output and have no k6 Cloud dependency. In CI, the official `grafana/setup-k6-action` + `grafana/run-k6-action` run all of this from GitHub Actions with the RW credentials passed as env-var secrets.

**Versions these findings apply to:** k6 **v2.2.0** (latest, released 2026-08-10; v1.8.1 is the current v1 maintenance release, 2026-08-12 — verified via the GitHub releases API for [grafana/k6](https://github.com/grafana/k6/releases)). jslib `http-instrumentation-tempo` **1.0.x**. Docs consulted at `grafana.com/docs/k6/latest` on 2026-08-14.

---

## 1. Metrics: k6 → Grafana Cloud Prometheus (Mimir) via remote write

### Native support in OSS k6

Yes — the Prometheus remote-write output is compiled into stock k6 (it originated as the `xk6-output-prometheus-remote` extension and was merged in as an experimental output around v0.42; no xk6 build is needed). It is still labelled **experimental** in the current docs ("breaking changes possible"), but it survived both the v1.0 and v2.0 major releases unchanged — the v2.0.0 breaking-changes list does not touch it. Sources: [Prometheus remote write output docs](https://grafana.com/docs/k6/latest/results-output/real-time/prometheus-remote-write/), [xk6-output-prometheus-remote README](https://github.com/grafana/xk6-output-prometheus-remote/blob/main/README.md), [v2.0.0 release notes](https://github.com/grafana/k6/releases/tag/v2.0.0).

Key flags / env vars (from the official docs page above):

| Setting | Meaning |
|---|---|
| `-o experimental-prometheus-rw` | Enable the output on `k6 run` |
| `K6_PROMETHEUS_RW_SERVER_URL` | Remote-write endpoint (default `http://localhost:9090/api/v1/write`) |
| `K6_PROMETHEUS_RW_USERNAME` / `K6_PROMETHEUS_RW_PASSWORD` | HTTP Basic auth |
| `K6_PROMETHEUS_RW_BEARER_TOKEN` | Alternative bearer-token auth |
| `K6_PROMETHEUS_RW_PUSH_INTERVAL` | Push cadence (default `5s`) |
| `K6_PROMETHEUS_RW_TREND_STATS` | Which aggregations of Trend metrics become series, e.g. `p(95),p(99),min,max,avg` (default `p(99)`) |
| `K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM=true` | Emit Trends as Prometheus **native histograms** instead of per-stat gauges |
| `K6_PROMETHEUS_RW_STALE_MARKERS=true` | Mark series stale when the test ends (recommended so dashboards drop to zero) |
| `K6_PROMETHEUS_RW_HTTP_HEADERS`, `..._INSECURE_SKIP_TLS_VERIFY`, `..._TLS_MIN_VERSION`, SigV4 vars | Extras for special endpoints |

All emitted metrics get a `k6_` prefix (e.g. `k6_http_req_duration_p99`).

### Pushing to Grafana Cloud specifically

The official recipe ([Grafana Cloud Prometheus docs page](https://grafana.com/docs/k6/latest/results-output/real-time/grafana-cloud-prometheus/)) — explicitly the non-Cloud-k6 path:

1. In the Grafana Cloud portal, open your **Prometheus** service → **Details**; copy the **Remote Write Endpoint** URL (shape: `https://prometheus-prod-XX-<region>.grafana.net/api/prom/push`) and the numeric **Instance ID** (this is the username).
2. Create an **Access Policy token** with the `metrics:write` scope (the docs specify an Access Policy token, not the legacy "MetricsPublisher" API-key role).
3. Run:

```bash
K6_PROMETHEUS_RW_USERNAME=<INSTANCE_ID> \
K6_PROMETHEUS_RW_PASSWORD=<ACCESS_POLICY_TOKEN> \
K6_PROMETHEUS_RW_SERVER_URL=<REMOTE_WRITE_ENDPOINT> \
k6 run -o experimental-prometheus-rw --tag testid=$(date +%s) script.js
```

The `--tag testid=...` is the docs' recommended way to slice one run from another in queries and in the official dashboards.

### Free-tier limits that matter here

Grafana Cloud Free includes **10,000 active metric series** and **14-day metrics retention** (plus 50 GB logs, 50 GB traces, 3 users) — [Grafana Cloud Metrics product page](https://grafana.com/products/cloud/metrics/), corroborated by [usage-limits docs](https://grafana.com/docs/grafana-cloud/cost-management-and-billing/manage-invoices/understand-your-invoice/usage-limits/). Practical consequences:

- **Cardinality is the real risk.** Every k6 tag becomes a label; every distinct URL and every `testid` value multiplies series. Use k6's `name` tag / URL grouping for dynamic URLs, keep `K6_PROMETHEUS_RW_TREND_STATS` to the few stats you chart, and avoid per-VU or per-iteration tags. A modest test with default trend stats stays in the hundreds of series; unconstrained URL labels can blow through 10k quickly.
- `testid`-tagged series from finished runs stop counting as *active* after Mimir's staleness window, so serialized CI runs are fine; retention of the data itself is 14 days on free.
- Native-histogram mode needs a receiver that supports native histograms (Prometheus ≥ v2.40 with the feature flag; for Grafana Cloud/Mimir it may need to be enabled on the tenant — see caveats).

### Alternative: OpenTelemetry output

Since ~v1.0, k6 also has a **stable** `-o opentelemetry` output (metrics only) with `K6_OTEL_*` env vars including HTTP Basic-auth (`K6_OTEL_HTTP_EXPORTER_USERNAME/_PASSWORD`) and `K6_OTEL_HEADERS`, usable against the Grafana Cloud OTLP gateway — [OpenTelemetry output docs](https://grafana.com/docs/k6/latest/results-output/real-time/opentelemetry/). The remote-write path is the one the Grafana Cloud docs and official dashboards are built around, so it remains the recommended route; OTel output is a fallback if you already funnel everything through the OTLP gateway or a local collector.

## 2. Traces: W3C trace context propagation into Tempo

**Model:** k6 itself does not send spans to Tempo. It *propagates trace context* — injecting a sampled W3C `traceparent` (or Jaeger) header into outgoing HTTP requests — so that the **system under test's own OTel/tracing instrumentation** (which in this setup already exports to the Grafana Cloud stack's Tempo) records the request as a trace whose ID k6 knows.

### Current module name (important — it moved)

- `k6/experimental/tracing` (a core experimental module) was **deprecated in k6 v0.53.0 and removed in v0.55.0** — [v0.53.0 release notes](https://github.com/grafana/k6/releases/tag/v0.53.0), [v0.55.0 notes](https://newreleases.io/project/github/grafana/k6/release/v0.55.0).
- Its drop-in replacement is the official jslib **`http-instrumentation-tempo`** — same API, pure-JS: [module docs](https://grafana.com/docs/k6/latest/javascript-api/jslib/http-instrumentation-tempo/). Migration is literally replacing the import path.

Usage (current k6 v1.x/v2.x):

```javascript
import tempo from 'https://jslib.k6.io/http-instrumentation-tempo/1.0.1/index.js';
import http from 'k6/http';

tempo.instrumentHTTP({ propagator: 'w3c' }); // init context; 'w3c' (default) or 'jaeger'

export default function () {
  http.get('https://sut.example.com/api/thing'); // traceparent auto-injected
}
```

- `instrumentHTTP` wraps all `k6/http` methods (`get`, `post`, `put`, `del`, `head`, `options`, `patch`, `request`); from that point every request carries a trace-context header, and **the datapoint metadata of the request's metrics carries the generated `trace_id`** — [instrumentHTTP docs](https://grafana.com/docs/k6/latest/javascript-api/jslib/http-instrumentation-tempo/instrumenthttp/), [options](https://grafana.com/docs/k6/latest/javascript-api/jslib/http-instrumentation-tempo/options/).
- The [`Client` class](https://grafana.com/docs/k6/latest/javascript-api/jslib/http-instrumentation-tempo/client/) is the selective alternative — instrument only the requests made through the client instead of the whole `http` module. A `sampling` option controls what fraction of requests get a sampled flag.
- **Manual header injection** remains trivial for edge cases (non-`k6/http` protocols, custom formats): generate a random 16-byte trace ID and set `headers: { traceparent: '00-<traceId>-<spanId>-01' }` yourself. The jslib is just a maintained version of exactly this.
- **xk6 extensions:** the older `xk6-distributed-tracing` route is superseded by the jslib; no custom k6 build is needed for propagation. (An xk6 build is only relevant if you want k6 to *emit its own spans*, which nothing official supports today.)

### Correlating k6 metrics with server-side Tempo traces

- The `trace_id` lives in **datapoint metadata**, which is surfaced by outputs that carry per-datapoint metadata (e.g. `--out json` — each point's `metadata.trace_id`) and by Grafana Cloud k6 (paid). The **Prometheus RW output aggregates datapoints into time series and does not carry per-request trace IDs as labels** (and doing so would be a cardinality disaster anyway); exemplar support could not be verified (see caveats).
- Practical free-tier correlation pattern: (a) tag runs with `testid` and correlate by **time range + service** in Tempo (TraceQL: `{ resource.service.name = "your-sut" && duration > 500ms }` over the test window); (b) for failure forensics, additionally write `--out json=results.json` locally/CI-artifact and grep the `trace_id` metadata of slow/failed requests, then open that exact trace in Tempo; (c) in Grafana, link a Tempo panel next to the k6 dashboard filtered to the same time window.

## 3. Ready-made dashboards (no k6 Cloud required)

Both official dashboards are published from the open-source [grafana/xk6-output-prometheus-remote](https://github.com/grafana/xk6-output-prometheus-remote) repo (their JSON lives in `grafana/dashboards/` there) and consume only `k6_*` series from a Prometheus data source — nothing calls the k6 Cloud API:

| ID | Name | Notes |
|---|---|---|
| **19665** | [k6 Prometheus](https://grafana.com/grafana/dashboards/19665-k6-prometheus/) | For the default (trend-stats) mode. This is the one the [Grafana Cloud Prometheus docs](https://grafana.com/docs/k6/latest/results-output/real-time/grafana-cloud-prometheus/) tell you to import; has a `testid` variable. |
| **18030** | [k6 Prometheus (Native Histograms)](https://grafana.com/grafana/dashboards/18030-k6-prometheus-native-histograms/) | Requires `K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM=true` and native-histogram support in the backend. |
| 18595 | [k6 Load Testing Results (Prometheus)](https://grafana.com/grafana/dashboards/18595-k6-load-testing-results-prometheus/) | Community-maintained alternative; same data source. |

Import via Grafana → Dashboards → Import → enter ID, pick your Grafana Cloud Prometheus data source.

## 4. Running from GitHub Actions

- **Official actions** (both Grafana-owned, Apache-2.0):
  - [`grafana/setup-k6-action`](https://github.com/grafana/setup-k6-action) — installs k6 (input `k6-version`, defaults to latest; `browser: true` also installs Chrome for k6-browser tests).
  - [`grafana/run-k6-action`](https://github.com/grafana/run-k6-action) — wraps `k6 run`: `path` glob for multiple scripts, `parallel`, `fail-fast`, extra `flags`. Its cloud-oriented inputs (`cloud-run-locally`, `cloud-comment-on-pr`, `K6_CLOUD_TOKEN`) are **optional** — for the OSS pipeline you skip them and pass the RW settings as env vars.
- Free-tier-relevant workflow sketch:

```yaml
jobs:
  load-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: grafana/setup-k6-action@v1
      - uses: grafana/run-k6-action@v1
        env:
          K6_PROMETHEUS_RW_SERVER_URL: ${{ secrets.GC_PROM_RW_URL }}
          K6_PROMETHEUS_RW_USERNAME: ${{ secrets.GC_PROM_INSTANCE_ID }}
          K6_PROMETHEUS_RW_PASSWORD: ${{ secrets.GC_PROM_TOKEN }}
        with:
          path: ./tests/*.js
          flags: -o experimental-prometheus-rw --tag testid=${{ github.run_id }}
```

- Load-bearing notes:
  - `--tag testid=${{ github.run_id }}` gives each CI run a stable, linkable slice in dashboard 19665.
  - Alternatively, skip the actions and use the official Docker image (`grafana/k6`) as a job container — the env vars are identical; the actions mainly add version pinning, globbing, and browser support.
  - Egress: the runner pushes every `K6_PROMETHEUS_RW_PUSH_INTERVAL` (5s default) over HTTPS — no inbound access to Grafana Cloud needed, works from ephemeral runners.
  - Store the Access Policy token as a repo/environment secret; scope it to `metrics:write` only.
  - GitHub-hosted runners cap the achievable load (2-core standard runners); for serious load use larger runners or self-hosted, or shard with `parallel: true` across jobs.

## Open questions / caveats

- **Exemplar support in the Prometheus RW output is unverified.** I found no documentation or issue confirming that `experimental-prometheus-rw` emits exemplars carrying the jslib's `trace_id` metadata; assume trace↔metric correlation is by time window/`testid`, not by exemplar, until proven otherwise (check current issues in `grafana/xk6-output-prometheus-remote` / `grafana/k6`).
- **Native histograms on Grafana Cloud free tier:** Mimir supports native histograms, but whether ingestion is enabled by default on a given (free) Grafana Cloud tenant was not verified; test with `K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM=true` or ask support before standardizing on dashboard 18030. Dashboard 19665 (classic trend stats) is the safe default.
- **Tempo free-tier trace retention** (commonly stated as 30 days) was not verified against a primary source; only the 50 GB/month ingest figure was confirmed.
- **"Experimental" flag on the RW output:** the flag name is still `experimental-prometheus-rw` in the `latest` docs as of 2026-08-14; a future rename to `prometheus-rw` would be a one-line CI change but is worth pinning `k6-version` against.
- The exact free-tier figures (10k series / 14-day retention) come from Grafana's product page plus secondary pricing round-ups; Grafana adjusts tiers occasionally — re-check [grafana.com/pricing](https://grafana.com/pricing/) at implementation time.
- The `sampling` option's precise semantics in `http-instrumentation-tempo` (does an unsampled request still get a `traceparent` with the sampled flag unset?) were not verified in depth — read [the options page](https://grafana.com/docs/k6/latest/javascript-api/jslib/http-instrumentation-tempo/options/) when tuning.
