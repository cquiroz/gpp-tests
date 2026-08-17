# Glossary

- **odb** — the backend: Postgres database fronted by a GraphQL server, source of truth
  for programs and observations.
- **Explore** — the React web frontend through which users manipulate odb data.
- **SSO** — the authentication service; issues JWTs (and a remember-me cookie) and
  exposes an API for obtaining tokens without a browser.
- **Scenario** — one end-to-end user flow expressed as an automated test (e.g. "create a
  program"). A scenario may have a browser variant and a GraphQL-level variant.
- **Regression subset** — the fast set of scenarios run frequently to detect breakage.
- **Performance set** — the load-test scenarios run nightly against a deployed
  environment, simulating hundreds of concurrent users.
- **Test run** — one execution of a suite against one environment, starting from a fresh
  database for regression runs; the unit that dashboards and traces are grouped by.
- **Fresh database** — an empty Postgres brought to schema by migrations alone; no
  reference data. Scenarios create all data they need.
- **Guest VU** — a load-test virtual user whose identity is a fresh SSO guest, created
  via `auth-as-guest` at ramp start; it self-seeds its own working set and refreshes its
  JWT via its session cookie. Replaces the earlier "test-user pool" concept for v1;
  a bootstrapped standard-user pool returns with role-diverse scenarios (phase 2).
- **Ephemeral stack** — the throwaway deployment (odb + Postgres + Explore + auth) booted
  inside CI for a regression run and discarded after.
- **Load target** — the persistent, Heroku-deployed environment the performance set
  points at.
