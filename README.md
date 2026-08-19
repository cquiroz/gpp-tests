# odbattr — automated cross-system testing for GPP

Two suites against the GPP (lucuma) ecosystem, per
[`gpp-testing-system-spec.md`](gpp-testing-system-spec.md):

- **Regression** (daily): boot the whole stack from an empty database in CI and prove the core
  user journey still works on latest `main`.
- **Load** (nightly): a k6 run against a dedicated Heroku environment whose claim is *"tonight
  is slower than last night"*.

Open-source tooling only, cheap to run (GitHub Actions + Heroku), results in the org's existing
Grafana Cloud stack.

## Layout

| Path | What lives there |
|---|---|
| `lib/` | Pure, dependency-free modules shared by **both** suites — GraphQL operations, endpoints, metric-label budget, run summaries, threshold calibration, annotations. Unit-tested; imported directly by k6 and by Playwright. |
| `schema/` | Vendored `OdbSchema.graphql`, so every operation is schema-validated offline ([why](schema/README.md)). |
| `stack/` | The ephemeral regression stack: `docker-compose.yml`, Caddy config, bootstrap scripts (spec §3). |
| `tests/` | The Playwright journey (spec §5) and its support layer. Selectors are all in `tests/support/selectors.ts`. |
| `k6/` | The k6 suites: `regression.js` (scenario variants) and `load.js` (the 200-VU model), plus their libs. |
| `tools/` | The small CLIs CI drives: verify operations, compute thresholds, write the run summary, post annotations. |
| `grafana/` | The custom dashboard and the Grafana Cloud setup notes ([README](grafana/README.md)). |
| `.github/` | `regression.yml`, `performance.yml`, the shared boot-stack action, and their scripts. |
| `wayfinder/`, `research/` | Where every decision came from. Read these before changing a decision. |

## Prerequisites

