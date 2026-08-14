---
id: 008
title: "Decide the CI topology on GitHub Actions"
labels: [wayfinder:grilling]
status: open
assignee:
blocked-by: [003]
---

## Question

Define the GitHub Actions workflows for v1's scheduled cadence: how often the
regression subset runs against latest main images (every N hours), when the nightly
performance set fires, how the ephemeral stack boots on a runner (services vs compose),
artifact retention (Playwright traces/videos on failure), how failures notify the team,
and which repo hosts the workflows (the manually-created testing repo).
