---
id: 003
title: "Decide the ephemeral regression stack composition"
labels: [wayfinder:grilling]
status: closed
assignee: carlos.quiroz
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

## Resolution

The ephemeral regression stack is a **docker-compose file in the testing repo** (same
file for CI and local debugging), composed of:

1. **postgres:15** — SSL enabled with the lucuma-odb repo's `test-cert/` (Flyway
   requires `sslmode=require`); initdb creates three empty databases (`lucuma-odb`,
   `lucuma-sso`, `prefs`) but applies **no** psql migrations.
2. **sso** — `registry.heroku.com/lucuma-sso-dev/web:latest`;
   `LUCUMA_SSO_ENVIRONMENT=staging` with a **test-only GPG keypair committed to the
   testing repo** (local mode is unusable: random keypair ODB can't verify); dummy ORCID
   credentials (required to boot, unused by guest/API-key flows); Flyway migrates its DB
   at startup.
3. **odb** — `registry.heroku.com/lucuma-postgres-odb-dev/web:latest`; env per the
   [deployment-shapes research](002-research-lucuma-deployment-shapes.md) (dummy
   Cloudcube/Mailgun values, SSO public key = the committed test key); Flyway migrates
   at startup — so every regression run also regression-tests migrations from empty.
4. **itc** — `registry.heroku.com/itc-dev/web:latest`; Redis omitted (optional off
   Heroku); shares the service JWT.
5. **obscalc** — `registry.heroku.com/lucuma-postgres-odb-dev/obscalc:latest`; included
   from the start (needed for the more advanced scenarios' calculated results).
   calibrations and the resource service stay out (resource confirmed unused by Explore).
6. **hasura (prefs)** — stock `hasura/graphql-engine` with
   `HASURA_GRAPHQL_EXPERIMENTAL_FEATURES=naming_convention` +
   `HASURA_GRAPHQL_DEFAULT_NAMING_CONVENTION=graphql-default`, unauthenticated;
   migrations applied from `lucuma-apps/explore/hasura/user-prefs/` via hasura CLI.
   **Required**: Explore hangs forever after login if prefs is unreachable (see
   [research/explore-prefs-resource-deps.md](../../research/explore-prefs-resource-deps.md)).
7. **explore** — static server for the bundle **fetched from Firebase dev hosting**
   (tracks main; no build in CI), with our own `environments.conf.json` pointing at the
   ephemeral endpoints. Long-term ask for the spec: lucuma-apps CI publishes the bundle
   as an artifact.
8. **caddy** — TLS-terminating reverse proxy with its internal CA fronting
   `explore.gpp-test.internal`, `sso.gpp-test.internal`, `odb.gpp-test.internal` (etc.)
   via runner `/etc/hosts` — staging-mode SSO forces `Secure`/`SameSite=Strict` cookies,
   so browser flows need https and a shared parent domain. Playwright trusts the CA;
   k6 uses `insecureSkipTLSVerify`. (Carlos has a Cloudflare-managed domain available —
   real DNS + real certs are the documented fallback if the internal-CA route causes
   friction, and likely the tool for the persistent load target instead.)

Cross-cutting decisions:
- **Images pulled from Heroku's registry** with a `HEROKU_API_KEY` CI secret (access
  confirmed); sbt `docker:publishLocal` documented as fallback only.
- **Tag policy: `:latest` from the `-dev` apps** (= latest main); each run records the
  image SHAs so failures attribute to commits.
- **Bootstrap sequence**: registry login → pull → one-off `create-service-user odb` run
  of the SSO image (mints `ODB_SERVICE_JWT` shared by odb/itc/obscalc) → stack up →
  readiness = ODB GraphQL responding (Flyway done) + Hasura healthy.

Deferred to other tickets: whether ODB emits OTel during regression runs (Grafana
design ticket); JWT lifetime handling (test-user pool ticket); which scenario
assertions depend on obscalc output (v1 scenarios ticket).
