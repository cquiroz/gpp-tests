---
id: 027
title: "Read production's dyno and Postgres sizing (HITL)"
labels: [wayfinder:task, wayfinder:hitl]
status: closed
assignee:
blocked-by: []
---

## Question

Ticket 013 found that dyno counts, dyno sizes and Postgres plans live only in the Heroku
control plane and listed the exact read-only commands (`research/production-shape.md`);
the local Heroku token was stale. Ten minutes for a human with access: `heroku login`,
run the commands for the four production apps, paste the results into the research file.
Unblocks 026 and lets the AWS sizing be stated as a scaling factor rather than a guess.

## Findings so far

**Scripted, 2026-10-14:** `tools/read-production-sizing.sh` runs every read in
`research/production-shape.md` §5, plus the autoscaling monitors and the Private Space flag,
through the Platform API. It is read-only and prints no config value except the
`*_MAX_CONNECTIONS` overrides. Run `heroku login` (as someone on the Gemini Heroku team),
then the script. It writes `out/production-sizing-<stamp>.txt`; `PREFS_APP=<name>` adds the
Hasura app once its name shows in the app list the script prints. A session's own Heroku token
was stale (401), so a human runs this one. Tested only against stubs so far.

## Resolution

**Closed 2026-10-14.** Carlos ran `tools/read-production-sizing.sh`
(`out/production-sizing-20261014T125312Z.txt`), and the values are in
`research/production-shape.md` §0. In brief:

- odb `web`: Performance-L-RAM × 2. `obscalc`, `calibration` and a new `pdfsummary`:
  Standard-2X × 1 each.
- One Heroku Postgres **`essential-2`** shared by all of them: 40 connections, 26 in use at
  the read.
- Pool overrides: `ODB_MAX_CONNECTIONS=8`, `OBSCALC_MAX_CONNECTIONS=8`,
  `CALIBRATIONS_MAX_CONNECTIONS=4`.
- SSO: Standard-2X on `essential-1`. ITC: Performance-M with Redis Cloud `100`. Resource:
  Basic on `essential-0`.
- Common Runtime throughout.

Not determined: autoscaling (its API answered nothing readable) and the prefs app
(`user-prefs-production`, not in the run).

The finding that matters: production's database is an entry-level shared plan, where the AWS
target gave Postgres up to 7 cores and 400 connections. The surge PASS therefore speaks for
the software, not yet for production's sizing. That is ticket 026's job, which this unblocks
(026 still waits on 018's CI half).
