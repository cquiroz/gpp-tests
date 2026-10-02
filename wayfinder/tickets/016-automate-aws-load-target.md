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
