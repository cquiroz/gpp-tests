# Running the nightly load suite on AWS (M4, implemented on EC2)

**Written:** 2026-08-27. **Status:** design note, nothing built. Phase 3 of
[AWS load-target options](aws-load-target-options.md), which covers *whether* to run on AWS
and how a manual run works; this covers *automating* it as the nightly job. Read alongside
[the load-target README](../loadtest/README.md) (the Heroku design this replaces) and
[spec §6/§8](../gpp-testing-system-spec.md).

## Summary

**There is nothing to migrate.** M4's Heroku apps were never provisioned —
`performance.yml` exits green with a notice because the five `LOADTEST_*` repository
variables are unset — so this is not a cutover. It is a choice to implement M4 on EC2
instead, with no Heroku environment to decommission, no dual-running window and no mixed
baseline to untangle.

About 80% of `performance.yml` is target-agnostic and does not change. Two Heroku scripts
gain AWS counterparts, and `HEROKU_API_KEY` is replaced by **GitHub OIDC plus a
tag-conditioned IAM role** — which closes the one gap `loadtest/README.md` records as
unclosable, because an IAM condition makes the destructive calls *impossible* against
untagged resources rather than merely refused by a script.

Roughly a day of implementation plus a few nights of shakedown. **Do it after one clean
manual run**, not before: the first attempt died 14 minutes in on CI-sized memory limits
([aws-load-target-options §3](aws-load-target-options.md)), and automating a target that has
not yet survived its own profile would bake in whatever else is mis-sized.

## 1. What does not change

Every one of these steps takes its endpoints from the environment and is indifferent to
where the target runs:

| Step in `performance.yml` | Why it is portable |
|---|---|
| `Check the load target is provisioned` | variable presence check; the names change, the logic does not |
| `Verify the k6 target is a load-test host` | hostname-based (`lib/load-target.js`), so it guards an EC2 target unchanged |
| `Is there a ledger yet?` / `Ledger checkout` | the `run-data` branch, unrelated to the target |
| `Calibrate thresholds from the ledger` | reads the ledger, not the target |
| `k6 load run` | endpoints from `ODB_GRAPHQL_URL` / `SSO_URL` |
| `Write the run summary` / `Publish to run-data` | target-agnostic |
| all three Grafana annotations | `environment` already distinguishes targets |
| `Fail on a threshold breach` | reads k6's outcome |

## 2. What is replaced

| Today (Heroku) | On AWS |
|---|---|
| `release-loadtest.sh`: retag `-dev` images, `container:release`, `pg:reset`, `ps:scale` up | launch the target from an AMI, `docker compose pull`, boot the stack from empty |
| `scale-down-loadtest.sh`: `ps:scale …=0` | terminate the instance (or stop it) |
| `HEROKU_API_KEY` repository secret | GitHub OIDC → IAM role, no stored credential |
| `guard.sh`: three app-name checks | tag checks, backed by an IAM condition |
| readiness by `curl`ing SSO from the runner | readiness checked **on the box** via SSM (§6) |

**`pg:reset` has no counterpart, and does not need one.** Booting the compose stack from
empty *is* the reset, and it carries the property the ephemeral regression suite already
relies on: every run also exercises Flyway migrating from nothing.

## 3. Credentials: OIDC, not an access key

GitHub Actions mints a short-lived OIDC token; an IAM role trusts that token for this
repository only. No secret is stored, nothing to rotate, nothing to leak from a public repo.

```yaml
permissions:
  id-token: write        # in addition to contents: write
  contents: write
steps:
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: arn:aws:iam::<account>:role/odbattr-nightly
      aws-region: us-east-1
```

Two conditions carry the safety, and they are what makes this stronger than the Heroku
arrangement rather than merely different:

- **Trust policy** — `token.actions.githubusercontent.com:sub` restricted to
  `repo:<org>/<repo>:ref:refs/heads/main`, so a branch or a fork cannot assume the role.
