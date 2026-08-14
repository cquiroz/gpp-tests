---
id: 003
title: "Decide the ephemeral regression stack composition"
labels: [wayfinder:grilling]
status: open
assignee:
blocked-by: [002]
---

## Question

Define the throwaway environment a regression run boots inside CI: which services make
up the stack (Postgres, odb, Explore — and SSO: containerized locally, or pointed at a
shared dev SSO instance, coupling PR-era runs to external state?), how images are pinned
to "latest main", startup and readiness ordering, where migrations run, and how the
stack is torn down. Output is the compose topology the spec will prescribe.

Sharpened by the [deployment-shapes research](002-research-lucuma-deployment-shapes.md):

- **Image access**: images live only in Heroku's registry — pull from
  `registry.heroku.com/<app>-dev/...:latest` with a Heroku API key in CI, or build via
  sbt (heavy: temurin 25, 6GB heap)? Which is cheaper and more reliable per run?
- **Postgres must run with SSL** (Flyway uses `sslmode=require`) — reuse the repo's
  compose + `test-cert/` setup.
- **SSO mode**: local mode's random keypair can't be verified by ODB — run SSO in
  staging mode with our own GPG keypair baked into the stack.
- **Which services are enough**: is ODB + SSO + Postgres sufficient for the v1
  scenarios, or do Explore-visible results require ITC, obscalc, and the Explore
  preferences DB (Hasura)? Where does the prefs DB come from?
- **Serving Explore**: static bundle + a custom `environments.conf.json` pointing at
  the ephemeral ODB/SSO — where does the bundle come from (build in CI vs artifact)?
