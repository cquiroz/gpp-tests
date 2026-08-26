# Running the load target on AWS

**Written:** 2026-08-25. **Status:** design note, nothing built. Covers the "AWS environment for
absolute capacity" item in [the spec's future work](../gpp-testing-system-spec.md) (§12), and
should be read alongside [the load-target README](../loadtest/README.md), which describes the
Heroku environment this would sit beside or replace.

## Summary

The suite is already portable: the k6 scripts, the Playwright journey, every GraphQL operation,
threshold calibration, the `run-data` ledger and the Grafana integration all take their
endpoints from environment variables and would move to AWS **unchanged**. What is
Heroku-specific is three scripts and a safety rail — `loadtest/provision.sh`,
`.github/scripts/release-loadtest.sh`, `.github/scripts/scale-down-loadtest.sh` and
`loadtest/guard.sh` — none of which contain test logic.

The cheapest credible shape is the one already written: run `stack/docker-compose.yml` — the
same file the nightly regression suite boots — on a single EC2 instance that is stopped between
runs. At verified on-demand rates that is **≈$1.16 per run and ≈$40/month**, against ≈$63/month
for the Heroku target, because there is no un-pausable managed database. It needs no new
service topology, only instance lifecycle.

The reason to do it at all is **absolute capacity**: Heroku answers "is tonight slower than last
night" on opaque shared hardware, and cannot answer "how many concurrent users can GPP serve",
because you do not know what you are running on. AWS answers that only if the load *generator*
moves too — k6 currently runs on a 2-core GitHub runner, which is itself a recorded ceiling
(spec §6). Moving the target alone risks measuring the runner.

Recommendation: **not yet**. Finish M4, collect a few weeks of nightly baseline, and see which
numbers you end up distrusting. Then do it in the phases at the end of this note, starting with
compose-on-EC2 and only building the Fargate topology if the evidence points at network- or
database-shaped bottlenecks.

## 1. What already moves without changes

`lib/endpoints.js` was written with per-endpoint overrides, and the unit suite exercises exactly
this case ("lets individual endpoints be overridden outright"):

```bash
SUITE=load \
ODB_GRAPHQL_URL=https://odb.loadtest.internal/odb \
SSO_URL=https://sso.loadtest.internal \
  npm run k6:load
```

That is the whole integration surface. Unchanged on AWS:

| | |
|---|---|
| `k6/` | both suites, the scenarios, guest auth, the 60/40 mix, traceparent injection |
| `tests/` | the Playwright journey (if you ever want a browser check against the load target) |
| `lib/` | operations, endpoints, label budget, summaries, threshold calibration, annotations |
| `tools/` | ledger, thresholds, run summaries, Grafana annotations, operation verification |
| `grafana/` | dashboard and annotation queries — `environment` already distinguishes targets |
| `schema/` | vendored ODB schema |
| `lib/load-target.js` | the target-host rail — it matches hostnames, not Heroku app names, so it guards an EC2 instance or an ALB unchanged |

`lib/endpoints.js` also supports `GPP_TEST_SCHEME=http`, so a plain-HTTP target works — with one
caveat in §3.

## 2. What is Heroku-shaped

| File | What it does | AWS equivalent |
|---|---|---|
| `loadtest/provision.sh` | apps, addons, config vars, keypair, service JWT | Terraform/CDK, or a sibling script |
| `.github/scripts/release-loadtest.sh` | retag `-dev` images, `container:release`, `pg:reset`, scale up | push to ECR, start instance / update service, reset the database |
| `.github/scripts/scale-down-loadtest.sh` | `ps:scale …=0` | stop the instance / scale the service to 0 |
| `loadtest/guard.sh` | refuses to touch anything that is not a marked load-test app | the same three checks against tags — see §6 |
| `performance.yml` | reads `vars.LOADTEST_*` | a target abstraction, or a parallel workflow |

**Images are not a blocker.** They exist only in `registry.heroku.com`, but
`docker pull registry.heroku.com/lucuma-postgres-odb-dev/web:latest` works from anywhere with
the API key — `release-loadtest.sh` already does pull-and-retag, and the identical pattern
retags into ECR. No sbt build, no change to how images are produced.

