# GPP Testing System Spec

**Status:** ready to implement · **Date:** 2026-08-17 · **Owner:** carlos.quiroz@noirlab.edu
**Derived from:** the wayfinder map in `wayfinder/map.md` — each section links the ticket
holding its full rationale. Research evidence lives in `research/`.

## 1. Purpose

Automated cross-system testing for the GPP (lucuma) ecosystem — the **odb** GraphQL
backend and the **Explore** browser frontend — with two jobs:

- **Regression detection**: a scheduled suite that boots the whole stack from scratch
  and proves the core user journey still works on latest `main`.
- **Load regression**: a nightly k6 run against a dedicated Heroku environment, whose
  claim is *"tonight is slower than last night"* — night-over-night trends, not
  absolute capacity.

Constraints honored throughout: open-source tooling only, cheap to run (GitHub Actions
+ Heroku), and all results flowing into the org's existing **Grafana Cloud** stack.

## 2. Tooling

| Concern | Choice | Why (ticket) |
|---|---|---|
| Browser tests | **Playwright** | trace viewer, auth-state reuse, parallel-safe, Apache-2.0 |
| API + load tests | **k6** (OSS) | native Prometheus remote-write into Grafana Cloud; Tempo trace propagation ([k6 pipeline research](research/k6-grafana-cloud-pipeline.md)) |
| Orchestration | **docker-compose** in this repo | same file locally and in CI ([stack ticket](wayfinder/tickets/003-decide-ephemeral-regression-stack.md)) |
| TLS in CI | **Caddy** internal CA | staging-mode SSO forces Secure cookies |
| CI | **GitHub Actions**, public repo | scheduled workflows, free minutes |

## 3. Ephemeral regression stack

Full detail: [Decide the ephemeral regression stack composition](wayfinder/tickets/003-decide-ephemeral-regression-stack.md).

One compose file boots, per run, from empty:

| Service | Image / source | Notes |
|---|---|---|
| postgres | `postgres:15` + lucuma-odb `test-cert/` | SSL **required** (Flyway `sslmode=require`); 3 empty DBs (`lucuma-odb`, `lucuma-sso`, `prefs`); **no** psql-init migrations |
| sso | `registry.heroku.com/lucuma-sso-dev/web:latest` | `LUCUMA_SSO_ENVIRONMENT=staging`, committed test-only GPG keypair, dummy ORCID creds; Flyway at startup |
| odb | `registry.heroku.com/lucuma-postgres-odb-dev/web:latest` | env per [deployment research](research/lucuma-deployment-shapes.md); dummy Cloudcube/Mailgun; Flyway at startup — every run also tests migrations from empty |
| itc | `registry.heroku.com/itc-dev/web:latest` | Redis omitted (optional off Heroku) |
| obscalc | `registry.heroku.com/lucuma-postgres-odb-dev/obscalc:latest` | needed for calculated-results assertions |
| hasura (prefs) | `hasura/graphql-engine` | **required** — Explore hangs after login without it ([evidence](research/explore-prefs-resource-deps.md)); migrations from `lucuma-apps/explore/hasura/user-prefs/`; naming-convention flags; unauthenticated |
| explore | static server | bundle fetched from Firebase **dev** hosting + our own `environments.conf.json` |
| caddy | TLS proxy, internal CA | `explore/sso/odb.gpp-test.internal` via runner `/etc/hosts`; Playwright trusts the CA, k6 `insecureSkipTLSVerify` |

Bootstrap: `docker login registry.heroku.com` with `HEROKU_API_KEY` → pull `:latest`
(-dev = latest main; record SHAs in run metadata) → one-off `create-service-user odb`
(mints `ODB_SERVICE_JWT` for odb/itc/obscalc) → up → ready when ODB GraphQL responds
and Hasura is healthy. Excluded: calibrations, resource service (unused by Explore).
Fallback if registry access breaks: `sbt docker:publishLocal` (temurin 25, 6 GB heap,
git-lfs). Real-certs fallback: Carlos's Cloudflare-managed domain.

## 4. Authentication: guests, zero credentials

Full detail: [Decide test-user pool provisioning and token fetch](wayfinder/tickets/006-decide-test-user-pool.md);
evidence: [guest visibility & refresh](research/guest-visibility-refresh.md).

- **Every test identity is an SSO guest** — browser journeys click "Continue as
  Guest"; k6 VUs `POST /api/v1/auth-as-guest`. No pre-created pool (the per-run DB
  reset would destroy one), **no test credentials anywhere**.
- Guests can create programs/observations/targets (verified in source) but see **only
  their own programs** — hence per-VU self-seeding (§6).
- 10-minute JWTs: each VU keeps its `lucuma-refresh-token` cookie in its k6 jar and
  refreshes ~every 8 min (verified headless — no CSRF/Origin checks).
- Phase 2 (with role-diverse scenarios): per-run bootstrapped standard users
  (SSO DB inserts + API keys + 3-hour exchange JWTs) — required for proposals.

## 5. v1 scenarios

Full detail: [Specify the v1 scenarios](wayfinder/tickets/004-specify-v1-scenarios.md);
GraphQL/UI grounding: [scenario map](research/v1-scenario-graphql-ui-map.md).

One chained Playwright journey (guest context, one step per scenario), each step
followed by a **direct GraphQL read-back assertion**:

1. **Login as guest** — logged-in shell renders; auto-created program exists.
2. **Create a program** — via Manage Programs dialog; appears in UI and `programs`.
3. **Create an observation** — with a **manual sidereal target** (hardcoded
   coordinates; no Simbad) and a minimal **GMOS long-slit** mode; assert stored state
   *and that calculated results appear* (the ITC/obscalc liveness check).