- **Permission policy** — every destructive action (`ec2:TerminateInstances`,
  `ec2:StopInstances`, `ssm:SendCommand`) conditioned on
  `aws:ResourceTag/odbattr:loadtest = 1`. `ec2:RunInstances` is conditioned on
  `aws:RequestTag/odbattr:loadtest` so the tooling can only *create* tagged resources
  either.

The Heroku token could not be constrained this way: it carries whatever access its owner
has. Here, a mistyped identifier does not reach an untagged resource because the API refuses
it, not because a bash function did.

## 4. Instance lifecycle: a warm AMI, still tracking `main`

Three options, and the tension is that spec §6 wants the target released from **today's**
`-dev` images — a baked-in image set would silently test whatever was current when the AMI
was built.

| | Boot time | Storage cost | Tests latest `main`? |
|---|---|---|---|
| Launch bare Ubuntu, pull everything | ~12-15 min | none | yes |
| Bake images into the AMI | ~2 min | snapshot | **no** — tests the baked set |
| **Bake OS + Docker + a warm image cache, then `pull` at boot** | ~4-6 min | snapshot | **yes** |

The third is the right shape: the nightly `docker compose pull` is incremental, so on most
nights only the changed layers move rather than the full ~3.5 GB, and the run still tests
whatever `-dev` published that day. Rebuild the AMI when the delta grows large enough to
hurt — monthly is likely plenty, and it is a scripted one-off.

Terminate rather than stop: with the AMI holding the warm cache there is nothing on the root
volume worth keeping overnight, and termination takes the storage cost to zero.

## 5. Where k6 runs — the decision that determines what the numbers mean

| | Cost | What it measures |
|---|---|---|
| Hosted GitHub runner, over the public internet | free | the 2-core ceiling **plus** internet latency and jitter; needs 443 open beyond the VPC |
| **Second EC2 instance in the same AZ** | ~$0.36/run | the target, on hardware you chose, over a private network |

Keeping the generator on the runner would give the worst combination: still the recorded
2-core ceiling (spec §6), now with public-internet variance in every sample and an ingress
rule opening the target to the world. Moving the target without moving the generator does
not answer the question the move was for.

The generator is a good **Spot** candidate — an interruption costs one night's data, which
is exactly the risk profile Spot suits, and it roughly halves that line.

Both instances must be in **one availability zone**: cross-AZ traffic is billed per GB each
way and adds a network hop to the latency under measurement.

## 6. Orchestration: SSM Run Command, not SSH

No key material in CI, no inbound ports at all, and every command IAM-authorised and logged.
The target needs an instance profile with `AmazonSSMManagedInstanceCore`; the workflow then
drives both boxes with `aws ssm send-command` and polls for completion.

One consequence worth planning for: today's workflow proves readiness by `curl`ing
`$SSO_URL/api/v1/auth-as-guest` **from the runner**. With no public ingress that call cannot
work, so readiness moves onto the box — run `stack/scripts/wait-for-ready.sh` there via SSM
and read its exit status. That is a better check anyway: it is the same seven-service gate
the regression suite uses, rather than a single endpoint.

## 7. Cost

| | |
|---|---|
| target `m7i.4xlarge`, ~1 h | $0.81 |
| generator `c7i.2xlarge`, ~45 min (on-demand) | $0.27 |
| **per run** | **≈ $1.08** |
| 30 nights | ≈ $32 |
| AMI snapshot (compressed, incremental) | ≈ $1-2/month |
| **monthly** | **≈ $34**, against ≈$63 for the Heroku design |

Spot on the generator takes it to roughly $30. Nothing is billed between runs, which is the
structural advantage over any managed database (aws-load-target-options §5).

## 8. Safety rails to port

- The three `guard.sh` checks become: the resource must carry `odbattr:loadtest=1`; its
  `Name` tag must match a load-test pattern; and it must not match a protected pattern.
  `loadtest/guard.test.sh` is the template — the AWS versions need the same 18-ish cases.