## 3. Option A — compose on one EC2 instance

Run `stack/docker-compose.yml` on an instance that is started for the run and stopped after.
This is the same file the nightly regression suite boots from empty, so it is the best-tested
artifact in the repository.

For a load target the browser-facing services are unnecessary — `docker compose up postgres sso
odb itc obscalc caddy` omits Hasura and the Explore proxy, since k6 renders nothing and reads no
preferences.

**Keep Caddy.** SSO in any non-local environment hardcodes `https` and therefore sets its
refresh cookie `Secure`; over plain HTTP the JWT refresh loop breaks, and every VU silently
becomes a new guest after eight minutes — the exact failure already found and fixed in
`k6/lib/auth.js`. TLS is one container, so terminate it rather than rediscover that.

### Cost

Verified against the EC2 on-demand dataset for `us-east-1`, Linux, 2026-08-25. EC2 bills per
second with a 60-second minimum.

| | vCPU | Memory | $/hour |
|---|---|---|---|
| `m7i.4xlarge` — the stack | 16 | 64 GiB | 0.8064 |
| `c7i.2xlarge` — the k6 generator | 8 | 16 GiB | 0.357 |

A run is roughly an hour end to end (boot, ~41-minute profile, teardown):

```
0.8064 + 0.357  ≈  $1.16 per run
30 runs          ≈  $35/month
EBS, two 30 GiB gp3 volumes kept between runs   ≈  $5/month
                                          total ≈  $40/month
```

Cheaper than the Heroku target's ≈$63/month, and for a specific structural reason (§5).
`m7i.4xlarge` is deliberate headroom: four JVMs plus Postgres on one host, and the point of the
exercise is that the *services* are the bottleneck, not the box.

### Trade-offs

- **For:** no new service topology; reuses the most-exercised file in the repo; identical to
  what regression runs prove nightly; you know exactly what hardware produced the number; the
  whole thing stops.
- **Against:** single host, so Postgres competes with the services it serves — good for a
  capacity ceiling, poor as a model of production; you own AMIs, security groups and instance
  lifecycle; no managed backups (irrelevant for a target reset nightly).

## 4. Option B — ECS/Fargate with RDS

One task definition per service, an ALB, RDS Postgres, ElastiCache for the ITC. This is what to
build if the question is "how does the real topology behave" rather than "what can this hardware
take": real network hops between services, independently scalable components, a managed database
with its own performance characteristics.

Not costed here — Fargate's per-vCPU-second and RDS instance rates need the AWS calculator
against a concrete task sizing, and inventing figures would be worse than leaving the gap. Two
things to price carefully:

- **Fargate** costs more per unit of compute than EC2, in exchange for no instance management.
- **RDS cannot be stopped indefinitely** — a stopped instance is auto-started after 7 days — so
  a nightly-only environment either pays for it continuously or automates stop/start around that
  limit. Aurora Serverless v2 scales down but has a non-zero floor.

Substantially more work than Option A, and it answers a question you cannot yet show you have.

## 5. The pattern worth noticing: the database sets the floor

In every managed option, the un-pausable database is what costs money:

| | idle cost |
|---|---|
| Heroku Postgres addons | cannot pause — ~$25/month of the ~$63 total |
| RDS | stoppable for at most 7 days at a time |
| Aurora Serverless v2 | scales down to a non-zero floor |
| Postgres in a container on a stopped instance | **nothing** |

For an environment that runs 40 minutes a night, containerised Postgres on an instance you stop
is not a compromise — it is the cost-optimal answer, and it is what `stack/docker-compose.yml`
already does. Managed databases earn their keep through durability and backups, which a target
that is `pg:reset` nightly does not need.

## 6. The generator is the part people forget

k6 runs on an `ubuntu-latest` GitHub runner: 2 cores. Spec §6 records that as "the recorded
ceiling", which is honest for regression detection — a consistent generator makes night-over-night
comparison valid even if it is the bottleneck. It is *fatal* for absolute capacity: move the
target onto 16 vCPUs and the generator may well become the limit, so you would be measuring
GitHub's runner and calling it GPP's capacity.

