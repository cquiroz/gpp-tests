---
id: 013
title: "Research: production deployment shape and sizing"
labels: [wayfinder:research]
status: closed
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

## Resolution

Written up in [research/production-shape.md](../../research/production-shape.md). Production shape is fully pinned:
four apps — `lucuma-postgres-odb-production` (web+obscalc+calibration, one shared Postgres; verified live),
`lucuma-sso-production` (own Postgres), `itc-production` (Redis Cloud, no DB; verified live),
`lucuma-resource-production` — plus Hasura prefs, all Heroku-routed. Dyno types/counts, PG plans, and Redis
plan are NOT in any repo (no app.json/Procfile; promote.sh only patches docker_image) and the local Heroku
CLI credential is stale (401) — the research file lists the exact read-only commands and who to ask (#gpp / promote.sh operators).
