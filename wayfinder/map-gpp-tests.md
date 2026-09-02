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

The prototype graduated into **gemini-hlsw/gpp-tests** — one public production repo
holding the browser, GraphQL, and load suites, separated internally — migrated and
green in CI. Load suite first: a real, provisioned load target and an on-demand
**surge run** answering *"under expected end-of-CfP load (up to 500 proposals in the
final hour), does the system still handle regular operations?"*, alongside the nightly
trend run. odbattr stays frozen as the archive.

## Notes

**Execution override:** unlike the first map, this one *does*, not just decides —
tickets deliver code, infra, and CI, not only decisions.

Domain glossary: `CONTEXT.md`. Design baseline: `gpp-testing-system-spec.md` (M1–M3
implemented in the prototype; M4 — the load target — was never provisioned; the
`performance.yml` nightly currently no-ops). HITL tickets: always invoke `/grilling`
and `/domain-modeling`.

Settled during charting (constraints for every ticket):
- **One repo, not three.** The suites stay together: the shared operations library
  (`lib/odb-operations.js`), the scenario-parity catalog, the `run-data` branch, and
  the Grafana wiring survive intact. A multi-repo split was considered and rejected.
- Repo: `gemini-hlsw/gpp-tests`, **public**, fresh history; README points back here.
- The load suite carries **two profiles, both claims stand**: the nightly trend run
  and the new on-demand surge run (the flagship of this effort).
- **Standard users in k6 are now in scope** — surge traffic is proposal traffic, and
  guests cannot touch proposals (the old map's "phase 2" is pulled forward).
- Surge realism anchors on **up to 500 proposals in the last hour of a CfP**, layered
  over the regular-operations mix.
- Load-target platform/sizing is decided from **evidence of production's actual
  shape**, not assumed; surge cadence is on-demand, which reopens persistent-vs-
  ephemeral for the target.

## Decisions so far

<!-- one line per closed ticket: gist + link -->

## Not yet specified

- **Surge reporting** — which Grafana panels / summary artifacts a surge run publishes
  and how its pass/fail verdict is surfaced; sharpens once the workload model (015)
  and profile (018) exist.
- **Trend-run threshold recalibration** — baselines reset once the real target exists.
- **Post-deadline calibration** — adjust the surge model against telemetry from the
  next real CfP close.
- **Dev-process integration in gpp-tests** — the per-merge Explore lane, Slack alerts,
  and promote gate decided in [ticket 010](tickets/010-decide-dev-process-integration.md)
  still need to be built, now in the new repo.
- **Archiving odbattr on GitHub** — once gpp-tests is green and the suites are gone.
- **Distributed k6 / dedicated generator** — only if the surge scale outgrows one
  hosted runner.

## Out of scope

- **Absolute-capacity hunting** — the surge run's claim is "handles expected deadline
  load", not finding the breaking point.
- **Splitting into multiple repos** — rejected during charting; one repo.
- **Load-testing SSO itself** — carried over from the first map.
