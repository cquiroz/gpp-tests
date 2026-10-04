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

## Findings so far

**The target account changed, and it comes with a launch procedure (2026-10-02).** The August
runs used a separate account. The `gpp-tests` profile is IAM user `carlos.quiroz` in NOIRLab's
**shared** account `384445651298`, which also holds EKS clusters, databases and other teams'
instances. IT's procedure for it:

- **Region:** us-west-2 only.
- **Launch:** only through the Terraform-managed launch template `NOIRLab-Software-GPP`. It sets
  the private subnet `nl-vpc-private-us-west-2a` with no public IP, the HTTP/HTTPS/SSH security
  groups, instance profile `ec2_profile` (SSM), and `Department=Software`, `Project=GPP` tags.
  Instance type, image, key, root disk, user data and extra tags may all be overridden.
- **Access:** SSM only. ssh and rsync tunnel through `AWS-StartSSHSession`; the
  `AWS-StartNonInteractiveCommand` document is denied.
- **Not allowed:** creating security groups, `ssm:GetParameters`, `ModifyInstanceAttribute`
  (so no in-place resize: more memory means relaunching), S3, IAM.
- **The risk:** stop, start and terminate are allowed on *any* `Department=Software` instance,
  not only ours.

Verified on a `t3.micro` launched through the template. It was Online in SSM ~18 s after
running. Shell, ssh and rsync all worked over SSM, and GitHub, Ubuntu, Heroku registry and
Docker Hub were reachable through the NAT. The template's root disk is only 6.8 GB.

`loadtest/aws-first-run.sh` was rewritten for this. Changes:
- **Launch:** through the template, overriding Ubuntu 24.04 amd64 (the template's image is arm64
  Amazon Linux), the type, a 60 GB root disk, a key pair in us-west-2, and our tags plus
  `gpp-tests:loadtest=1`. A first-boot safety stop fires after N hours.
- **Access:** ssh/scp/rsync through a generated `out/aws-ssh_config` that proxies over SSM.
- **Safety:** `owned_or_die` re-reads the tag and Name of every id before starting, stopping or
  terminating it.
- **New stage 7:** `k6/regression.js` including the observing-modes scenario (ticket 030), with
  the fabricated PI streamed from the target to the generator.
- **Saved state:** `out/aws-loadtest-us-west-2.env`, so the old us-east-1 values are never
  offered back.

**What this means for the automation design** (`research/aws-nightly-automation.md`): it assumed
its own account, OIDC and public IPs. A workflow-driven version needs either a GitHub OIDC role
granted by IT under the same procedure, or a self-hosted runner inside `nl-vpc`. Ask IT which
they allow.

**First run under the procedure: green (2026-10-02).** `m7i.4xlarge` target and `c7i.2xlarge`
generator, both launched through the template at 19:40 UTC.

Smoke (10 VUs, 1m40s): 224 iterations, 861/861 checks.

Regression with the observing modes: 73/73 checks, 0 GraphQL errors, 21.6 s.

Full profile (0→50→200 VUs, 40 min), against the August us-east-1 run on the same types:

| | 2026-10-02 us-west-2 | 2026-08-26 us-east-1 |
|---|---|---|
| iterations | 111,763 (46.5/s), 0 interrupted | 111,333 (46.3/s) |
| http p50 / p95 / max | 30 / 168 / 730 ms | 31 / 189 / 1,238 ms |
| odb read p50 / p95 / max | 25 / 90 / 381 ms | 25 / 105 / 614 ms |
| odb write p50 / p95 / max | 80 / 284 / 730 ms | 102 / 318 / 650 ms |
| http failed / checks | 0% / 100% (345,847) | 0% / 100% |

The NOIRLab account carries the 200-VU model as comfortably as the separate one did, so it is
usable for the surge work. Lessons, both fixed in the wizard:
- The ssh that started k6 detached held the session's stdin, which froze the wizard for the
  whole run. Fixed with `< /dev/null`.
