---
id: 017
title: "Standard-user auth and proposal scenarios in k6"
labels: [wayfinder:task]
status: open
assignee:
blocked-by: [012]
---

## Question

Surge traffic is proposal traffic, and guests can't touch proposals — build the
standard-user path the old map deferred: per-run bootstrapped standard users (SSO DB
inserts + API keys + JWT exchange, per the spec's phase-2 sketch and ticket 006), a
k6 auth helper alongside the guest one, and k6 proposal-lifecycle scenarios (create,
edit, submit) entering the scenario-parity catalog with the existing e2e proposal
specs. Developable against the local compose stack; lands in gpp-tests.