- **The IAM tag condition (§3) is the real rail.** The script checks are defence in depth.
- **The traffic-plane rail already moves unchanged.** `lib/load-target.js` matches
  hostnames, and the AWS target answers on `*.gpp-test.internal`, which its `.internal`
  rule allows. Nothing to write.
- Keep `loadtest/aws-first-run.sh` as the manual path: when a nightly goes red, driving the
  same sequence by hand is how it gets diagnosed.

## 9. Files this touches

| File | Change |
|---|---|
| `.github/workflows/performance.yml` | swap two steps, add `id-token: write`, move readiness to SSM |
| `loadtest/aws/start-target.sh` | new — launch from AMI, pull, boot, wait |
| `loadtest/aws/stop-target.sh` | new — terminate, `always()`, best-effort like its Heroku sibling |
| `loadtest/aws/build-ami.sh` | new — scripted one-off, rebuild monthly |
| `loadtest/aws/guard.sh` | new — the tag-based checks, plus tests |
| `loadtest/provision.sh`, `release-loadtest.sh`, `scale-down-loadtest.sh`, `guard.sh` | keep, unused, until the AWS path has run clean for a fortnight; then delete rather than maintain two |
| `lib/thresholds.js`, `tools/ledger.js` | filter the ledger on `environment` as well as `suite` — only strictly needed if both targets ever run, but cheap now and impossible to retrofit cleanly later |
| `loadtest/README.md`, this note, the spec's §6 | document which target is real |

## 10. Phasing

1. ~~**One clean manual run** with load-sized limits~~ — **done 2026-08-27**: 40 minutes at
   200 VUs, 111,333 iterations, checks 100%, zero GraphQL errors.
2. ~~**Record what the services want**~~ — **done**, and folded into
   `loadtest/aws-first-run.sh`'s allocation. Still open: the capacity knee, which sits between
   200 and 1500 VUs; run 3 crossed it too fast to locate. A 200 → 800 ramp is the next
   experiment, and it should precede automation so the nightly profile is set from evidence.
3. **IAM: the OIDC role and the tag policy** — a one-off a human runs, wizard-style.
4. **Lifecycle scripts and the AMI, driven by hand** until a full sequence works twice.
5. **Swap the two workflow steps.** Run baseline-only for three nights (the ledger does this
   automatically — no threshold arming until the fourth).
6. **Arm thresholds.** M5 as written, just against a different target.

Steps 1-2 are this week. Steps 3-4 are the actual project. Step 5 is an afternoon.

## Open questions / caveats

- **The ODB's memory need is bounded, not known.** Measured 11.6 GiB at 200 VUs and 23.3 GiB
  while ramping to 1500 — but a JVM expands into its limit and does not return memory, so those
  are ceilings under 16 GiB and 28 GiB caps rather than requirements. What is settled: 2 GiB is
  not enough (dead at ~185 VUs). Bisecting downward is the only way to find the floor, and it
  matters here because it decides the instance type.
- **AMI refresh cadence** (§4) is a guess. If the nightly `pull` starts costing more than a
  couple of minutes, rebuild sooner.
- **Spot interruption** loses a night silently unless the workflow notices. The ledger would
  record nothing for that date, which is detectable but not alerted — and spec §7 has no
  alerting in v1.
- **Whether to keep the Heroku design at all.** Deleting it removes a fallback; keeping it
  means maintaining two sets of rails for an environment that has never been provisioned.
  The recommendation above (keep briefly, then delete) is a judgement call, not a finding.
- **Comparability across the switch.** Numbers from an EC2 target and a future Heroku target
  are not comparable — different hardware, different topology, one Postgres on the same host
  rather than a managed addon. If both ever run, the ledger needs the `environment` filter
  *before* the first night, not after.
- **The generator is still one box.** 200 VUs from a `c7i.2xlarge` is comfortable, but a
  materially larger profile would need distributed k6 — still in spec §12's fog.
