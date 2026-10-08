---
labels: [wayfinder:map]
title: Graduate the prototype into gpp-tests
---

# Graduate the prototype into gpp-tests

Tracker: local markdown, same conventions as [map.md](map.md): tickets live in
`wayfinder/tickets/`, one file each, frontmatter `status` (open/closed), `assignee`
(the claim — empty = unclaimed), `blocked-by` (ticket ids). A ticket is on the
**frontier** when open, unassigned, and everything in `blocked-by` is closed.
This map's tickets start at **011**.

## Destination

The prototype graduates into **gemini-hlsw/gpp-tests** — one public production repo
holding the browser, GraphQL, and load suites, separated internally, **load suite as
the front door** — migrated and green in CI. Stress first: an on-demand **surge run**
answering *"under expected end-of-CfP load — proposals arriving at deadline rate while
both telescopes execute sequences through Observe — does the odb keep observation
execution within its stall budget, proposal submission usable, and regular operations
within spec?"*, in a realistic tier and a ceiling tier, alongside the nightly trend run.
The prototype (`cquiroz/gpp-tests`, this repo) stays frozen as the archive once the
`surge` branch has moved across.

## Notes

**Execution override:** unlike the first map, this one *does*, not just decides —
tickets deliver code, infra, and CI, not only decisions.

Domain glossary: `CONTEXT.md`. Design baseline: `gpp-testing-system-spec.md` (M1–M3
implemented in the prototype; M4 — the load target — was never provisioned; the
`performance.yml` nightly currently no-ops). HITL tickets: always invoke `/grilling`
and `/domain-modeling`.

Settled during charting (constraints for every ticket):
- **One repo, not three** — reaffirmed 2026-09-07 ([ticket 020](tickets/020-decide-stress-first-placement-and-surge-claim.md))
  when a split or a move into `lucuma-odb` was reconsidered for the stress priority.
  The suites stay together: the shared operations library (`lib/odb-operations.js`), the
  scenario-parity catalog, the `run-data` branch, and the Grafana wiring survive intact.
  `lucuma-odb` gets a dispatch step at most.
- Repo: `gemini-hlsw/gpp-tests`, **public**, fresh history; README points back here.
  Until then, stress work lands on the **`surge` branch of this repo**, pushed to
  `cquiroz/gpp-tests` for CI, and migrates with main in one move (012).
- The load suite carries **two profiles, both claims stand**: the nightly trend run
  and the on-demand surge run (the flagship of this effort).
- **Standard users in k6 are in scope** — surge traffic is proposal traffic, and
  guests cannot touch proposals. PIs submit and hold Explore subscriptions; staff drive
  Observe's browser; Observe's server uses the service JWT. Identities are per-VU.
- **Observe execution and websockets are in v1.** The time-critical operation is
  observation execution while proposals are accepted; execution VUs reproduce Observe's
  call order and transport split; subscriber VUs hold live `graphql-transport-ws`
  subscriptions. Websocket support is "crucial", not phase 2.
- Surge realism anchors on **two tiers**: realistic (100–250 submission mutations/h,
  100–200 Explore subscribers, 2 Observe instances) and ceiling (500/h, 4 Observe
  instances). Research (014) finds a whole semester is ~417 proposals; 500/1h is a
  stress ceiling, not a peak. Both run 75 minutes (10 ramp, 60 steady, 5 drain).
- **Surge SLOs are absolute**, per traffic class, in one file; the trend run keeps its
  ledger-derived thresholds. The Observe stall budget is provisional until Observe
  developers have seen real numbers.
- **Target:** iterate on the AWS compose target (only proven 200-VU environment), k6
  from a generator on AWS, workflow-driven; the production-shaped Heroku target comes
  later, for the capacity claim, once production sizing is read.
- **Telemetry:** server-side metrics and traces are in scope (the "why"); preferred home
  is a separate paid Grafana Cloud stack, fallback self-hosted on the box. The shared
  free stack's budget is production's.
- Runs fire **on demand and before promoting the odb** (manual dispatch with digests);
  never per merge. The ticket 010 dev-process items wait behind the stress work.
- **Proposal submission needs two attachments** (odb rule since 2026-09-07, caught by the
  nightly). Since 028 (2026-10-05) the stack and the load target have an object store —
  versitygw, or the real bucket through a re-signing proxy — and a stand-in for the Mailgun
  call the odb makes on every submission; the surge's proposal loop carries two uploads per
  proposal.

## Decisions so far

<!-- one line per closed ticket: gist + link -->

- [Research: production deployment shape and sizing](tickets/013-research-production-shape.md) —
  production is four Heroku apps (`lucuma-postgres-odb-production` running web+obscalc+
  calibration on one shared Postgres, `lucuma-sso-production`, `itc-production` with
  Redis, `lucuma-resource-production`) plus Hasura prefs; dyno/PG sizing lives only in
  the Heroku control plane — the research file lists the exact read-only commands
  (local CLI token is stale; `heroku login` may suffice) and who to ask.
