# gpp-tests — automated cross-system testing for GPP

Three suites against the GPP (lucuma) ecosystem — the odb GraphQL backend, the Explore
frontend, SSO, ITC and obscalc — designed in
[`gpp-testing-system-spec.md`](gpp-testing-system-spec.md) and steered by the map in
[`wayfinder/`](wayfinder/map-gpp-tests.md):

- **Browser and GraphQL regression** (daily): boot the whole stack from an empty database in
  CI and prove the user journeys still work on latest `main`. Every scenario runs at both
  layers unless the parity catalog says why not.
- **Load** (nightly **trend run**, claim *"tonight is slower than last night"*; on-demand
  **surge run**, claim *"the odb keeps executing observations and accepting proposals under
  end-of-CfP load"* — the surge is specified, not yet built).

Open-source tooling only (Playwright, k6, Docker Compose, GitHub Actions), results in a
Grafana Cloud stack. Vocabulary is in [`CONTEXT.md`](CONTEXT.md); read it first.

## Layout

| Path | What lives there |
|---|---|
| `lib/` | Pure, dependency-free modules shared by **both** suites — GraphQL operations, endpoints, metric-label budget, run summaries, threshold calibration, annotations, and the scenario parity catalog (`scenario-catalog.js`: every scenario runs in both suites unless its entry says why not; enforced by `npm run check`). Unit-tested; imported directly by k6 and by Playwright. |
| `schema/` | Vendored `OdbSchema.graphql`, so every operation is schema-validated offline ([why](schema/README.md)). |
| `stack/` | The ephemeral regression stack: `docker-compose.yml`, Caddy config, bootstrap scripts (spec §3). |
| `tests/` | The Playwright journey (spec §5) and its support layer. Selectors are all in `tests/support/selectors.ts`. |
| `k6/` | The k6 suites: `regression.js` (scenario variants) and `load.js` (the 200-VU model), plus their libs. |
| `tools/` | The small CLIs CI drives: verify operations, compute thresholds, write the run summary, post annotations. |
| `grafana/` | The custom dashboard and the Grafana Cloud setup notes ([README](grafana/README.md)). |
| `loadtest/` | Provisioning for the persistent Heroku load target ([README](loadtest/README.md)). |
| `.github/` | `regression.yml`, `performance.yml`, the shared boot-stack action, and their scripts. |
| `wayfinder/`, `research/` | Where every decision came from. Read these before changing a decision. Includes the [AWS load-target design note](research/aws-load-target-options.md). |

## Prerequisites

Node 20+, Docker, `git`, `gpg`, `openssl`, `jq`, [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/),
and a `HEROKU_API_KEY` with access to the lucuma `-dev` apps (the service images are only in
Heroku's private registry).

Everything except Docker is provided by the flake — with direnv, `cd` into the repo and you
have it; otherwise `nix develop`. Docker stays out on purpose: the daemon is host-managed, and
a nixpkgs `docker` would shadow Docker Desktop's CLI without the Compose v2 plugin these
scripts call as `docker compose`. See the comments in `flake.nix`, including the NixOS-only
step for Playwright's browser.

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

## Status

- **Regression path: complete and green.** Stack boots in CI from empty, 17 e2e tests and the
  k6 regression pass nightly on
  [cquiroz/gpp-tests](https://github.com/cquiroz/gpp-tests/actions). The one red night so far
  (2026-09-07) was the odb changing a rule under the suite, caught within a day.
- **Load target: not provisioned.** The 200-VU profile has run once, by hand, on AWS
  (clean at 200 VUs). `performance.yml` exits green with a notice until the `LOADTEST_*`
  repository variables exist; no baseline nights have been captured.
- **Now:** stress testing first. Open work, in order, is listed under *Frontier now* in the
  [map](wayfinder/map-gpp-tests.md); the decision behind the order is
  [ticket 020](wayfinder/tickets/020-decide-stress-first-placement-and-surge-claim.md).

## Where decisions live

| Question | Read |
|---|---|
| What does a word mean here? | [`CONTEXT.md`](CONTEXT.md) |
| What is the system meant to be? | [`gpp-testing-system-spec.md`](gpp-testing-system-spec.md) |
| Why is it built this way, and what is next? | [`wayfinder/map-gpp-tests.md`](wayfinder/map-gpp-tests.md) and its tickets; the first map is [`wayfinder/map.md`](wayfinder/map.md) |
| What did the research find? | [`research/`](research/) — one file per question, dated |
| How was the prototype proven, and what broke on the way? | [`research/prototype-status-2026-08.md`](research/prototype-status-2026-08.md) |
| What does each scenario cover, and what is missing? | [`tests/COVERAGE.md`](tests/COVERAGE.md) |

## Production safety

The load tooling resets databases, deploys images and rescales dynos on the account that also
owns production. Two independent rails, both failing closed:

- [`loadtest/guard.sh`](loadtest/guard.sh) gates every Heroku operation: the app name must end
  in `-loadtest`, must not contain `production`/`staging`/`-dev`, and must carry a marker
  config var only `provision.sh` sets. Reasoning and the one gap code cannot close (token
  scope) are in [loadtest/README.md](loadtest/README.md#safety-how-this-is-kept-away-from-production).
- [`lib/load-target.js`](lib/load-target.js) gates the host k6 sends load at: it must carry a
  `loadtest` label or be the local stack, enforced by k6 at init and by `performance.yml`
  before the release step. It matches hostnames, so it moves to AWS unchanged.

The regression path never calls the Heroku CLI: it pulls images from the `-dev` registry and
nothing else.

## Secrets

`HEROKU_API_KEY` is the only one without which nothing runs — the lucuma service images exist
solely in Heroku's private registry. Generate a **long-lived** token; `heroku auth:token`
returns a session token that expires and will break CI a few days later:

```bash
heroku authorizations:create -d "gpp-tests CI"   # copy the Token field
gh secret set HEROKU_API_KEY                     # or add it in Settings → Secrets
```

| Secret | Needed for |
|---|---|
| `HEROKU_API_KEY` | pulling the lucuma images; releasing and resetting the load target |
| `GC_PROM_RW_URL`, `GC_PROM_INSTANCE_ID`, `GC_PROM_TOKEN` | k6 metrics → Grafana Cloud |
| `GRAFANA_URL`, `GRAFANA_ANNOTATIONS_TOKEN` | run annotations |
| `ODB_OTEL_ENDPOINT`, `ODB_OTEL_KEY` | optional: ODB traces from the ephemeral stack |

**No real user credentials exist.** Test identities are SSO guests (spec §4) or standard
users fabricated per run by `stack/scripts/create-standard-users.sh` (PI and staff, no ORCID);
both live only as long as the stack does.

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
  else references Explore's DOM. Playwright writes an aria snapshot of the page to
  `test-results/<test>/error-context.md` on failure, which lists every role and accessible
  name that *was* on screen; that is usually faster than opening the trace.
- **A step fails because "something intercepts pointer events".** A modal is still open —
  Explore's dialogs keep a mask over the whole page. Close it before moving on.
- **Playwright says "Executable doesn't exist" under Nix.** An inherited
  `PLAYWRIGHT_BROWSERS_PATH` points into the read-only store with a mismatched browser
  revision. The devShell redirects it to `.playwright/`; run `npx playwright install chromium`.
  Set `GPP_TESTS_KEEP_BROWSERS_PATH=1` to keep your own path instead, and `GPP_TESTS_QUIET=1`
  to silence the shell banner.
- **A metric label was rejected.** That is `lib/tags.js` doing its job; add the dimension to
  the annotation instead, or take the series budget hit knowingly.
