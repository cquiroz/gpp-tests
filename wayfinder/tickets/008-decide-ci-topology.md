---
id: 008
title: "Decide the CI topology on GitHub Actions"
labels: [wayfinder:grilling]
status: closed
assignee: carlos.quiroz
blocked-by: [003]
---

## Question

Define the GitHub Actions workflows for v1's scheduled cadence: how often the
regression subset runs against latest main images (every N hours), when the nightly
performance set fires, how the ephemeral stack boots on a runner (services vs compose),
artifact retention (Playwright traces/videos on failure), how failures notify the team,
and which repo hosts the workflows (the manually-created testing repo).

## Resolution

- **Regression cadence: every 24 hours** (revised down from charting's "every few
  hours"), scheduled 07:00 UTC + `workflow_dispatch` for on-demand runs after a
  suspicious merge. Recorded image SHAs attribute a red run to the day's commits.
- **Performance set: nightly 08:00 UTC** (~4–5 am Chile; results ready by morning),
  regression run first so both finish before the day starts.
- **Notification: email** — baseline is GitHub's native workflow-failure emails to repo
  watchers; if richer content is wanted (failed scenario, links to the run and the
  Grafana annotation window), a small SMTP step (org Mailgun) in the failure path.
- **Artifacts**: Playwright traces/videos/screenshots **on failure only**, k6 raw
  summary always — both 30-day retention; the ~1 KB per-run summary JSON (durable
  record, Grafana ticket) committed to a dedicated **`run-data` branch** so main stays
  human.
- **Structure**: two workflows in the testing repo — `regression.yml` (daily +
  dispatch: boot ephemeral compose stack → Playwright journey → k6 regression
  variants) and `performance.yml` (nightly: release loadtest apps from `-dev` images →
  `pg:reset` → k6 load run) — sharing a reusable boot-the-stack composite action; each
  under a **concurrency group, queued not cancelled** (the loadtest env must never be
  reset mid-run).
- **Repo public** (all secrets are CI secrets; Actions minutes free) and **Playwright
  retries = 1 with retried-passes reported as "flaky"**, not silently green. (User
  accepted the recommendation for this pair — "ta".)
