---
id: 004
title: "Specify the v1 scenarios"
labels: [wayfinder:grilling]
status: closed
assignee: carlos.quiroz
blocked-by: []
---

## Question

Pin the four v1 scenarios into precise, assertable steps: (1) login via SSO as a test
user, (2) create a program, (3) create an observation with a target, (4) edit and read
back an observation. For each: preconditions, the UI steps in Explore, the expected
GraphQL effects, the assertions that constitute pass/fail, and cleanup. Also decide the
layer split — which scenarios run in the browser under Playwright, and which get a
GraphQL-level k6 variant for the performance set.

## Resolution

Grounding facts: [research/v1-scenario-graphql-ui-map.md](../../research/v1-scenario-graphql-ui-map.md)
(guests may create programs/observations/targets; first login auto-creates a program;
sidereal targets need name + sourceProfile + ra/dec/epoch; no e2e tests or stable test
ids exist today).

**Browser suite: one chained Playwright journey** (single guest browser context, each
scenario a named test step), with a **GraphQL read-back assertion after every step**
(query ODB directly; split "backend broke" from "frontend broke").

1. **Login as guest** — open Explore, click "Continue as Guest"; assert the logged-in
   shell renders and the **auto-created program** exists (UI + `programs` query).
2. **Create a program explicitly** — Manage Programs → "Proposals & Programs" dialog →
   create; assert it appears in the UI list and in the `programs` query.
3. **Create an observation with a target and configuration** — "Obs" button in the obs
   tree; add target via **"Empty Sidereal Target"** with fixed hardcoded coordinates
   (no external catalogs in v1); select a minimal **GMOS long-slit** observing mode;
   assert the observation, target (asterism), and mode via `observations`/`program`
   queries, **and assert calculated results appear** — this is the end-to-end check
   that ITC and obscalc are alive.
4. **Edit and read back** — change the observation **subtitle** (inline ObsBadge edit),
   then **full page reload**; assert the subtitle survived in the UI and via
   `updateObservations`-adjacent read query.

**k6/GraphQL variants: all four**, with login replaced by token fetch
(`POST /api/v1/auth-as-guest` or pool tokens per the test-user-pool ticket):
`createProgram`, `createObservation` + `createTarget` (+ observing-mode SET),
`updateObservations` (subtitle), plus the **read mix Explore actually issues**
(`programs(OFFSET, includeDeleted:true)`, `program(programId)` details, `observations`
pagination) as the load-realism backbone. WebSocket subscriptions deferred (map fog).

**Spec asks recorded**: lucuma-apps to add `data-testid` to the elements these
scenarios touch (v1 ships with role/text selectors and migrates as ids land); v1 target
coordinates are hardcoded constants in the testing repo.

Future directions pushed to map fog: scenarios as existing standard users and staff
users (role-diverse coverage); a separately-reported external-integrations scenario
(catalog Target Search via Simbad); WS subscriptions in the load mix.
