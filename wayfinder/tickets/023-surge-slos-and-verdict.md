---
id: 023
title: "Surge SLO file and the surge verdict"
labels: [wayfinder:task]
status: closed
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

## Resolution (2026-10-07)

**The file: `k6/surge-slos.json`.** Five classes — `execution`, `proposals`, `regular`,
`subscriptions`, `errors` — each a title, a `provisional` note saying who still has to agree
the figure, and its SLOs: a name, the k6 metric or sub-metric (by tag) it applies to, and the
threshold expressions verbatim. The figures are ticket 020's, plus the subscription SLO this
ticket had to pick from 022's first native run (event latency p95 < 500 ms, round trip p95 <
250 ms, zero lost events, zero unanswered pings) and the proposal loop's rate claim from 017
(`dropped_iterations{scenario:proposals} count==0`). Two translations were not literal: "zero
timeouts" is `odb_graphql_errors{scenario:execution,status:0} count==0` — a request that never
completed, which is what a timeout is to k6 — and "error rate < 1 %" is `checks rate>0.99`
rather than `http_req_failed`, because the odb answers a rejected operation with HTTP 200. The
regular class is per scenario (`read-mix`, `calculated-results`, `edit-observation`,
`create-observation`, `create-program`) so that under composition (018) execution and proposal
writes cannot pollute it. The ledger-derived thresholds stay where they were
(`tools/compute-thresholds.js`, `GPP_THRESHOLDS`); nothing of theirs lives in this file.

**Into k6.** `lib/surge-slos.js` validates the file (every expression must be a k6 threshold
expression; a metric may belong to one class only, because k6 keeps one threshold list per
metric) and translates classes into `options.thresholds`; `k6/lib/slos.js` opens it once per
VU, and `execution.js`, `proposals.js` and `subscribers.js` now take
`...sloThresholds(["errors", <class>])` instead of hand-written numbers, so k6's exit code is
the verdict. Two k6 facts shaped this: a sub-metric reaches the summary only when a threshold
names it (the scripts keep their informational `>=0` breakdowns for that reason), and the
summary export carries only the configured trend stats, so each script declares
`summaryTrendStats: sloTrendStats(classes)` — without it a `p(99)` threshold k6 evaluated is
absent from the export and the verdict could not read it. `load.js` names the regular class
unarmed (`arm: false`): its gate stays the ledger, but the sub-metrics reach the summary, so a
verdict can read the regular class off a trend run too.

**The verdict.** `lib/verdict.js` evaluates the file's expressions against a summary export
with the same grammar (a breach here is a breach in k6), one table per class, and
`tools/surge-verdict.js` renders it: Markdown on stdout, appended to `$GITHUB_STEP_SUMMARY`
when set (the job summary), `--out` saves it beside the JSON, `--breaches` prints the failed
expressions in the shape `tools/grafana-annotate.js --breach=` takes, `--json` the structure;
`--classes` restricts it to what a standalone run exercises. Exit 0 pass, 1 fail, 2 when the
run exercised none of the classes asked for; `--no-fail` for a reporter. A class the summary
has nothing for is "not exercised", listed on one line, never failed; a trend k6 exported as
all zeros is "no samples", not a pass; an aggregation the export lacks is "stat not exported".
The AWS wizard runs it after each summary it collects (execution, subscribers, load), saves
`out/k6-aws-<run>-<stamp>-verdict.md`, and annotates a breach in Grafana when `GRAFANA_URL`
and `GRAFANA_ANNOTATIONS_TOKEN` are in the environment (the remote-write credentials do not
reach that API, and it says so). In a workflow — 018's, once 016 gives CI a way onto AWS —
the steps are: `k6 run --summary-export out/k6-summary.json …` with `continue-on-error`;
`node tools/surge-verdict.js out/k6-summary.json` (writes the job summary; its exit code is
the gate); on a breach `tools/grafana-annotate.js --kind=breach --breach="$(node
tools/surge-verdict.js --breaches out/k6-summary.json)"`; `actions/upload-artifact` on
`out/k6-summary.json`. Slack stays deferred (010).

**Adding a class.** Add a key under `classes` in `k6/surge-slos.json` — title, provisional
note, SLOs with k6 metric names and expressions (`npm test` checks that the file parses and
that no metric is claimed twice) — name it in the script that exercises it
(`sloThresholds([..., "newclass"])` and `sloTrendStats` alike), and make sure the metric is
emitted with the tags the sub-metric selects. The verdict renders every class in the file;
nothing else changes.

**A rendered verdict**, from the 2026-10-07 AWS execution run — the one the execution-overhead
handoff is about (`out/k6-aws-execution-20261007T210956Z.json`, rendered by `npm run verdict
-- out/k6-aws-execution-20261007T210956Z.json --classes=errors,execution`):

## Surge verdict: ✅ PASS

run: `out/k6-aws-execution-20261007T210956Z.json` · criteria: `k6/surge-slos.json` (ticket 023)

### Execution (Observe): ✅ PASS

| SLO | Metric | Threshold | Observed | Result |
|---|---|---|---|---|
| step ODB overhead | `odb_step_overhead` | p(95) < 2000 ms | 1260 ms | ✅ pass |
| step ODB overhead | `odb_step_overhead` | p(99) < 5000 ms | 1930 ms | ✅ pass |
| per-mutation latency | `odb_write_duration{scenario:execution}` | p(95) < 500 ms | 146 ms | ✅ pass |
| per-mutation latency | `odb_write_duration{scenario:execution}` | p(99) < 2000 ms | 223 ms | ✅ pass |
| execution-config fetch | `odb_read_duration{operation:ExecutionConfig}` | p(95) < 3000 ms | 321 ms | ✅ pass |
| requests that never completed (timeouts, Observe's is 20 s) | `odb_graphql_errors{scenario:execution,status:0}` | count = 0 | — | ⚪ metric absent |

_Provisional: Stall budget chosen by this project; Observe developers have not yet seen real numbers (ticket 020)._

### Errors (every class): ✅ PASS

| SLO | Metric | Threshold | Observed | Result |
|---|---|---|---|---|
| operations that succeeded | `checks` | rate > 99 % | 100 % | ✅ pass |

_Provisional: Error rate below 1 % (ticket 020). Measured on k6 checks, not http_req_failed: the odb answers a rejected operation with HTTP 200 and an errors array._

The subscribers run of the same session reads PASS too: event latency p95 77 ms, round trip
p95 10.8 ms, 0 lost events, 0 unanswered pings, checks 100 %, the other classes not
exercised. Neither summary carries the two sub-metrics that only exist now
(`odb_graphql_errors{…,status:0}`, `dropped_iterations{scenario:proposals}`); the next AWS
run, with the file armed, will.

**Validated locally** (2026-10-07, the Docker VM, short runs): every script starts with the
file armed and its summary carries what the verdict needs. Proposals at 500/h for 45 s: submit
p95 459 ms, `dropped_iterations{scenario:proposals}` 0, PASS. Subscribers (4 + 1 churn):
event latency p95 215 ms, round trip p95 58 ms, PASS. The load script, unarmed, exported the
five regular sub-metrics and the verdict read them (two VM breaches: calculated-results p95
6 s, edit-observation p95 6.9 s — the starved local odb; k6 exited 0, as it must). Execution
at a 2–4 s cadence breached — step overhead p95 4.5 s, then p99 7.4 s once `summaryTrendStats`
put p(99) in the export; the VM, not the tooling, the same script on AWS reads 1.26 s — and k6
exited 99 with the verdict naming the rows, which is the mechanism working end to end.
