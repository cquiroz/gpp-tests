---
id: 010
title: "Decide how the suites integrate into the Explore/ODB development process"
labels: [wayfinder:grilling]
status: closed
assignee: carlos.quiroz
blocked-by: [009]
---

## Question

The spec's destination was reached and the suites run on schedule — now take them into
the products' development process. What is that integration *for* (pre-merge gating,
per-merge attribution, perf accountability, release confidence)? Who consumes a red run
and where do alerts go? Does test code stay in this repo, move into
`lucuma-apps`/`lucuma-odb`, or split? And how does any of it respect the map's standing
deferral — "per-PR wiring is phase 2, deliberately deferred until v1 scheduled runs
prove out" — while M4 (the load target) is still open and no red path has ever fired?

## Resolution

Grilled 2026-08-27/29. New glossary terms in `CONTEXT.md`: **per-merge run**,
**release-confidence run**, **advisory**, **testid contract**.

- **Goals: per-merge attribution and release confidence** — not pre-merge gating. A red
  run should name its commit, and a promotion should carry fresh evidence. Everything is
  **advisory**: no verdict blocks a merge or a promotion until the suites earn blocking
  through a proven track record, and that graduation is a decision for later, made with
  the product team.
- **Explore gets a per-merge lane.** On merge to `lucuma-apps` main, their CI publishes
  the built bundle as an artifact (spec §10 ask 3, now load-bearing) and fires one
  dispatch to this repo; the regression subset runs against that exact bundle via the
  existing `Caddyfile.bundle` path (~5 min recorded), and the verdict is posted back as
  an **advisory commit status on the merge commit**. Firebase-dev proxying was rejected
  for this lane: a second merge can land before the run starts, and "exact" is the point.
- **The ODB stays daily.** `lucuma-odb` merges publish SHA-tagged images already, so a
  per-merge lane would be cheap — deliberately declined to keep the process simple. The
  07:00 UTC run against `-dev :latest` remains the backstop for the ODB and everything
  that is neither repo (ITC, obscalc, Hasura); recorded image digests remain the bisect
  tool for a red morning.
- **Alerts move to Slack**, in a channel the team already reads, on red **and recovery**
  (recovery is what keeps red credible). GitHub's failure email stays as backstop. This
  supersedes email-as-the-single-path from ticket 008 once wired.
- **Release confidence hooks the existing promote script** (the Explore-repo script that
  promotes images to staging): it dispatches a release-confidence workflow pinned to the
  exact candidate digests, waits ~5 min, prints the verdict, and asks to continue — the
  human can promote on red. A performance-set leg in the gate waits for M4.
- **The weekly full suite** (`tests/COVERAGE.md` ground rule 4, promised but never
  built) is in scope for this effort; it also gives the gate a "run everything" option.
- **Placement: test code stays canonical here.** Scenario authorship remains with the
  observatory (carlos.quiroz), so moving code into product repos would buy review
  friction without ownership; the cross-system journey has no single natural home; and
  the scenario-parity machinery (`lib/scenario-catalog.js`) assumes one repo. The three
  itches pulling upstream get targeted remedies instead: selector drift → the **testid
  contract** owned by `lucuma-apps` (a versioned manifest of stable `data-testid`s with
  an existence check in *their* CI — §10 ask 1, promoted from "add testids" to "own the
  contract"); adoption → the per-merge commit status + Slack presence; discoverability →
  statuses link here, plus a short docs pointer in `lucuma-apps`.
- **Reserved, not rejected — the consume model**: `lucuma-apps` CI checking out
  `odbattr@<pinned-ref>` and running the journey inside their Actions. Parked until
  pre-merge checks come out of the fog; that is when running in their CI (against a PR
  build, before merge) beats dispatching out, and it needs a `HEROKU_API_KEY` upstream,
  which the v1 footprint refuses.
- **Upstream footprint, frozen**: bundle artifact + one dispatch step + testid contract
  and check + docs pointer in `lucuma-apps`; nothing in `lucuma-odb` beyond the standing
  JwtLifetime ask; no test code, no odbattr logic, one dispatch token upstream.
- **Sequencing honored**: the map's deferral stands for anything *blocking* — M4 and one
  real red-path drill come first — while the advisory per-merge lane proceeds now,
  because it generates exactly the run history the proving period needs.
