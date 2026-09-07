---
id: 011
title: "Create gemini-hlsw/gpp-tests and stage its secrets"
labels: [wayfinder:task]
status: open
assignee:
blocked-by: []
---

## Question

Stand up the empty production repo so migration (012) has somewhere to land. HITL —
needs org permissions on `gemini-hlsw`; hand Carlos a precise checklist (or `/wizard`):

- Create `gemini-hlsw/gpp-tests`, public, fresh history (no import of the prototype's).
- Enable Actions; create the `run-data` branch convention.
- Migrate secrets/variables from the prototype CI (`cquiroz/gpp-tests`): Grafana Cloud
  metrics + annotation tokens, `HEROKU_API_KEY` (registry pulls), AWS credentials if
  the AWS target path wins, and the five `LOADTEST_*` repository variables (currently
  unset even in the prototype — record which stay unset until ticket 016 provisions).
- Record in the resolution: repo URL, who has admin, where each secret now lives.
