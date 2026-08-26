# The load target

The persistent Heroku environment the nightly performance suite points at (spec §6,
milestone M4). Unlike the regression stack, this one is not throwaway — it is provisioned
once, and every night it is released from the day's `-dev` images, reset, driven for forty
minutes, and scaled back to nothing.

## What it is

| App | Process types | Addons |
|---|---|---|
| `lucuma-postgres-odb-loadtest` | `web`, `obscalc` | Postgres (`essential-2`) |
| `lucuma-sso-loadtest` | `web` | Postgres (`essential-0`) |
| `itc-loadtest` | `web` | Redis (`mini`) |

No Explore and no Hasura: the load suite is k6 against the GraphQL API, so nothing renders a
page and nothing reads user preferences. Plain `*.herokuapp.com` hostnames are fine for the
same reason — the shared-parent-domain requirement in the ephemeral stack exists only to make
a browser send SSO's `SameSite=Strict` cookie, and k6's cookie jar ignores SameSite.

**Two databases, not one.** The spec says "one Postgres", but the ODB and SSO each run their
own Flyway migrations, and Flyway keeps its history in a table in whichever database it is
pointed at. Sharing one would have each service rejecting the other's migrations at boot. The
SSO's holds only users and sessions, so it gets the cheapest plan.

**Redis on the ITC.** Off Heroku the ITC treats Redis as an optional cache, which is why the
compose stack omits it. On a dyno it is mandatory.

## Cost

Heroku prorates everything to the second and bills dynos on wall-clock time above zero, so
scaling to zero between runs is what makes this affordable. Prices verified against
heroku.com/pricing (2026-08); the monthly figure is 730 hours, so an hourly rate is
`monthly ÷ 730`.

**Per run** — four `performance-m` dynos ($250/mo → $0.343/h) up for the 41-minute k6 profile
plus a cold start and a few minutes of post-run bookkeeping, call it 50 minutes:

```
4 dynos × 50 min = 3.3 dyno-hours × $0.343  ≈  $1.15
```

**Per month** — 30 nightly runs plus the addons, which cannot be paused and so set the floor:

| | |
|---|---|
| dynos, 30 runs × ~$1.15 | ~$35 |
| Postgres `essential-2` (ODB) | $20 |
| Postgres `essential-0` (SSO) | $5 |
| Key-Value `mini` (ITC) | $3 |
| GitHub Actions (public repo) | $0 |
| Grafana Cloud (free tier) | $0 |
| **total** | **~$63/month** |

Left permanently on, the same four dynos would be $1,000/month, so the scale-to-zero design
accounts for roughly 95% of the saving — and the always-on addons are now the larger half of
the bill.

The estimate's weak point is the **cold start**, which has never been measured on a dyno: four
JVM services booting plus the ODB migrating from empty against a network-attached Postgres.
Every extra 10 minutes there adds ~$0.23 to a run and ~$7/month. The first run after
provisioning will be the slowest.

**The failure mode that costs real money** is a run that ends without scaling down — four
`performance-m` dynos left up bill **~$33/day**. The workflow scales down under
`if: always()` and emits a `::warning::` if the call fails, but it is worth an occasional
look:

```bash
heroku ps -a lucuma-postgres-odb-loadtest    # expect "no dynos on ⬢ …"
```

## Safety: how this is kept away from production

The same Heroku account owns the production GPP environment, and this tooling issues
`pg:reset`, `container:release`, `ps:scale` and `config:set` against app names that come from
environment variables. A single mistyped variable would otherwise be enough to wipe a
production database. So every script sources [`guard.sh`](guard.sh), and no app is touched
until it passes three independent checks:

1. **The name must end in `-loadtest`.** Pattern check, no API call, so it also applies to dry
   runs.
2. **The name must not contain** `production`, `prod`, `staging`, `stage`, `-dev` or `master` —
   whatever check 1 says. `-dev` is in the list because those apps are the image *source*: we
   pull from them and must never push to them. This list is hardcoded and cannot be overridden
   by an environment variable.
3. **The app must carry `ODBATTR_LOADTEST=1`**, a config var `provision.sh` sets on apps it
   creates itself. Production, staging and the `-dev` apps do not have it and never will — so
   unlike the first two checks, this one cannot be satisfied by a typo at all.

Checks are re-run immediately before the destructive operations rather than only once at
startup, and every one of them fails closed: an unreachable API, an empty response or an
unreadable app all count as "do not touch it". `provision.sh` additionally refuses to *adopt*
an app that already exists without the marker, so a plausible-looking name that happens to
belong to something real is rejected rather than reconfigured.

Verified by [`guard.test.sh`](guard.test.sh) (18 cases, part of `npm run check`) and by
pointing each script at production names against a stubbed CLI that records any mutation:
every path refused, with zero mutations executed.

### The traffic plane: where the load is *sent*

The three checks above cover the apps this tooling mutates. They say nothing about the host k6
aims at, which arrives as `ODB_GRAPHQL_URL` / `SSO_URL` — repository variables that nothing used
to validate. Because the profile writes as well as reads (60/40, 200 VUs, a 20-minute hold), a
wrong value there would have seeded programs, observations and targets into whatever environment
it named.

[`lib/load-target.js`](../lib/load-target.js) closes that. A suite may target a host carrying a
`loadtest` label, or the local ephemeral stack (`*.internal`, `localhost`), and nothing else —
with the same protected-substring list as above, and the same fail-closed treatment of a URL it
cannot parse. It is enforced in two places:

- **`k6/lib/config.js`, at init** — so no VU can start against the wrong host by any route,
  including a hand-run `npm run k6:load`. Verified: k6 aborts before the first request.
- **`tools/check-load-target.js`, in `performance.yml` before the release step** — so a
  misconfigured night fails immediately instead of first resetting a database, deploying images
  and scaling four dynos up, then discovering the problem twenty minutes later.