4. **Edit + read back** — change the subtitle, full page reload, assert persistence.

All four have k6 GraphQL variants (login = token fetch), plus Explore's real read mix:
`programs(OFFSET, includeDeleted:true)`, `program(id)` details, `observations`
pagination. Selector policy: role/text selectors now; migrate to `data-testid` as the
lucuma-apps ask (§10) lands. Playwright: 1 retry, retried passes reported **flaky**.

## 6. Load model

Full detail: [Decide the load-test workload model and target](wayfinder/tickets/005-decide-load-workload-model.md).

- **Target:** dedicated `lucuma-*-loadtest` Heroku apps (odb web + obscalc, sso, itc,
  one Postgres), released from the same `-dev` images right before each run.
  *(New infrastructure — implementation item M4.)*
- **State:** `pg:reset` → Flyway at boot → ramp doubles as seeding: each guest VU
  creates **3–5 programs with observations** before entering the measured loop.
- **Profile:** 0→50 VUs over 5 min, 50→200 over 10 min, **hold 200 for 20 min**, ramp
  down (~40 min).
- **Mix:** **60% reads / 40% writes**, think time 1–5 s; re-weight from production
  traces when available.
- **Thresholds:** first 3 nights baseline-only; then p95 read < 2 s, p95 mutation
  < 5 s, error rate < 1% (calibrated against baseline). Breach = red run + Grafana
  annotation.
- k6 runs on a hosted GitHub runner (recorded ceiling; distributed k6 is future work).

## 7. Observability

Full detail: [Design the Grafana dashboards and trace correlation](wayfinder/tickets/007-design-grafana-integration.md).

- **One Grafana Cloud stack** (the org's existing one). Test traffic carries
  `environment` = `loadtest` / `ephemeral`; both test environments set
  `ODB_OTEL_ENDPOINT/KEY` so failed-scenario traces land in Tempo.
- **Metrics path:** `k6 run -o experimental-prometheus-rw` → Grafana Cloud
  (instance-ID + Access Policy token). Labels capped at `operation`, `scenario`,
  `suite`, `status` — never testid/URLs (free-tier series budget).
- **Run identity:** `testid=<suite>-<github_run_id>` on k6 metrics + **Grafana
  annotations** at start/end/breach; k6 requests inject `traceparent`
  (jslib `http-instrumentation-tempo`) for per-request Tempo linking; Playwright
  correlates by annotation window in v1.
- **Dashboards:** official k6 (19665, 18030) + one custom **GPP test results**
  dashboard (nightly p95/op, error trend, pass/fail history) — JSON committed here.
- **Durable record** (free tier = 14-day metrics): ~1 KB per-run summary JSON
  committed to the `run-data` branch; also feeds threshold calibration.
- Regression runs push an end-of-run pass/fail + duration summary so both suites have
  history. No Grafana alerts in v1 — CI failure email is the single alerting path.

## 8. CI workflows

Full detail: [Decide the CI topology on GitHub Actions](wayfinder/tickets/008-decide-ci-topology.md).

| Workflow | Schedule | Steps |
|---|---|---|
| `regression.yml` | daily 07:00 UTC + `workflow_dispatch` | boot compose stack → Playwright journey → k6 regression variants → push summary |
| `performance.yml` | nightly 08:00 UTC | release loadtest apps from `-dev` → `pg:reset` → k6 load run → push summary |

Shared boot composite action; **queued concurrency groups** (never cancel — the
loadtest env must not be reset mid-run); failure notice by **email** (GitHub native;
optional Mailgun step for rich links); Playwright artifacts on failure only, 30-day
retention.

## 9. Secrets inventory

`HEROKU_API_KEY` (registry pull + loadtest app control), Grafana Cloud metrics
write token, Grafana annotations API token, optional Mailgun SMTP creds. **No test-user
credentials exist.** The SSO test GPG keypair is committed (protects nothing;
test-only).

## 10. Asks of the lucuma repos

1. **lucuma-apps:** add `data-testid` to the elements the v1 journey touches.
2. **lucuma-odb (SSO):** parameterize `Config.JwtLifetime` (already `TODO`) as an env
   var, default 10 min — test envs set it long, load scripts drop the refresh loop.
3. **lucuma-apps (nice-to-have):** publish the Explore bundle as a CI artifact so the
   stack stops fetching from Firebase hosting.

## 11. Rollout milestones

1. **M1** — compose stack boots green locally (readiness checks pass).
2. **M2** — Playwright journey green against the local stack.
3. **M3** — `regression.yml` scheduled and red/green in CI; email notifications live.
4. **M4** — loadtest Heroku apps provisioned; `performance.yml` runs the 200-VU
   profile; metrics visible in Grafana.
5. **M5** — 3-night baseline captured; thresholds armed; dashboards + `run-data`
   ledger in place. *v1 complete.*

## 12. Future work (from the map's fog)

Per-PR dispatch from lucuma-odb/lucuma-apps CI; role-diverse scenarios (standard/staff
users; unlocks proposals); catalog Target Search scenario (Simbad); WebSocket
subscriptions in the load mix; distributed k6; trend-based Grafana alerts; the other
lightly-used web apps; new-user signup flow; AWS environment for absolute capacity.

## 13. Out of scope

Load-testing SSO itself; the lucuma repos' own unit/integration CI; paid test SaaS.
