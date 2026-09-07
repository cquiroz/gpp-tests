---
id: 026
title: "Provision the production-shaped Heroku target for the capacity claim"
labels: [wayfinder:task, wayfinder:hitl]
status: open
assignee:
blocked-by: [018, 027]
---

## Question

A surge pass on an m7i.4xlarge says nothing about production dynos. Once the surge
profile is stable on AWS (018) and production sizing is known (027), provision the
`lucuma-*-loadtest` Heroku apps at production shape — the M4 design in
`loadtest/provision.sh` plus guard rails, resized — run both surge tiers there, and
record the capacity verdict every result must be read through, plus cost per run and the
scale-to-zero arrangement. HITL: billable, needs team create-app rights.