- [Research: CfP-deadline production telemetry](tickets/014-research-cfp-deadline-telemetry.md) —
  there is nothing to mine: no real standard CfP has ever run on GPP (first is
  earliest 2027B; the only call, XT1, drew 10 proposals, data aged out). Evidence
  check: a whole semester is ~417 valid proposals, so **500/1h is a stress ceiling,
  not a realistic peak** — realistic final-hour peak ≈ 100 submission mutations/h
  with retract/resubmit churn. Capture plan for the next real call recorded.
- [Decide the surge workload model](tickets/015-decide-surge-workload-model.md) —
  folded into 020: two tiers, arrival-rate submissions, Observe and subscribers layered
  over the regular mix, absolute per-class SLOs.
- [Upstream ask: operation name on odb spans](tickets/019-upstream-operation-name-on-spans.md) —
  written as [`research/odb-ask-operation-name-on-spans.md`](../research/odb-ask-operation-name-on-spans.md)
  for Carlos to carry to the odb team; needed for the next CfP capture *and* for
  server-side attribution on the load target.
- [Decide where stress testing lives and what the surge run claims](tickets/020-decide-stress-first-placement-and-surge-claim.md) —
  no split, no move; stress first inside one repo on a `surge` branch. The surge claim
  now covers **Observe execution** (per-event mutations sent concurrently, blocking
  points modelled faithfully, step ODB overhead as the stall metric) and **websocket
  subscribers**, in a realistic and a ceiling tier, judged by absolute surge SLOs.
  AWS for iteration with scripted boot; production-shaped Heroku later for the
  capacity claim; Alloy on the target feeding a (preferably paid) Grafana stack.
- [Regression scenarios: an observation in every observing mode](tickets/030-observing-modes-regression-scenarios.md) —
  14 modes (11 calculated, visitor, Keck and Subaru exchange) as the fabricated PI, at both
  layers. k6 builds each mode from `lib/observing-modes.js`; the browser picks it in Explore and
  takes Explore's defaults. Green in the nightly since 2026-10-02. MOS (a mask upload) is
  unblocked by 028 and not yet built.
- [Observe execution VUs and the executable-observation seed](tickets/021-observe-execution-vus-and-seed.md) —
  built 2026-10-03 against lucuma-apps main of 2026-10-02 (background event sender, five
  blocking points): `ObserveInstance` in `k6/lib/execution.js`, six execution operations,
  `odb_step_overhead` and its per-point breakdown, seed as the service role with no state
  transitions needed. Green locally and in the regression suite (one step per night). The
  config read goes over HTTP until 022; the odb's memory growth under this traffic is a watch
  item for the first AWS run.
- [graphql-transport-ws client for k6 and the subscriber VUs](tickets/022-graphql-ws-client-and-subscriber-vus.md) —
  built 2026-10-03 on k6's own `k6/websockets`, no extension: `GraphqlWsClient` (connect,
  subscribe with resubscribe on reconnect, one-shot query judged like `gql`, ping/pong), the
  Explore-tab (8 subscriptions) and Observe-browser (3) subscriber VUs with churn, the execution
  VU's config read on its own socket, and a regression smoke. Local first numbers: ping p95
  10 ms, round trip from ack p95 47 ms, event latency from send p95 1 s under a starved odb.