Node 20+, Docker, `git`, `gpg`, `openssl`, `jq`, [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/),
and a `HEROKU_API_KEY` with access to the lucuma `-dev` apps (the service images are only in
Heroku's private registry).

```bash
npm ci
npm run check          # typecheck + unit tests, no stack needed
```

## Running the regression suite locally

```bash
export HEROKU_API_KEY=...          # registry pull
npm run stack:up                   # ~10-20 min the first time: 900+ ODB migrations from empty
source stack/.env.generated        # endpoints, keys, service JWT, CA path
npm run verify:operations          # is the live ODB still the schema we compiled against?
npm run e2e                        # the four v1 scenarios
npm run k6:regression              # the same scenarios at the GraphQL layer
npm run stack:down                 # or CLEAN=1 ... to delete generated keys and caches too
```

`npm run stack:up` is idempotent and prints every URL it brings up. It needs one `sudo` to add
five hostnames to `/etc/hosts` (`SKIP_HOSTS=1` to skip). Everything it generates — the Postgres
certificate, the throwaway SSO keypair, the service JWT — is per-run and gitignored.

Useful switches: `SKIP_PULL=1` (use local images), `FORCE=1` (regenerate certificate and
keypair), `ODB_OTEL_ENDPOINT`/`ODB_OTEL_KEY` (ship ODB traces to Tempo), `CADDYFILE=./caddy/Caddyfile.bundle`
plus `EXPLORE_BUNDLE_DIR=...` (serve a locally-built Explore instead of Firebase dev hosting).

## Running the load suite

Against the load target (once it exists — see *Milestones* below):

```bash
export SUITE=load
export ODB_GRAPHQL_URL=https://<odb-loadtest>/odb SSO_URL=https://<sso-loadtest>
export GPP_THRESHOLDS="$(node tools/compute-thresholds.js --dir=.run-data)"
npm run k6:load
```

Against the local stack, shrunk to something you can watch:

```bash
source stack/.env.generated
SUITE=load STAGE_1=30s STAGE_2=30s STAGE_3=1m STAGE_4=10s VUS_LOW=5 VUS_HIGH=10 \
  SEED_PROGRAMS_MIN=1 SEED_PROGRAMS_MAX=2 npm run k6:load
```

## How the spec maps onto the code

| Spec | Where |
|---|---|
| §3 ephemeral stack | `stack/docker-compose.yml`, `stack/caddy/`, `stack/scripts/bootstrap.sh` |
| §4 guests, zero credentials | `k6/lib/auth.js`, `tests/support/odb.ts` (`GuestSession`) |
| §5 v1 scenarios | `tests/e2e/journey.spec.ts`, `k6/lib/scenarios.js`, `lib/odb-operations.js` |
| §6 load model | `k6/load.js`, `lib/thresholds.js`, `tools/compute-thresholds.js` |
| §7 observability | `k6/lib/metrics.js`, `lib/tags.js`, `lib/annotations.js`, `grafana/` |
| §7 durable record | `lib/summary.js`, `tools/write-run-summary.js`, `.github/scripts/publish-run-data.sh` |
| §8 CI | `.github/workflows/`, `.github/actions/boot-stack/` |

## Milestones (spec §11)

- **M1** stack boots green — code complete; needs one real run with a `HEROKU_API_KEY`.
- **M2** journey green against it — code complete; the selectors need their first live run
  (see *What still needs first contact*).
- **M3** `regression.yml` red/green in CI — workflow committed; enable Actions and add secrets.
- **M4** load target provisioned — **not done, and deliberately not automated.** Creating
  `lucuma-*-loadtest` (odb web + obscalc, sso, itc, one Postgres) is a one-off provisioning
  job; `.github/scripts/release-loadtest.sh` then releases today's `-dev` images into it every
  night. Until the repository variables `LOADTEST_ODB_APP`, `LOADTEST_SSO_APP`,
  `LOADTEST_ITC_APP`, `LOADTEST_ODB_GRAPHQL_URL` and `LOADTEST_SSO_URL` are set, the nightly
  workflow exits green with a notice instead of emailing a failure every morning.
- **M5** baseline captured, thresholds armed — automatic: the first three nights write
  baseline-only summaries to the `run-data` branch, and `tools/compute-thresholds.js` arms
  thresholds from the fourth night on.

## What is verified, and what still needs first contact

Verified by running it here:

- All 92 unit tests, including every GraphQL document and variable payload validated against
  the real `OdbSchema.graphql`.
- Both k6 suites executed end to end against a mock ODB/SSO (k6 v2.2.0): imports, the vendored
  Tempo instrumentation, the label budget, ramping VUs, per-VU seeding, the 60/40 mix, guest
  login, **and JWT refresh** — which is how we found that k6 resets the default cookie jar
  between iterations. Without the fix in `k6/lib/auth.js`, every VU would have silently become
  a *new* guest after 8 minutes and the read half of the mix would have gone hollow while still
  reporting green.
- `lib/summary.js` parses a real `k6 --summary-export` document: the shape is flat, and a
  threshold entry of `true` means **failed**.
- A deliberate negative run: with every mutation rejected at the GraphQL layer (HTTP 200 with
  an `errors` array), `http_req_failed` stays at 0% but the load suite's check-rate floor
  fails the run and the ledger records `outcome: "fail"`. That is the difference between a
  hollow night and a clean baseline.
- Certificate and GPG keypair generation, the `/etc/hosts` step, the lucuma-apps sparse
  checkout (48 prefs migrations), `record-images.sh` against a stubbed docker, compose config
  validation, and all workflow YAML.
- `environments.conf.json` generation against the live Firebase dev host — which is why the
  generator *merges* into the bundle's own conf: the real file carries `sso.readTimeoutSeconds`
  and `sso.expirationAnticipationSeconds`, fields no amount of source reading would have
  predicted.

Needs a real stack (no `HEROKU_API_KEY` or Docker daemon available here):

1. **The boot itself** — image pulls, Flyway from empty, `create-service-user odb`, Hasura
   applying the prefs migrations, Caddy's internal CA. Every step logs; failures print the
   relevant container logs.
2. **`serve` as the subcommand** for the sso and odb images (`SSO_COMMAND`/`command:` in the
   compose file if it is named differently).
3. **Explore's selectors** (`tests/support/selectors.ts`) — read from lucuma-apps `main` but
   never exercised. This is the single most likely thing to need a tweak, and it is one file.
   Spec §10 asks lucuma-apps for `data-testid` on exactly these elements.
4. **Grafana metric-name suffixes** — see [grafana/README.md](grafana/README.md).

## Deliberate deviations from the spec

Each of these is a judgement call, not an oversight:

1. **The SSO GPG keypair and the Postgres certificate are generated per run, not committed.**
   Functionally identical (both services read the same generated pair within a run), and
   nothing that looks like a private key ever lands in git.
2. **Explore is reverse-proxied from Firebase dev hosting**, with only `environments.conf.json`
   served locally, rather than downloading the bundle. Same "tracks main, no build in CI"
   property, far less to go wrong. `Caddyfile.bundle` covers the static-bundle case.
3. **Service-to-service traffic stays on plain HTTP inside the compose network**; only what the
   browser and k6 touch goes through Caddy's TLS. Otherwise every JVM container would need the
   internal CA installed to call SSO.
4. **`testid` is not a metric label.** Spec §7 says both "testid on k6 metrics" and "never
   testid" in adjacent bullets; ticket 007's reasoning (annotations carry run identity) wins,
   and `K6_TAG_TESTID=true` is the escape hatch.
5. **Playwright accepts the internal CA via `ignoreHTTPSErrors`** by default, because Chromium
   on Linux reads its own NSS store. `stack/scripts/trust-ca.sh` with `INSTALL_NSS=1` plus
   `PW_IGNORE_HTTPS_ERRORS=false` gives a strict-TLS run.
6. **Scenario 3 sets the target's coordinates and the GMOS long-slit mode through the API**,
   after creating both through the UI. Explore's coordinate editor and configuration tile have
   no stable selectors today, and the assertion that matters — calculated results appear, so
   ITC and obscalc are alive — is unaffected. The observation and the target are still created
   by clicking. This is the one place where browser coverage is narrower than §5 reads.
7. **The journey is four tests in a serial block**, not one test with four steps, so the ledger
   gets per-scenario pass/fail and duration (which §7 needs). A retry still re-runs the whole
   chained journey from a fresh guest.

## Secrets

| Secret | Needed for |
|---|---|
| `HEROKU_API_KEY` | pulling the lucuma images; releasing and resetting the load target |
| `GC_PROM_RW_URL`, `GC_PROM_INSTANCE_ID`, `GC_PROM_TOKEN` | k6 metrics → Grafana Cloud |
| `GRAFANA_URL`, `GRAFANA_ANNOTATIONS_TOKEN` | run annotations |
| `ODB_OTEL_ENDPOINT`, `ODB_OTEL_KEY` | optional: ODB traces from the ephemeral stack |

**No test-user credentials exist** — every test identity is an SSO guest (spec §4).

## Troubleshooting

- **The stack never becomes ready.** `stack/scripts/wait-for-ready.sh` names the checks that
  never passed and dumps the last 40 log lines. `sso` failing to boot is usually the keypair or
  the ORCID dummies; `odb` failing is usually `ODB_SERVICE_JWT`.
- **Explore hangs on a spinner after login.** The prefs (Hasura) websocket did not connect —
  Explore waits for *both* it and the ODB before rendering anything. Check
  `https://prefs.gpp-test.internal/healthz`.
- **`verify:operations` fails.** The deployed ODB moved past the vendored schema; refresh the
  snapshot ([schema/README.md](schema/README.md)) and fix `lib/odb-operations.js`.
- **A journey step times out on a selector.** Fix it in `tests/support/selectors.ts` — nothing
  else references Explore's DOM.
- **A metric label was rejected.** That is `lib/tags.js` doing its job; add the dimension to
  the annotation instead, or take the series budget hit knowingly.
