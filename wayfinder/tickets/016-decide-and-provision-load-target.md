---
id: 016
title: "Decide and provision the load target"
labels: [wayfinder:grilling]
status: open
assignee:
blocked-by: [013, 015]
---

## Question

Finally make the load target real. Inputs: production's shape (013), the surge scale
(015), and the prototype evidence — Heroku M4 was designed but never provisioned;
the AWS path produced the only real 200-VU run (manual, 9-stage wizard). Decide:
Heroku vs AWS; persistent vs provisioned-per-run (on-demand surge cadence reopens
this); sizing relative to production (mirror vs stated scaling factor). Then
**provision it** and prove it with a smoke run from `performance.yml` in gpp-tests —
the nightly must stop no-oping. Resolution records target endpoints, cost per run,
and the scaling factor every result must be read through.