- [Upstream: data-testids for Explore's observation configuration](tickets/031-upstream-testids-for-observation-configuration.md) —
  written here and merged as lucuma-apps#1623 (2026-10-01): mode picker, instrument filter,
  mode-table rows, Accept, sequence time and steps, visitor editor.
- [An object store for the stack, and attachment uploads in the test layers](tickets/028-object-store-and-attachment-uploads.md) —
  built 2026-10-05. versitygw in the compose stack (MinIO's public images are gone); on AWS
  the real `noirlab-gpp-tests` bucket through an aws-sigv4-proxy sidecar, because the odb
  pins region us-east-1 and static keys; `AWS_ENDPOINT_URL_S3` points the odb at either.
  `lib/attachments.js` builds the REST upload for both suites; the proposals lifecycle is
  back in e2e (upload, submit, reference, retract, by API and through Explore's buttons) and
  k6 uploads both files per run; first bucket-mode AWS run green 2026-10-06 (two objects
  through the proxy and the instance role, prefix deleted). Found on the way: the odb emails on every submission to a
  hardcoded Mailgun URL, so Caddy now answers as `api.mailgun.net`, records the mail and
  delivers nothing. Two upstream asks for Carlos: a configurable S3 region/endpoint, and a
  configurable Mailgun base URL.
- [Surge SLO file and the surge verdict](tickets/023-surge-slos-and-verdict.md) —
  built 2026-10-07. `k6/surge-slos.json` holds ticket 020's absolute criteria for five classes
  (execution, proposals, regular, subscriptions, errors) as k6 expressions by metric and tag;
  the surge scripts arm it verbatim, so the k6 exit code is the verdict, and
  `tools/surge-verdict.js` renders the same file against the summary export as one table per
  class — the job summary in CI, a Markdown file beside each JSON the AWS wizard collects,
  a Grafana annotation on breach. The subscription SLO is now picked (event latency p95 <
  500 ms, round trip p95 < 250 ms, nothing lost). Every figure is marked provisional in the
  file itself, with who still has to agree it.

## Frontier now

Open, unblocked, unclaimed: **011** (create the org repo), **016** (AWS automation — the
manual path is green under NOIRLab's us-west-2 procedure and the `surge` workflow is written
(2026-10-07); what remains is IT granting the OIDC role the workflow assumes, or a runner
inside `nl-vpc`), **018** (the surge profile is built and proven locally (2026-10-07,
`k6/surge.js`, `loadtest/aws-run.sh --surge`); what closes it is one full run per tier on
AWS, started from a laptop, and their verdicts recorded), **024** (telemetry stack, HITL),
**027** (read production sizing, HITL). 021 and 022 closed 2026-10-03, 028 closed 2026-10-05,
017 closed 2026-10-06, 023 closed 2026-10-07.

Off that order and already claimed: **029** (the `data-testid` contract ask to
lucuma-apps), carried upstream by Carlos rather than built here, as 019 was.

## Not yet specified

- **The surge SLO figures themselves** — every class in `k6/surge-slos.json` is marked
  provisional with who has to agree it: the execution stall budget (Observe developers), the
  submit latency (this project's choice), the subscription figures (picked from 022's first
  native run: event latency p95 < 500 ms, round trip p95 < 250 ms, nothing lost). The first
  surge run per tier (018) is where they get argued with real numbers.
- **Attachment sizes in the surge model** — 017 pads the fixture to 2 MiB (science) and
  512 KiB (team) per submission, an assumption, not a measurement
  (`PROPOSAL_ATTACHMENT_SIZES` in `lib/attachments.js`, overridable per run). Confirm against
  Explore's upload limit and real Phase I attachments at the next CfP close; the AWS wizard
  prints the count and bytes a run uploaded.
- **Deadline mix in the proposal loop** — 017's loop builds a new proposal per submission
  with `RESUBMIT_SHARE` (0.3) of later submissions being retract/edit/resubmit, and every
  proposal carries one observation it waits on obscalc for. At a real deadline most proposals
  already exist and the hour is edits, uploads and submits; 018 may pre-seed proposals during
  the ramp so the steady state is mostly churn, and the telemetry of the next CfP close
  (`research/cfp-deadline-telemetry.md`) calibrates the share.
- **Cross-VU fan-out lag** — an editor's mutation observed by *other* subscribers. 022 left a
  design: edits already carry the VU id and a timestamp in the subtitle, and all VUs share one
  k6 clock, so a collector VU subscribed across the subscriber programs can time any VU's edit
  from the payload, no external store. Follow-up after v1.
- **Execution overhead doubled on the 2026-10-07 odb builds — confirmed, for the odb team.**
  Six AWS runs on the 3rd to 6th: step ODB overhead p95 570–652 ms, RecordVisit p95 ~300 ms,
  every mutation p95 ~52 ms. Two runs on the 7th on two different `-dev` odb digests, same
  parameters: p95 1163 and 1260 ms, RecordVisit p95 982 and 885 ms, every mutation p95
  ~145 ms (median 28 → 52 ms). Inside the provisional budget, but a 2× step; candidates are
  upstream #3154 (natchez → otel4s on every request) and #3145 (visits spend tellurics).
  Handoff with digests, numbers and a bisect recipe: `research/execution-overhead-2026-10-07.md`.
  Carlos carries it, as with 019.
- **Trend-run threshold recalibration** — baselines reset once the real target exists.
- **Post-deadline calibration** — capture telemetry at the next real CfP close (the
  H0-H4 queries in `research/cfp-deadline-telemetry.md`) and adjust the surge model;
  depends on the span-attribute ask (019) landing upstream first.
- **Observe stall budget confirmation** — take the first surge run's numbers to the
  Observe developers and replace the provisional figures.
- **odb memory growth — resolved 2026-10-03, not a leak.** The image's launcher pins the heap at
  the container limit minus at most 1 GiB (`-Xms = -Xmx`), so resident memory climbs until the
  whole heap has been touched; the wizard now caps the load target's odb heap at 60 % of its
  container, and `ODB_JAVA_OPTS` does the same locally. Details and the formula in
  `research/odb-memory-growth-handoff.md` (ticket 021).
- **Dev-process integration in gpp-tests** — the per-merge Explore lane, Slack alerts,
  and promote gate decided in [ticket 010](tickets/010-decide-dev-process-integration.md)
  still need to be built, after the stress work.
- **Archiving the prototype (`cquiroz/gpp-tests`) on GitHub** — once the org repo is
  green and the suites are gone.
- **Distributed k6 / dedicated generator** — only if the surge scale outgrows one
  generator instance.

## Out of scope

- **Absolute-capacity hunting** — a knee run is a diagnostic, not a standing profile;
  the surge run's claim is "handles expected deadline load".
- **Splitting into multiple repos, or moving into `lucuma-odb`** — rejected during
  charting, reconsidered and rejected again in 020.
- **Load-testing SSO itself** — carried over from the first map.
- **Rewriting the load suite in the odb's toolchain** (Gatling/Scala) — proven k6 work,
  no measurement gain.
- **Driving the real Observe application** — execution VUs simulate its ODB traffic.
