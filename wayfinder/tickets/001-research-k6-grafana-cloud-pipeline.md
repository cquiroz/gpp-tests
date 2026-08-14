---
id: 001
title: "Research: k6 → Grafana Cloud pipeline (metrics + Tempo traces)"
labels: [wayfinder:research]
status: closed
assignee: research-subagent (fired during charting)
blocked-by: []
---

## Question

Using only free/open-source components (no k6 Cloud), what is the concrete pipeline for
getting k6 results into Grafana Cloud?

- **Metrics**: does k6 OSS ship Prometheus remote-write output natively (which flags /
  env vars), and what are the practical limits of pushing to Grafana Cloud's hosted
  Prometheus/Mimir on the free tier (active series, retention)?
- **Traces**: how does k6 propagate trace context (`traceparent`) into the system under
  test so its requests appear in Tempo, and how are k6 spans/results correlated with
  server-side traces — built-in tracing module, xk6 extension, or header injection?
- **Dashboards**: which ready-made Grafana dashboards exist for k6 results, and do they
  work against remote-write data (not k6 Cloud)?

Primary sources: grafana.com/docs (k6, Tempo, Grafana Cloud), the grafana/k6 repo.
Findings go to `research/k6-grafana-cloud-pipeline.md`.

## Resolution

Full findings: [research/k6-grafana-cloud-pipeline.md](../../research/k6-grafana-cloud-pipeline.md) (k6 v2.2.0).

- **Metrics**: open-source k6 pushes natively to Grafana Cloud via `k6 run -o
  experimental-prometheus-rw`; auth = Prometheus instance ID + Access Policy token with
  `metrics:write`. Free tier: 10k active series / 14-day retention — tag cardinality
  (URLs, testid) is the main risk to manage.
- **Traces**: the old `k6/experimental/tracing` module was removed (v0.55); the current
  mechanism is the jslib `http-instrumentation-tempo` (`instrumentHTTP({propagator:
  'w3c'})`), which injects `traceparent` so the system under test's own OTel
  instrumentation produces the Tempo traces. Trace ids land in k6 datapoint metadata,
  not as Prometheus labels — correlation is by time window + `testid` tag, not exemplars.
- **Dashboards**: official Grafana dashboards 19665 and 18030 (from
  xk6-output-prometheus-remote) work on pure remote-write data, no k6 Cloud.
- **CI**: official `grafana/setup-k6-action` + `grafana/run-k6-action`; tag runs with
  `--tag testid=${{ github.run_id }}`; runner CPU caps achievable load (reinforces
  targeting a deployed environment for the performance set).
