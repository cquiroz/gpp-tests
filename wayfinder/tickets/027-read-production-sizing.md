---
id: 027
title: "Read production's dyno and Postgres sizing (HITL)"
labels: [wayfinder:task, wayfinder:hitl]
status: open
assignee:
blocked-by: []
---

## Question

Ticket 013 found that dyno counts, dyno sizes and Postgres plans live only in the Heroku
control plane and listed the exact read-only commands (`research/production-shape.md`);
the local Heroku token was stale. Ten minutes for a human with access: `heroku login`,
run the commands for the four production apps, paste the results into the research file.
Unblocks 026 and lets the AWS sizing be stated as a scaling factor rather than a guess.