- The first-boot safety stop (3 h, counted from launch) was minutes from firing 17 minutes into
  the profile. It was cancelled over SSM by hand. The wizard now re-arms it 90 minutes ahead
  just before the profile starts.

Grafana remote-write answered 401 for the whole run: the token entered was a `glsa_` service
account token, and remote-write needs a `glc_` Access Policy token. Nothing reached Grafana; the
local summary is that run's record. Fixed the same day: the wizard reads `K6_PROMETHEUS_RW_*`
from the gitignored `.env`, proves the push from the generator with `tools/verify-metrics.sh` at
the smoke stage, and streams smoke, regression and load runs with the same credentials. The
re-run confirmed metrics arriving in Grafana Cloud. Both instances are stopped between runs.

**AUTO mode (2026-10-03).** The wizard runs unattended with `AUTO=1`: every prompt answers
from the environment (`RUN_EXECUTION`, `RUN_LOAD`, `TEARDOWN`, the `ask` values by name),
the run is logged to `out/aws-run-<stamp>.log`, and any non-zero exit stops the pair. Stage 8
runs the execution profile and samples the odb's memory on the target. This is the body of
the eventual workflow job: once IT grants an identity, the workflow calls the same script.

**First unattended run (2026-10-03, 18:35–19:25 UTC):** `AUTO=1 RUN_EXECUTION=1 RUN_LOAD=0
TEARDOWN=stop`, no keyboard, pair stopped at the end. Regression green (92/92), execution
profile 318 steps with 0 errors (numbers in ticket 021), Grafana streaming. Two bugs found
and fixed: credentials on a command line were echoed by a quoting error (now a file on the
generator, written over stdin), and the memory sampler held the ssh session for its whole
lifetime, delaying k6 by 24 minutes (now `setsid -f`).

**Third run (2026-10-03, 21:40–22:00 UTC):** the sampler now covers the run. 313 steps, 0
errors, overhead p95 606 ms / p99 648 ms; odb resident memory 4.6 → 15.5 GiB, explained by the
image's heap sizing (ticket 021, `research/odb-memory-growth-handoff.md`). Stage 4 now passes
`ODB_JAVA_OPTS` capping the odb heap at 60 % of its container.

**The standard run is one command:** `loadtest/aws-run.sh` (regression + 20-minute execution +
10-minute subscribers with 50 steady and 10 churning, stop at the end; `--load`, `--realistic`,
`--minutes`, `--instances`, `--subscribers N`, `--no-subscribers`, `--terminate`). Stage 9 of the
wizard runs the subscribers and samples the odb again. It is the
AUTO-mode wizard with the usual answers and caffeinate.

**Follow-up from 022 (2026-10-03), done the same day:** stage 9 runs `k6/subscribers.js` detached
on the generator (50 steady + 10 churning for 10 minutes by default, `RUN_SUBSCRIBERS`,
`SUBSCRIBERS`, `CHURN_VUS`, `SUBSCRIBER_MINUTES`, `SESSION_SECONDS`), samples the odb into its own
stats file, and the collect stage prints sockets, reconnects, unanswered pings, lost events, ping
and round-trip p95 per shape. `loadtest/aws-run.sh` includes it by default (`--no-subscribers`).

**Fourth run (2026-10-03/04, the full standard run, ~55 minutes unattended):** regression
green, execution 310 steps with 0 errors (overhead p95 587 ms), subscribers 275 sockets with
nothing lost (numbers in ticket 022), odb memory 4.4 → 10.4 GiB during execution under the
new 15.7 GiB heap cap and flat during the subscribers. Grafana streamed. Pair stopped.

**Where this leaves the ticket (2026-10-02):** the manual path is proven under the procedure, so
the surge work (021, 022) proceeds locally and boots AWS through the wizard when it needs real
numbers. The automation half waits on IT: a GitHub OIDC role for the repository scoped by the
`gpp-tests:loadtest` tag (preferred, no stored credential, destructive calls refused by the API
on untagged resources), or a self-hosted runner inside `nl-vpc` with the same tag-conditioned
instance profile. Ask carried by Carlos.
