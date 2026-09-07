---
id: 016
title: "Automate the AWS load target: scripted boot, generator, workflow-driven"
labels: [wayfinder:task]
status: open
assignee:
blocked-by: []
---

## Question

*Reshaped by ticket 020 (was "Decide and provision the load target").* The decision part
is made: the surge run **iterates on the AWS compose target** — the only environment that
has carried a real 200-VU run (`research/aws-load-target-options.md`, m7i.4xlarge target,
c7i.2xlarge generator) — and the production-shaped Heroku target for the capacity claim
is deferred to [ticket 026](026-provision-production-shaped-heroku-target.md).

What remains is making the AWS target repeatable, because scenario iteration means
booting it many times: turn `loadtest/aws-first-run.sh` (nine human-driven stages) into
a scripted boot per `research/aws-nightly-automation.md` — provision the target and
generator, boot the compose stack with the sizing that survived run 2, fabricate the
standard-user pool, run k6 **from the generator** driven by a `workflow_dispatch`
workflow, publish results with run identity and annotations like the other suites, and
tear down under `always()`. Re-establish the safety rails the Heroku path had
(`loadtest/guard.sh`). Resolution records the boot command, cost per run, and the first
workflow-driven run link.
