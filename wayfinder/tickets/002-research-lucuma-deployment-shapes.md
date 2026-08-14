---
id: 002
title: "Research: lucuma-odb / lucuma-apps / SSO deployment shapes"
labels: [wayfinder:research]
status: closed
assignee: research-subagent (fired during charting)
blocked-by: []
---

## Question

What do the lucuma repos actually ship, deployment-wise? The ephemeral regression stack
and the test-user token fetch both stand on these facts.

- **lucuma-odb** (github.com/gemini-hlsw/lucuma-odb): which Docker images are published,
  to which registry, and is there a tag tracking main? What configuration does odb need
  to boot against a fresh Postgres (env vars: DB URL, SSO keys/URL, etc.), and do
  migrations run automatically at startup or need a separate step?
- **Explore** (github.com/gemini-hlsw/lucuma-apps): how is Explore built and served
  (static bundle? image?), and how is it configured to point at a chosen odb and SSO
  instance (build-time env vs runtime config)?
- **SSO**: what is the SSO service (lucuma-sso?), is it containerized/publishable the
  same way, and what does its token API look like — endpoint, credentials required, token
  lifetime — for fetching a JWT without a browser?
- **Existing dev tooling**: do the repos already contain docker-compose files, CI
  service definitions, or local-dev scripts that boot the stack? Reuse beats invention.

Primary sources: the two GitHub repos (READMEs, Dockerfiles, CI workflows, deploy
configs) plus any lucuma-sso repo found in the gemini-hlsw org.
Findings go to `research/lucuma-deployment-shapes.md`.

## Resolution

Full findings: [research/lucuma-deployment-shapes.md](../../research/lucuma-deployment-shapes.md).

- **Monorepo shape**: `lucuma-odb` contains ODB *and* SSO (`modules/sso-service`) plus
  ITC, obscalc, calibrations, resource services. Explore lives in `lucuma-apps/explore`.
- **Images**: built on every main push but pushed only to
  `registry.heroku.com/<app>-{dev,staging,production}/<proc>` (`:latest` on `-dev`) — no
  public registry. CI must either pull with a Heroku API key or build via
  `sbt docker:publishLocal` (temurin 25, 6GB heap, git-lfs).
- **Migrations**: Flyway, runs automatically at service startup. Gotcha: connects with
  `sslmode=require`, so the test Postgres must run with SSL (repo's compose has
  `test-cert/`).
- **ODB env**: `DATABASE_URL`, `ODB_SSO_ROOT`, `ODB_SSO_PUBLIC_KEY` (GPG), 
  `ODB_SERVICE_JWT`, `ODB_ITC_ROOT`, `ODB_DOMAIN`; Cloudcube/Mailgun accept dummy values
  locally; OTel optional with `ODB_ENVIRONMENT=local`.
- **Browserless tokens**: `POST /api/v1/auth-as-guest` (no credentials, 10-min JWT);
  `GET /api/v1/exchange-api-key?key=…` with a service JWT yields 3-hour user JWTs;
  service JWTs minted via SSO's `create-service-user` CLI. ORCID is only needed for the
  browser flow. SSO "local" mode generates a random keypair ODB can't verify — run
  staging mode with our own GPG keys.
- **Explore**: static Vite bundle (deployed to Firebase Hosting, no Docker); selects
  backends at runtime via a fetched `/environments.conf.json` matched on hostname — an
  ephemeral stack just serves the bundle with a custom conf.
- **Reusable**: root `docker-compose.yml` (SSL Postgres 15 + initdb for both odb and sso
  DBs, adminer) and a pre-migrated-Postgres Dockerfile; no existing compose boots the
  services themselves.
- **Newly surfaced questions** (pushed to map fog / tickets): Explore's preferences DB
  (Hasura) in the ephemeral stack; guest vs standard test users; whether obscalc is
  needed for Explore-visible results; Heroku registry pull access from CI.
