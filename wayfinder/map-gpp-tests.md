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

## Frontier now

Open, unblocked, unclaimed: **011** (create the org repo), **016** (AWS automation),
**017** (standard users + proposal loop), **021** (Observe execution VUs + seed),
**022** (graphql-ws client + subscribers), **023** (surge SLOs + verdict), **024**
(telemetry stack, HITL), **027** (read production sizing, HITL). Order of build:
021 → 022 → 017 → 018/023, developed locally; 016 in parallel.

## Not yet specified

- **Subscription round-trip SLO** — a provisional figure once 022 measures one.
- **Cross-VU fan-out lag** — an editor's mutation observed by *other* subscribers;
  needs a correlation channel k6 does not have. Follow-up after v1.
- **Trend-run threshold recalibration** — baselines reset once the real target exists.
- **Post-deadline calibration** — capture telemetry at the next real CfP close (the
  H0-H4 queries in `research/cfp-deadline-telemetry.md`) and adjust the surge model;
  depends on the span-attribute ask (019) landing upstream first.
- **Observe stall budget confirmation** — take the first surge run's numbers to the
  Observe developers and replace the provisional figures.
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
