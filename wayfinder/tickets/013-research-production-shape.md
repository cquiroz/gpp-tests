---
id: 013
title: "Research: production deployment shape and sizing"
labels: [wayfinder:research]
status: open
assignee: carlos.quiroz
blocked-by: []
---

## Question

What does production actually run on? For odb, obscalc, SSO, ITC, and their Postgres:
Heroku app names, dyno types and counts, Postgres plans (connection limits, IOPS),
Redis, and any autoscaling. Sources: Heroku CLI (if authenticated locally), lucuma-odb
repo config/docs, app.json manifests. Deliverable: `research/production-shape.md` —
a sizing table the load-target decision (016) can mirror or scale from, with a stated
confidence per fact. If access is missing, record exactly what must be asked of whom.
