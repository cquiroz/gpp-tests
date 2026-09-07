---
id: 023
title: "Surge SLO file and the surge verdict"
labels: [wayfinder:task]
status: open
assignee:
blocked-by: []
---

## Question

Put the absolute pass criteria from ticket 020 in one file, separate from the trend run's
ledger-derived thresholds: execution (step ODB overhead p95 < 2 s / p99 < 5 s,
per-mutation p95 < 500 ms / p99 < 2 s, execution-config p95 < 3 s, zero timeouts —
marked provisional pending Observe developers), proposal submit p95 < 2 s, regular reads
p95 < 2 s and writes p95 < 5 s, error rate < 1 %, subscription round trip (pick a
provisional figure once 022 measures one). Translate them into k6 thresholds by tag, and
build the **surge verdict**: a GitHub job summary with one table per class, the k6
summary artifact, Grafana annotations on breach. Slack stays deferred per ticket 010.
Resolution records the file, how a class is added, and one rendered verdict.
