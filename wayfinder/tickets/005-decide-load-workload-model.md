---
id: 005
title: "Decide the load-test workload model and target"
labels: [wayfinder:grilling]
status: closed
assignee: carlos.quiroz
blocked-by: [004]
---

## Question

Define the nightly performance set: the workload mix (read/write ratio across the v1
scenarios), the virtual-user ramp profile and target concurrency ("a few hundred"),
run duration, and the pass/fail thresholds (latency and error-rate SLOs). And the
target: which Heroku-deployed environment the load points at, whether hammering it is
safe (shared with humans? dyno limits?), and how data created by load runs is cleaned
up afterwards.

## Resolution

- **Target: a dedicated load-target Heroku app set** (`lucuma-*-loadtest`: odb web +
  obscalc, sso, itc, one Postgres) — released from the same `-dev` images (= latest
  main) right before each run. Shared dev/staging ruled out: pollution and lag.
  Standing this infra up is an implementation item the spec will carry.
- **Database state: reset before every run** — `heroku pg:reset`, Flyway migrates at
  boot, then a k6 setup stage **pre-seeds a fixed corpus** (~200 programs with
  observations via the mutation scripts) so reads don't measure an empty database.
  Cleanup problem dissolves.
- **Concurrency contract: ramp 0→50 over 5 min, 50→200 over 10 min, hold 200 VUs for
  20 min, ramp down** (~40 min nightly).
- **Workload mix: 60% reads / 40% writes**, each VU a user session (token fetch →
  weighted action loop, think time 1–5 s uniform). Reads = Explore's real query mix
  (programs list, program details, observations pagination); writes = create program,
  create observation + target + observing mode (feeding ITC/obscalc), subtitle updates.
  Spec notes the mix should be re-weighted from production traces once available.
- **Thresholds: baseline-first** — first 3 nights threshold-free; then k6 thresholds
  set at baseline + headroom. Initial (to be calibrated): p95 read < 2 s, p95 mutation
  < 5 s, error rate < 1%; breach = red run + Grafana annotation.
- **Claim: regression detection** (night-over-night trends in Grafana), not absolute
  capacity — that stays in map fog (AWS dedicated environment).
- **k6 runs on a GitHub Actions hosted runner**; its CPU is the recorded ceiling.
  Distributed k6 joins the fog alongside WS subscriptions (same scaling question).

Interaction with the test-user pool ticket: this model needs one token per VU at ramp
start — 200 users' worth — which that ticket must satisfy (pool size ≥ VU target, or
guest tokens if guests suffice at load).
