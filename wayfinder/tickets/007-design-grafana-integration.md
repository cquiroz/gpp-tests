---
id: 007
title: "Design the Grafana dashboards and trace correlation"
labels: [wayfinder:grilling]
status: closed
assignee: carlos.quiroz
blocked-by: [001]
---

## Question

Design the Grafana Cloud integration: what the test-results dashboard shows (pass rate
over time, per-scenario latency trends, k6 load results), how a test run is identified
end-to-end in Tempo (run-id tagging / trace baggage so a test-triggered request is
findable among production traffic), retention expectations, and whether alerts fire
when a regression or SLO threshold trips.

## Resolution

Grounding facts: [research/k6-grafana-cloud-pipeline.md](../../research/k6-grafana-cloud-pipeline.md).

- **Both suites emit**: load runs remote-write k6 metrics live; regression runs push a
  small end-of-run summary (per-scenario pass/fail 0/1 + duration) so pass-rate-over-
  time exists for both. A dozen series, nearly free.
- **One Grafana Cloud stack** (the existing org one) for everything, test traffic
  distinguished by an `environment` resource attribute (`loadtest` / `ephemeral`).
  The **ephemeral regression stack sets `ODB_OTEL_ENDPOINT/KEY` too** — traces of
  failed regression scenarios are the debugging artifact this integration exists for.
- **Run identity**: `testid = <suite>-<github_run_id>` (`load-1234`,
  `regression-5678`); k6 stamps it on all metrics; the run posts **Grafana annotations
  at start/end and on threshold breach**. Tempo lookup = annotation window +
  `environment`. k6 requests carry `traceparent` (jslib http-instrumentation-tempo)
  for per-request linking; Playwright correlates by window only in v1.
- **Dashboards: both** — official k6 dashboards (19665; 18030 if native histograms
  ingest) for run internals, plus one custom **"GPP test results"** dashboard (nightly
  p95 per operation, error-rate trend, regression pass/fail history, run annotations)
  with its JSON committed to the testing repo.
- **Cardinality guardrails**: metric labels limited to `operation`, `scenario`,
  `suite`, `status` — never `testid` (annotations carry run identity) and never
  URLs/ids; trend stats avg/p95/p99. Keeps the free tier's 10k active series safe
  indefinitely.
- **No Grafana alerts in v1** — a threshold breach fails the CI run, and CI owns
  notification (CI-topology ticket). Trend-based Grafana alerts → map fog.
- **Retention: free tier (14-day metrics)** — so the durable record is a **per-run
  summary JSON (~1 KB) committed to the testing repo**; it also feeds the
  baseline-threshold calibration from the load-model ticket. Grafana is the live
  window, not the archive.
