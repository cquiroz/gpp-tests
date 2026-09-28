---
id: 030
title: "Regression scenarios: an observation in every observing mode"
labels: [wayfinder:task]
status: open
assignee:
blocked-by: []
---

## Question

The regression suites build observations in exactly one mode: GMOS North long slit
(`gmosNorthLongSlit()`, `lib/odb-operations.js:86`). The odb exposes 15 in
`ObservingModeInput` (`schema/OdbSchema.graphql:5908`). Prove every mode a PI can use still
produces an observation the odb can plan, daily, at both layers. Decided by `/grilling` on
2026-09-28:

- **Scope.**
  - *Full check* (sequence + time estimate): GMOS North/South long slit and imaging,
    Flamingos-2 long slit and imaging, GNIRS imaging, GNIRS spectroscopy (long slit and
    IFU), IGRINS-2 long slit, GHOST IFU.
  - *Create and read back only*: visitor, exchange (Keck, Subaru) — no calculation exists.
    Explore can create both, so they run at both layers too.
  - *Deferred*: GMOS North/South MOS, Flamingos-2 MOS — a custom mask is an upload, so
    they wait for [028](028-object-store-and-attachment-uploads.md). Recorded as one-sided
    (both sides `null`) in the catalog and in `tests/COVERAGE.md`.
- **Pass means a sequence and time estimates exist**, not `READY`. Poll up to **1 minute**
  per mode; `sequence_unavailable` means keep polling, an `itc_error` fails at once and puts
  the ITC's message in the failure.
- **Regular PI only**, the fabricated `TEST_PI`. k6 gains a reusable PI session: seed the
  jar's `lucuma-refresh-token` cookie with `TEST_PI_REFRESH_TOKEN` and reuse the existing
  `/api/v1/refresh-token` path in `k6/lib/auth.js`. Note on the proposal rows of the
  catalog that the PI-only part of their "no standard-user auth" blocker is gone; k6
  proposals are a separate ticket.
- **k6 side**: a hand-written fixture table in `lib/` (dependency-free, shared), one entry
  per mode — the `ObservingModeInput`, the matching science requirements (`spectroscopy`
  or `imaging` — `createObservation`/`setObservingMode` stop hard-wiring
  `spectroscopyRequirements()`), and a target per instrument family (optical, near-IR,
  GHOST/IGRINS-2 bright). The read-back selection covers every mode, not only
  `gmosNorthLongSlit`. One k6 scenario, with a `mode` tag (~13 values; check the budget in
  `lib/tags.js`).
- **Browser side**: `tests/e2e/observing-modes.spec.ts`, one test per mode
  (`observing mode: GMOS South imaging`, …). Seed program and per-family target via
  GraphQL, then **select the mode in Explore and accept its defaults**; assert the time
  estimate and sequence in the UI and by GraphQL read-back. The fixture table drives k6
  only — a mode green in k6 and red in the browser points at Explore's defaults, which is
  a finding. Needs the test ids from [031](031-upstream-testids-for-observation-configuration.md).
- **Parity**: one catalog row `observing-modes` listing every per-mode e2e title against
  the k6 scenario. `tests/COVERAGE.md` rows *Instrument configuration* and *Calculated
  results* updated.
- **Known failures**: a table entry may carry `expectedFailure: { reason, link }`; the test
  runs as `test.fail` (and the k6 check inverted), so the entry goes red once the mode
  starts passing and cannot go stale. No silent skips.
- **Schedule**: daily, in `regression.yml`, **at most 3 modes in parallel** (obscalc sits
  at 96% of its memory limit, `stack/docker-compose.yml:60-68`). Watch obscalc memory for
  the first nights; raise the limit if it runs out of memory.
- **Delivery**: develop the browser half against a locally built Explore
  (`EXPLORE_BUNDLE_DIR` + `Caddyfile.bundle`) carrying 031's ids; **both halves merge
  together** once 031 is deployed to Explore's dev hosting.

Resolution records the fixture table, any modes shipped as expected failures and why,
the first green nightly, and the added runtime and obscalc memory peak.