So an AWS capacity effort is two pieces, and they have to be planned together:

1. the target on hardware you chose;
2. k6 off the hosted runner — its own instance, or the distributed-k6 item also in §12's fog.

A cheap way to find out whether this already bites: run the current 200-VU profile twice against
the same Heroku target, once from the hosted runner and once from a larger runner or a laptop. If
the numbers differ materially, the generator is already in the way.

## 7. Safety must be rebuilt, not skipped

One half of it already moved: the target-host rail (`lib/load-target.js`, §1) is hostname-based
and guards an AWS target with no changes — so the "200 VUs at the wrong host" hazard, which AWS
does *not* remove on its own, is covered wherever the target lives. What follows is about the
control plane, which is entirely Heroku-shaped today.

`loadtest/guard.sh` exists because this tooling resets databases and rescales services on an
account that also owns production, and one mistyped variable would have been enough. AWS has the
same hazard with different nouns — `aws rds delete-db-instance`, `aws ec2 terminate-instances`,
`aws ecs update-service --desired-count 0`.

The three checks port directly:

1. the resource name must match a load-test pattern;
2. it must not match a protected pattern (`prod`, `staging`, …);
3. it must carry a tag this tooling set itself — `odbattr:loadtest=1` — which production will
   never have, and which therefore cannot be satisfied by a typo.

Plus two AWS-specific controls with no Heroku equivalent, both stronger than anything in the
current setup:

- **An IAM role scoped by tag.** A policy conditioned on `aws:ResourceTag/odbattr = loadtest`
  makes the destructive calls *impossible* against untagged resources, rather than merely
  refused by a script. This is the control Heroku cannot offer, and it closes the gap noted in
  the load-target README about token scope.
- **A separate AWS account** for test infrastructure, if the organisation runs Control Tower or
  similar. Then there is no production to reach.

Do not port the tooling without porting the rails; the guard's tests (`loadtest/guard.test.sh`)
are the template.

## 8. Suggested phasing

1. **Measure the generator** (§6). An afternoon, no AWS, and it tells you whether absolute
   capacity is even reachable from CI as it stands.
2. **Compose on EC2, driven by hand.** Bring the stack up on an `m7i.4xlarge`, run k6 from a
   `c7i.2xlarge`, compare against the Heroku baseline. No IaC, no workflow changes — just
   `ODB_GRAPHQL_URL` pointed elsewhere. This is where you find out whether AWS numbers tell you
   anything Heroku's do not.
3. **Automate it** only if step 2 pays off: instance lifecycle, the tag guard, the IAM policy,
   and a `performance.yml` that can target either environment.
4. **Fargate/RDS** only if step 2 shows the single-host topology is what is limiting you.

Steps 1 and 2 are cheap and answer the actual question. Steps 3 and 4 are real projects.

## Open questions / caveats

- **EC2 prices** are `us-east-1` Linux on-demand from the ec2instances.info dataset on
  2026-08-25, and exclude data transfer, NAT and EBS snapshots. Region choice matters: closer to
  the Grafana Cloud stack and to whoever reads the results.
- **Instance sizing is a guess.** `m7i.4xlarge` was chosen for headroom, not measured. Step 2
  above is what turns it into a number.
- **Fargate and RDS are not costed**, deliberately — see §4.
- **Whether one host distorts the result** is unknown: Postgres and four JVMs on the same box
  share memory bandwidth and page cache in ways Heroku's split does not. It may flatter the ODB
  (no network hop to the database) or penalise it (CPU contention). Comparing step 2 against the
  Heroku baseline is the way to find out, and is a reason to keep both targets for a while
  rather than migrating.
- **Reserved capacity and Spot** are untouched here. A nightly one-hour job is a good Spot
  candidate — interruption just means a lost night — and would cut the compute roughly in half.
- **The ledger is per-suite, not per-target.** `tools/compute-thresholds.js` filters on
  `suite: "load"`, so pointing the same suite at a different target would silently mix two
  baselines. Running both environments needs a target dimension in the summary schema first;
  that is a small change to `lib/summary.js` and `lib/thresholds.js`, and worth doing *before*
  the first AWS run rather than after.
