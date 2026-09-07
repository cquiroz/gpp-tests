---
id: 018
title: "Implement the surge profile and its on-demand workflow"
labels: [wayfinder:task]
status: open
assignee:
blocked-by: [016, 017, 021, 022, 023]
---

## Question

*Reshaped by ticket 020.* Compose the surge run from its layers: the regular-ops guest
mix (ramping VUs), the proposal loop (017, arrival rate), Explore-tab and Observe-browser
subscriber VUs (022), and Observe execution VUs (021, constant VUs), with the two tiers
and the 75-minute shape from 020 selectable at dispatch. Wire the surge SLO file and
verdict (023). The `workflow_dispatch` workflow boots the AWS target (016), runs the
surge from the generator, and publishes results with run identity and Grafana
annotations like the other suites. Prove it with one full real run per tier. Resolution
records the run links and each class's verdict.
