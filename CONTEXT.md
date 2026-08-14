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
- **Test-user pool** — pre-created SSO users (one per virtual user at load) whose tokens
  are fetched via the SSO API at run start.
- **Ephemeral stack** — the throwaway deployment (odb + Postgres + Explore + auth) booted
  inside CI for a regression run and discarded after.
- **Load target** — the persistent, Heroku-deployed environment the performance set
  points at.
