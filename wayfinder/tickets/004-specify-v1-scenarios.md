---
id: 004
title: "Specify the v1 scenarios"
labels: [wayfinder:grilling]
status: open
assignee:
blocked-by: []
---

## Question

Pin the four v1 scenarios into precise, assertable steps: (1) login via SSO as a test
user, (2) create a program, (3) create an observation with a target, (4) edit and read
back an observation. For each: preconditions, the UI steps in Explore, the expected
GraphQL effects, the assertions that constitute pass/fail, and cleanup. Also decide the
layer split — which scenarios run in the browser under Playwright, and which get a
GraphQL-level k6 variant for the performance set.
