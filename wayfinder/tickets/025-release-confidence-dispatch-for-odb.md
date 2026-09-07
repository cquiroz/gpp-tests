---
id: 025
title: "Release-confidence dispatch for the odb"
labels: [wayfinder:task]
status: open
assignee:
blocked-by: [018]
---

## Question

Ticket 020: surge runs fire on demand and before promoting the odb. Give the surge
workflow `workflow_dispatch` inputs for the candidate image digests (odb web, obscalc,
and the rest of the compose stack as pinned), so a promoter can run it against exactly
what would ship and read the verdict before continuing. Manual dispatch first; hooking
the fleet promote script in `lucuma-apps` (the pattern ticket 010 chose for Explore)
comes after a few clean firings and is the only footprint `lucuma-odb`/`lucuma-apps`
get. Resolution records the inputs and one dispatched run against a named digest.
