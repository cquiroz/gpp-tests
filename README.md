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
| `fixtures/` | Files the suites upload: the proposal-attachment PDF both Playwright and k6 send through the ODB's REST route (`lib/attachments.js`, ticket 028). |
| `stack/` | The ephemeral regression stack: `docker-compose.yml`, Caddy config, bootstrap scripts (spec §3). |
| `tests/` | The Playwright journey (spec §5) and its support layer. Selectors are all in `tests/support/selectors.ts`. |
| `k6/` | The k6 suites: `regression.js` (scenario variants), `load.js` (the 200-VU model), `execution.js` (Observe instances executing sequences, ticket 021), `subscribers.js` (held websockets with churn, ticket 022) and `proposals.js` (PIs submitting proposals at a literal rate, ticket 017), plus their libs, including the graphql-transport-ws client and the standard-user pool. |
| `tools/` | The small CLIs CI drives: verify operations, compute thresholds, write the run summary, post annotations. |
| `grafana/` | The custom dashboard and the Grafana Cloud setup notes ([README](grafana/README.md)). |
| `loadtest/` | The AWS load target: `aws-run.sh` (the standard unattended run), `aws-first-run.sh` (the wizard behind it), `guard.sh`; plus the deferred Heroku design ([README](loadtest/README.md)). |
| `.github/` | `regression.yml`, `performance.yml`, the shared boot-stack action, and their scripts. |
| `ARCHITECTURE.md` | The high-level picture: suites, hosts, how they interact and where each runs, with diagrams. Start here. |
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
source stack/.env.standard-users   # the fabricated PI, for the observing-modes scenario
npm run k6:regression              # the same scenarios at the GraphQL layer
npm run stack:down                 # or CLEAN=1 ... to delete generated keys and caches too
```

`npm run stack:up` is idempotent and prints every URL it brings up. It needs one `sudo` to add
six hostnames to `/etc/hosts` (`SKIP_HOSTS=1` to skip; `stack/scripts/hosts.sh` adds any that
are missing, such as `mail.` on a machine set up before ticket 028). Everything it generates — the Postgres
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

On AWS, unattended, from this laptop — the regression suite, the execution profile and the
subscriber population against the AWS pair, the pair stopped at the end or on any failure, the
run logged to `out/` (`--load` adds the 40-minute trend profile, `--help` lists the rest):

```bash
loadtest/aws-run.sh
```

Observe execution on its own — N Observe instances executing seeded GMOS observations as the
service identity, reporting the step ODB overhead and its breakdown by blocking point
(`k6/lib/execution.js`, [ticket 021](wayfinder/tickets/021-observe-execution-vus-and-seed.md)):

```bash
source stack/.env.generated
OBSERVE_INSTANCES=2 STEP_SECONDS_MIN=5 STEP_SECONDS_MAX=10 DURATION=3m npm run k6:execution
```

Subscribers on their own — a steady population of Explore tabs and Observe browsers holding
graphql-transport-ws subscriptions, users coming and going beside them, each measuring the round
trip from its own edit to the event on its socket (`k6/lib/subscribers.js`,
[ticket 022](wayfinder/tickets/022-graphql-ws-client-and-subscriber-vus.md)):

```bash
source stack/.env.generated && source stack/.env.standard-users
SUBSCRIBERS=20 CHURN_VUS=5 DURATION=5m SESSION_SECONDS=120 npm run k6:subscribers
```

Proposals on their own — PIs from the standard-user pool submitting against one Call for
Proposals at a literal rate (an arrival-rate executor; `dropped_iterations` is the number that
says the rate was not met), each submission the whole lifecycle the ODB requires — program, PI
details, abstract, a defined observation, the proposal, two attachments at realistic sizes —
then retract/edit/resubmit churn (`k6/lib/proposals.js`,
[ticket 017](wayfinder/tickets/017-standard-users-and-proposals-in-k6.md)):

```bash
source stack/.env.generated
SUBMISSIONS_PER_HOUR=250 DURATION=10m npm run k6:proposals     # realistic tier; 500 is the ceiling
```

The pool itself (`stack/.env.standard-users.json`, 250 PIs and 4 staff by default) is written
by `stack/scripts/create-standard-users.sh` at bootstrap; `POOL_PI_COUNT` / `POOL_STAFF_COUNT`
size it, and it has to be at least as large as a run's VU count because each VU is its own
identity.

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

- **Regression path: complete and green.** Stack boots in CI from empty, 32 e2e tests and the
  k6 regression pass nightly on
  [cquiroz/gpp-tests](https://github.com/cquiroz/gpp-tests/actions). The one red night so far
  (2026-09-07) was the odb changing a rule under the suite, caught within a day.
- **Load target: AWS, one command, unattended.** `loadtest/aws-run.sh` boots the pair on
  NOIRLab's shared account under IT's us-west-2 procedure, runs the regression suite, 20 minutes
  of Observe execution and 10 minutes of websocket subscribers, collects the numbers and stops
  the pair, in about 55 minutes with nothing to type. Native figures so far: 200-VU profile
  p95 168 ms; execution step ODB overhead p95 ~600 ms; subscription event latency p95 78 ms;
  all with 0 errors. A workflow-driven run waits on IT granting CI an identity
  ([ticket 016](wayfinder/tickets/016-automate-aws-load-target.md)); `performance.yml` still
  exits green with a notice until the `LOADTEST_*` repository variables exist.
- **Proposals submit again ([ticket 028](wayfinder/tickets/028-object-store-and-attachment-uploads.md), 2026-10-05).**
  The stack has an object store for attachments — versitygw locally and in CI, the real
  `noirlab-gpp-tests` bucket through a re-signing proxy on the AWS target — and a Mailgun
  stand-in in Caddy, because the odb emails on every submission. Both suites upload the two
  required attachments through the odb's REST route; the e2e lifecycle (upload, submit, minted
  reference, retract — by API and through Explore's buttons) is back, and the spec asserts the
  submission email reached the stand-in. No email can leave the stack.
- **Proposals at a rate ([ticket 017](wayfinder/tickets/017-standard-users-and-proposals-in-k6.md), 2026-10-06).**
  Bootstrap fabricates a pool of 250 PIs and 4 staff in the SSO database, one identity per
  load VU; `k6/proposals.js` has staff open a call and PIs submit against it on an
  arrival-rate executor, each submission a program with a defined observation, two padded
  attachments (2 MiB + 512 KiB) and the submit, with retract/edit/resubmit churn. First local
  run at the realistic tier's 250 per hour: 17 submissions, none dropped, submit p95 0.96 s,
  uploads p95 0.1 s. The subscriber VUs draw their identities from the same pool. The
  lifecycle is green on AWS too (2026-10-07), after a truststore fix the first AWS submission
  exposed ([ticket 028](wayfinder/tickets/028-object-store-and-attachment-uploads.md)).
- **Watch item (2026-10-07): execution step overhead doubled on the day's odb image.** Six AWS
  runs on the 3rd to 6th gave p95 570–650 ms; the 7th, with a new `-dev` odb digest and the
  same parameters, gave p95 1163 ms, p99 2080 ms, every blocking point and every mutation
  about twice as slow. One more run decides whether it is the image or the day.
- **Now:** stress testing first. Open work, in order, is listed under *Frontier now* in the
  [map](wayfinder/map-gpp-tests.md); the decision behind the order is
  [ticket 020](wayfinder/tickets/020-decide-stress-first-placement-and-surge-claim.md).

## Where decisions live

For the picture of how it all fits together, read [`ARCHITECTURE.md`](ARCHITECTURE.md) first.

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
- **The odb container is OOM-killed (exit 137) under load.** Its launcher pins a heap of the
  container limit minus ~600 MB, which under amd64 emulation on a Mac is too little room for
  everything else. Boot with `ODB_JAVA_OPTS='-Xms768m -Xmx768m'` (or a larger `ODB_MEM_LIMIT`);
  the reasoning is in `research/odb-memory-growth-handoff.md`.
- **A metric label was rejected.** That is `lib/tags.js` doing its job; add the dimension to
  the annotation instead, or take the series budget hit knowingly.
- **Submitting a proposal fails with `email_send_error`.** The odb reached something other
  than the stack's Mailgun stand-in, or its JVM does not trust Caddy's CA. Bootstrap builds
  `stack/certs/cacerts` (image CAs plus Caddy's root) *before* starting the odb; an odb started
  by hand before that file existed needs `npm run stack:up` again. What the odb handed to the
  stand-in is at `https://mail.gpp-test.internal/mailgun.log` (`tests/support/mail.ts` reads it).
- **Submitting a proposal answers HTTP 500 "Internal server error", uploads fine.** The odb
  could not complete the TLS handshake to the stack's Mailgun stand-in: the truststore it
  boots with (`stack/certs/cacerts`) does not hold *this* stack's Caddy root. Bootstrap's log
  will show `java-truststore.sh` failing — it now stops bootstrap rather than keeping a stale
  store — or a `cacerts` copied in from another machine. Rebuild with
  `bash stack/scripts/java-truststore.sh` and recreate the odb container. On 2026-10-07 the
  AWS target had the laptop's store (synced with the repo) and every submission failed this way.
- **An attachment upload answers 500.** The object store is down or the odb points elsewhere:
  `docker compose ps s3` in `S3_MODE=local`, the `s3proxy` logs in bucket mode; the odb's
  endpoint is `AWS_ENDPOINT_URL_S3` in its environment (`stack/docker-compose.yml`).
