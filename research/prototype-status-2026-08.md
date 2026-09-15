# How the prototype was proven — status as of August 2026

*Moved out of the README on 2026-09-15. Everything below was true when written (the dated
lines say when); it is kept because the bugs, the deviations and the "still untested" list
explain why the code looks the way it does. For what is true now, read the README's
**Status** section and [`wayfinder/map-gpp-tests.md`](../wayfinder/map-gpp-tests.md).*

## Milestones (spec §11)

- **M1** stack boots green — **done**, verified on macOS: all seven readiness checks pass,
  the CA is exported and image digests are recorded.
- **M2** journey green against it — **done**: all four scenarios pass in ~41 s, including the
  ITC/obscalc calculated-results assertion. `verify:operations` reports 12/12 and the k6
  regression suite is green.
- **M3** `regression.yml` green in CI — **done**, run
  [32863434794](https://github.com/cquiroz/gpp-tests/actions/runs/32863434794) on an
  `ubuntu-latest` runner: stack booted from empty, all four scenarios passed, k6 clean, and
  the summary was published to the `run-data` branch. Total 213 s. Email notification on
  failure is GitHub's default for scheduled runs and needs nothing configured.
- **M4** load target — tooling ready, **not yet provisioned**. `loadtest/provision.sh` creates
  the `lucuma-*-loadtest` app set: dry run by default, idempotent, and it refuses to scale
  dynos down while a run is in flight. It creates billable resources and needs create-app
  rights in the team, so a person runs it rather than CI. See
  [loadtest/README.md](../loadtest/README.md) for the sequence, the cost and the caveats. Until
  the five `LOADTEST_*` repository variables are set, `performance.yml` exits green with a
  notice instead of emailing a failure every morning. Dynos sit at zero between runs and are
  scaled up per run, so a nightly costs roughly 20 dyno-hours a month rather than 720.
- **M5** baseline captured, thresholds armed — automatic: the first three nights write
  baseline-only summaries to the `run-data` branch, and `tools/compute-thresholds.js` arms
  thresholds from the fourth night on.

## What is verified

The whole regression path has now been run end to end against a real stack (macOS, Docker
Desktop, images pulled from Heroku's registry):

- `stack/scripts/bootstrap.sh` from empty → seven readiness checks green.
- `npm run verify:operations` → **12/12** operations against the live ODB.
- `npx playwright test` → **4/4 scenarios**, ~41 s, including the calculated-results
  assertion that proves ITC and obscalc are alive.
- `k6 run k6/regression.js` → all checks pass, zero GraphQL errors.

Six bugs that only a real boot could expose, all fixed:

1. **Hasura refused to start.** `HASURA_GRAPHQL_UNAUTHORIZED_ROLE` requires an admin secret;
   with none set, Hasura is already fully open, which is what Explore needs. Setting it was
   fatal — and Explore hangs forever after login without prefs.
2. **obscalc raced the ODB's migrations** and exited 1 (`Relation "t_time_estimate" does not
   exist`). The ODB binds its port only after Flyway finishes, so `depends_on:
   service_healthy` against a `/dev/tcp` healthcheck is an exact gate. Nothing probed obscalc
   during readiness either, so its death was silent; there is now a check for it.
3. **A stale service JWT.** Bootstrap reused an `ODB_SERVICE_JWT` inherited from the shell,
   signed by a previous stack's keypair. It surfaced only inside obscalc as
   `java.security.SignatureException: Bad signature length: got 512 but was expecting 256`.
   The token is now always minted fresh and validated (`lib/service-jwt.js`).
4. **The GMOS fixture was physically unobservable.** An r' filter (~550–700 nm) at the
   fixture's 500 nm central wavelength blocks the light; the ITC rejected every observation
   with "Insufficient signal at 500.0 nm". Verified against the live ITC that this was the
   only cause — the fixture now sets no order-blocking filter.
5. **Asynchronous results read as failures.** obscalc computes the digest in the background,
   and until it lands the ODB answers with a `sequence_unavailable` *error*, not a null. Both
   the k6 suites and `verify-operations` treated that as a failure; it would also have pushed
   the nightly load run below its check-rate floor.

6. **The `[pi]` journey waited for a dialog Explore had no reason to show.** With no program
   id in the URL, Explore branches on what the user can *see*: a user who can see no programs
   gets one auto-created and is routed to it, and only a user who can see some gets the
   Proposals & Programs popup (`ExploreLayout.scala`). A freshly fabricated PI owns nothing, so
   it took the first branch and the popup never appeared. The retry then passed — because the
   failed attempt had left the PI owning the program Explore made for them — so the run stayed
   green and reported flaky, and `staff` hid the bug entirely by seeing every program in the
   ODB. Two CI runs failed identically before this was understood. Scenario 2 now opens the
   dialog itself from whichever landing it finds (the toolbar's "Manage Programs" item is gated
   on a program being selected, not on the kind of user), and takes its "which program did I
   create" baseline with the dialog open rather than at login, where it raced that same
   auto-creation.

Four of the five Explore selectors also turned out to be wrong, now corrected against the
running app: the toolbar menu has no accessible name (it is the last toolbar button), the
target button is "Add a target" (not "Add Target"), creating a program leaves a modal whose
mask blocks everything until the new program's **Select** is clicked, and the subtitle is
edited through a pencil button rather than by clicking the text.

Verified offline, before any of that:

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

## Still untested against the real thing

1. **The load target (M4)**, which does not exist yet — so `performance.yml`, the threshold
   arming path, `provision.sh` and `release-loadtest.sh` have only been exercised as dry runs
   or against a stubbed `heroku` CLI. The 200-VU profile has never run against Heroku dynos.
   It *has* now run against an EC2 target, by hand: three runs on 2026-08-27, one of them
   clean at 200 VUs with zero failures — see
   [aws-load-target-options.md](aws-load-target-options.md) for what they measured and
   [aws-nightly-automation.md](aws-nightly-automation.md) for automating that instead.
2. **The dashboard's regression panel** — the rest is now **verified**. A live load run on
   2026-08-27 streamed to Grafana Cloud and five of the six **GPP test results** panels drew:
   read/write p95 by operation, error rate, scenario duration and GraphQL errors. The `_p95`
   suffixes are correct for k6 v2 *provided* `K6_PROMETHEUS_RW_TREND_STATS` is set — without it
   k6 emits p99 only and every p95 panel would render blank, which is why `performance.yml`
   sets it explicitly. The exception is **Regression scenario pass rate**, which queries
   `suite="regression"` series that nothing ever pushes: `regression.yml` runs k6 without
   `-o experimental-prometheus-rw`, so that panel is blank by construction. Either enable
   remote write there or drop the panel and let the `run-data` ledger be the regression record.
3. **A failing run.** Every CI run so far has been green, so the red paths — artifact upload,
   the failure email, a threshold breach annotation — are untested end to end.
4. **Explore's selectors will drift.** They are correct against lucuma-apps `main` as of the
   runs above, but four of five were wrong on the first attempt — this is the part of the
   suite most likely to break, and why spec §10 asks lucuma-apps for `data-testid`. They are
   all in `tests/support/selectors.ts`.

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
   Scenario 4 seeds its starting subtitle the same way, so the step under test is an edit of
   an existing value; the badge picking that change up also exercises Explore's
   `observationEdit` subscription.
7. **The journey is four tests in a serial block**, not one test with four steps, so the ledger
   gets per-scenario pass/fail and duration (which §7 needs). A retry still re-runs the whole
   chained journey from a fresh guest.
8. **Playwright artifacts are uploaded on a retried pass as well as on a failure**, where §8
   says failure only. A flaky run is the case where the trace is the *only* evidence — the run
   stays green, so `failure()` never fires and the artifacts are discarded. Bug 6 above cost
   two CI runs and a source read for want of one screenshot.

## Since then (September 2026)

- **The red path fired for real.** The nightly regression of 2026-09-07 went red when the
  `-dev` odb started requiring a Science and a Team attachment to submit a proposal; the
  failure text named the new rule, the artifacts uploaded, and the fix landed the same day
  (scenario 4 now asserts the refusal; [ticket 028](../wayfinder/tickets/028-object-store-and-attachment-uploads.md)
  restores the lifecycle once the stack has an object store). Item 3 of "Still untested" is
  therefore closed; the Slack path of ticket 010 is still unbuilt.
- **And again on 2026-09-10:** the odb began requiring an educational status and an affiliation
  on every investigator; scenario 4's "exactly two errors" assertion went red with four, five
  nights running until the fixture was extended on 2026-09-15. Two upstream rule changes in
  one week, both announced by the suite in the failure text.
- **The suite grew** from the four journey scenarios to 17 e2e tests (journey as guest, PI
  and staff; proposals; standard-user smoke) and six k6 regression scenarios, all held to one
  declared scenario set by `lib/scenario-catalog.js`.
- **Postgres needed 2 GiB, not 1.** A plain e2e run on macOS OOM-killed a backend at the
  1 GiB default; the compose file records the measured peaks and the new default.
- **The 200-VU profile ran on AWS** on 2026-08-27, by hand, clean — see
  [aws-load-target-options.md](aws-load-target-options.md). M4 remains *proven feasible, not
  achieved*: nothing is provisioned and `performance.yml` has never fired against a target.
  [Ticket 016](../wayfinder/tickets/016-automate-aws-load-target.md) makes it repeatable.
- **The project was renamed** from odbattr to gpp-tests on 2026-09-07, and re-charted for
  stress-testing first ([ticket 020](../wayfinder/tickets/020-decide-stress-first-placement-and-surge-claim.md)).
