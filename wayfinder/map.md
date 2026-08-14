---
labels: [wayfinder:map]
title: Automated testing system for odb + Explore
---

# Automated testing system for odb + Explore

Tracker: local markdown. Tickets live in `wayfinder/tickets/`, one file each, with
frontmatter `status` (open/closed), `assignee` (the claim — empty = unclaimed), and
`blocked-by` (list of ticket ids). A ticket is on the **frontier** when it is open,
unassigned, and every id in `blocked-by` points at a closed ticket.

## Destination

A design spec for an automated testing system covering the odb GraphQL backend and the
Explore browser frontend — regression detection and load testing — precise enough that
implementation can start the next day: tooling, environment strategy, CI wiring, Grafana
Cloud integration, and the v1 scenario set. The spec is the deliverable; building the
system is the follow-on effort.

## Notes

Domain: the Gemini/GPP (lucuma) ecosystem — `gemini-hlsw/lucuma-odb` (backend, Postgres +
GraphQL), `gemini-hlsw/lucuma-apps` (Explore, React), an SSO service issuing JWTs (plus a
remember-me cookie) with a token API. All services ship as Docker images. Deployments run
on Heroku. Observability is Grafana Cloud, including Tempo for traces.

HITL tickets: always invoke `/grilling` and `/domain-modeling`. Glossary lives in
`CONTEXT.md` at the repo root.

Standing preferences:
- Open-source tooling only; no paid testing SaaS (k6 Cloud, Cypress Cloud, etc.).
- Cheap to run: GitHub Actions for CI; Heroku/AWS available for environments.
- Plan, don't do — this map produces the spec, not the test suite.

Settled during charting (constraints for every ticket):
- Two test layers: browser tests through Explore (the emphasis) with **Playwright**;
  GraphQL-level tests and load with **k6**.
- Fresh database per test run: empty Postgres → migrations → no reference data needed;
  scenarios create their own programs/observations.
- Auth: existing SSO with a **pool of pre-created test users**; tokens fetched
  scriptably via the SSO API (no browser needed).
- v1 cadence: **scheduled** runs against latest main-branch images (regression subset
  every few hours, performance set nightly). Per-PR wiring is phase 2, in the fog.
- Load tests target a Heroku-deployed environment, not the CI runner.
- v1 scenarios: (1) login, (2) create program, (3) create observation with a target,
  (4) edit and read back an observation.

## Decisions so far

<!-- one line per closed ticket: gist + link -->

- [Research: k6 → Grafana Cloud pipeline (metrics + Tempo traces)](tickets/001-research-k6-grafana-cloud-pipeline.md) —
  k6 OSS pushes metrics to Grafana Cloud natively via Prometheus remote-write; Tempo
  traces come from `traceparent` injection (jslib http-instrumentation-tempo) picked up
  by the services' own OTel; official dashboards 19665/18030 work without k6 Cloud.
- [Research: lucuma-odb / lucuma-apps / SSO deployment shapes](tickets/002-research-lucuma-deployment-shapes.md) —
  ODB+SSO+ITC live in the lucuma-odb monorepo; images go only to Heroku's registry (pull
  needs an API key); Flyway migrates automatically at startup (Postgres must run with
  SSL); SSO issues browserless JWTs (guest endpoint + api-key exchange via a service
  user); Explore is a static bundle picking backends from `environments.conf.json`.

## Not yet specified

- **Per-PR test dispatch** — phase 2: `lucuma-odb` / `lucuma-apps` CI triggering the
  regression subset on pull requests and reporting status back. Deliberately deferred
  until v1 scheduled runs prove out.
- **The other web applications** — a few lightly-used apps also talk to odb; they may
  join the scenario set later. Not yet named or prioritized.
- **New-user signup flow** — v1 logs in existing test users; testing the signup path
  through SSO is a dim later question.
- **Dedicated load environment on AWS** — only if the Heroku target proves unsuitable
  for meaningful load numbers (dyno limits, shared usage).

## Out of scope

- **Load-testing the SSO service itself** — load runs measure odb/Explore; SSO is
  exercised only to mint tokens.
- **Unit/integration tests inside the lucuma repos** — those live in each repo's own CI;
  this effort is the cross-system suite.
- **Paid/proprietary test infrastructure** — ruled out by the open-source constraint.