Which of the two rules does the work is worth knowing: real production hostnames need not
contain "production", so it is the *positive* requirement — the host must identify itself as a
load-test host — that actually keeps traffic off production; the protected list is the second
line. Set `LOADTEST_HOST_PATTERN` when a target genuinely has no such label (a bare EC2 DNS
name, say); the protected list still applies, and a malformed pattern refuses rather than
allows. 18 cases in [`lib/load-target.test.js`](../lib/load-target.test.js).

This rail is also the portable one: it matches on hostnames, not Heroku app names, so it guards
an EC2 instance or an ALB unchanged — see
[the AWS design note](../research/aws-load-target-options.md).

### The one gap the code cannot close

A Heroku API token carries whatever access its owner has, so a token belonging to someone with
production admin can reach production regardless of what these scripts do. The rails above
protect against mistakes in *this* tooling; they cannot protect against anything else that
token is used for.

If that matters — and with a production environment on the same account, it does — give CI its
own Heroku identity with only:

- **read** on `lucuma-postgres-odb-dev`, `lucuma-sso-dev`, `itc-dev` (to pull images)
- **admin** on the three `-loadtest` apps

and nothing else. In a Heroku Team that is a member with per-app collaborator access rather
than team-wide rights. Then generate `HEROKU_API_KEY` as that user:

```bash
heroku authorizations:create -d 'gpp-tests CI'
```

## Provisioning

```bash
heroku authorizations:create -d 'odbattr provisioning'   # if the CLI is not logged in
export HEROKU_API_KEY=...

HEROKU_TEAM=<the team that owns lucuma-*-dev> loadtest/provision.sh          # dry run
HEROKU_TEAM=<the team that owns lucuma-*-dev> loadtest/provision.sh --apply
```

It is idempotent: everything already in place is skipped, so it doubles as a repair tool and
as the record of what the target's configuration is meant to be. It refuses to scale dynos
down while any are running, so it is safe to re-run without checking whether a load run is in
flight.

Pass `ODB_OTEL_ENDPOINT` and `ODB_OTEL_KEY` to have the target emit traces tagged
`environment=loadtest` (spec §7). Without them it boots with OpenTelemetry off.

The service JWT can only be minted once an SSO image is on the app, so the first pass through
is three steps:

```bash
loadtest/provision.sh --apply              # apps, addons, keypair, config
.github/scripts/release-loadtest.sh        # push and release today's images
loadtest/provision.sh --apply              # again — now it can mint the service JWT
```

Then set the repository variables it prints, and the nightly workflow stops skipping itself.

## Overrides

| Variable | Default | |
|---|---|---|
| `HEROKU_TEAM` | — | required |
| `LOADTEST_ODB_APP` / `_SSO_APP` / `_ITC_APP` | `lucuma-*-loadtest` | app names are globally unique on Heroku |
| `DYNO_SIZE` | `performance-m` | 2.5 GB, so JVM memory is not the thing being measured |
| `ODB_PG_PLAN` / `SSO_PG_PLAN` | `essential-2` / `essential-0` | |
| `ODB_MAX_CONNECTIONS` | `25` | must stay under the plan's limit — see below |
| `ITC_REDIS_PLAN` | `heroku-redis:mini` | |

### The connection pool matters

If the ODB's pool can exceed what the Postgres plan allows, a 200-VU run measures connection
exhaustion instead of the ODB. The subtlety is that the value is claimed **twice**: the `web`
dyno and `obscalc` are separate processes on the same app, so they read the same config vars and
each open their own pool against the same database.

```
ODB_MAX_CONNECTIONS ≈ (plan connection limit − 10) / 2
```

`essential-2` allows 40, so the default of 15 puts 30 in use and leaves ~10 for `pg:psql`,
backups and Heroku's own maintenance. Setting it to 20 — half the limit, which looks right —
would exhaust the database on the first run.

```bash
heroku pg:info -a lucuma-postgres-odb-loadtest     # confirm the "Connections" ceiling
heroku config:set ODB_MAX_CONNECTIONS=20 -a lucuma-postgres-odb-loadtest   # only on a bigger plan
```

Changing it changes what the numbers mean, so treat it as a baseline reset: the three nights
before and after are not comparable.

## Things to know

**Guest rows accumulate in SSO.** Each run creates 200-odd guest users, and the nightly reset
deliberately touches only the ODB's database — the SSO's holds the service user that
`ODB_SERVICE_JWT` refers to, and resetting it would orphan that token, surfacing much later as
a signature error inside obscalc. The rows are tiny; if the SSO database ever needs clearing:

```bash
heroku pg:reset -a lucuma-sso-loadtest --confirm lucuma-sso-loadtest
heroku ps:scale web=1 -a lucuma-sso-loadtest        # let Flyway migrate
unset ODB_SERVICE_JWT                                # then re-mint:
heroku config:unset ODB_SERVICE_JWT -a lucuma-postgres-odb-loadtest
loadtest/provision.sh --apply
```

**Rotating the SSO keypair** means re-minting the service JWT too, for the same reason. Delete
`GPG_SSO_*` from the SSO app and `ODB_SERVICE_JWT` from the ODB app, then re-run provisioning.

**The first run after provisioning is a cold start**: four JVM services booting plus the ODB's
migrations from empty. The workflow allows twenty minutes for a guest login to succeed.

## Tearing it down

```bash
for app in lucuma-postgres-odb-loadtest lucuma-sso-loadtest itc-loadtest; do
  heroku apps:destroy -a "$app" --confirm "$app"
done
```

That removes the addons with the apps. The `run-data` ledger keeps its history either way, so
a rebuilt target starts a fresh baseline — the first three nights will be threshold-free again.
