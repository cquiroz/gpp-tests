# GPP production deployment shape (Heroku)

**Research date:** 2026-09-02. Sources: live HTTP probes of production endpoints; `main` of `gemini-hlsw/lucuma-odb` (ci.yml, DEPLOYMENT.md, ODB-README.md, ITC-README.md, Config.scala) and `gemini-hlsw/lucuma-apps` (promote.sh, environments.conf.json); Heroku Dev Center plan tables (fetched 2026-09-02). Heroku CLI access was **not available** (local credential rejected with `401 unauthorized`), so everything the Heroku control plane alone knows — dyno types, dyno counts, Postgres/Redis plans, autoscaling — is **unknown** and listed under "What to ask of whom".

**Summary.** Production is four Heroku apps — `lucuma-postgres-odb-production` (process types `web`, `obscalc`, `calibration`, one shared Heroku Postgres), `lucuma-sso-production` (`web` + its own Heroku Postgres), `itc-production` (`web` + a Redis Cloud add-on, no database), and `lucuma-resource-production` (`web`) — plus a Hasura prefs service, also Heroku-routed at `prefs.gpp.gemini.edu`. The ODB and ITC apps were **verified live** on their bare `herokuapp.com` domains; Explore's production config points straight at `lucuma-postgres-odb-production.herokuapp.com`, so that name is load-bearing in production today. There is **no app.json, Procfile, or heroku.yml anywhere in the repos**: formation is configured only in the Heroku dashboard/API, and the promotion script (`promote.sh` in lucuma-apps) only PATCHes each formation's `docker_image` — it never touches size or quantity. No autoscaling automation exists in any gemini-hlsw repo. Consequence for the capacity claim: **the load target cannot be sized from public sources alone**; one `heroku ps`/`pg:info` run by anyone with access to the Gemini Heroku team closes every remaining gap (exact commands below).

---

## 1. Sizing table

Confidence tags: **verified-by-probe** (live HTTP on 2026-09-02), **from-repo-config** (named in checked-in config/scripts on `main`), **inferred** (stated reasoning), **unknown** (only the Heroku control plane knows).

| Service | Heroku app | Process types | Dyno type × count | Database / cache add-on | Key limits |
|---|---|---|---|---|---|
| ODB GraphQL | `lucuma-postgres-odb-production` — verified-by-probe (bare `herokuapp.com` domain serves; also the `odbURI`/`odbRestURI` in Explore's production conf) | `web`, `obscalc`, `calibration` — from-repo-config (promote.sh `process_types["ODB"]`, ci.yml image pushes) | **unknown** | Heroku Postgres, plan **unknown** — add-on's existence from-repo-config (promote.sh runs `pg:backups:capture` before every ODB promotion; migration-test.yml restores production backups). Also Cloudcube (S3) and Mailgun add-ons (ODB-README) | All three process types share the one Postgres. Default Skunk pool per process = `availableProcessors × 2 + 1` (Config.scala `Default.MaxConnections`), overridable via `ODB_MAX_CONNECTIONS` / `OBSCALC_MAX_CONNECTIONS` / `CALIBRATIONS_MAX_CONNECTIONS` — so DB connection demand ≈ Σ(pool × dynos) across the three types, bounded by the plan's connection limit (§3) |
| obscalc worker | same app, `obscalc` process type — from-repo-config | (see ODB row) | **unknown** | shares the ODB Postgres | separate image (`noirlab/obscalc-service`), same `DATABASE_URL` |
| calibrations worker | same app, `calibration` process type — from-repo-config | (see ODB row) | **unknown** | shares the ODB Postgres | separate image (`noirlab/calibrations-service`) |
| SSO | `lucuma-sso-production` — from-repo-config (ci.yml default `lucuma-sso` + `-production`, promote.sh `image_name["SSO"]`); public entry point `https://sso.gpp.gemini.edu` is Heroku-routed — verified-by-probe. Bare `lucuma-sso-production.herokuapp.com` answers "No such app" — inferred: the app was created after Heroku switched default domains to hashed names (`<app>-<hash>.herokuapp.com`), so the bare domain proves nothing either way | `web` — from-repo-config | **unknown** | Heroku Postgres, plan **unknown** — existence from-repo-config (promote.sh `backup["SSO"]=true` → `pg:backups:capture` on the app) | JWT lifetime hardcoded 10 min; ORCID OAuth upstream |
| ITC | `itc-production` — verified-by-probe (bare domain serves); public entry `https://itc.gpp.gemini.edu/itc` Heroku-routed — verified-by-probe | `web` — from-repo-config | **unknown** | **Redis Cloud** add-on (Redis Labs), plan **unknown** — from-repo-config (`REDISCLOUD_URL` in itc Config.scala; ITC-README names the "Redis Cloud" Heroku add-on, `volatile-lru` eviction). **No Postgres** (promote.sh `backup["ITC"]=false`; no `DATABASE_URL` in its config) | Pure-function result cache; cold cache = recompute, so load-test realism depends on cache-hit mix more than dyno count |
| Resource service | `lucuma-resource-production` — from-repo-config (ci.yml default `lucuma-resource` + `-production`, promote.sh); bare domain "No such app" (same hashed-domain caveat as SSO) | `web` — from-repo-config | **unknown** | none known (promote.sh `backup["RESOURCE"]=false`) | not called by ODB; only Explore/clients |
| Prefs (Hasura) | app name **unknown**; `https://prefs.gpp.gemini.edu` is Heroku-routed — verified-by-probe (promote.sh applies Hasura migrations against it) | — | **unknown** | Hasura ⇒ has a Postgres, plan **unknown** | Explore-only dependency; not in the ODB request path |

**Autoscaling:** no autoscaling configuration or tooling exists anywhere in gemini-hlsw repos (searched); whether Heroku's native autoscaling (Performance/Private dynos only) is enabled is **unknown**.

**Verified live behavior (2026-09-02):** `lucuma-postgres-odb-production.herokuapp.com` and `itc-production.herokuapp.com` return an app-served plain-text 404 with `Server: Heroku`, `Via: 1.1 heroku-router` (app up, no route at `/`); `sso.gpp.gemini.edu`, `itc.gpp.gemini.edu`, `prefs.gpp.gemini.edu` all return `via: 2.0 heroku-router`.

## 2. Why the repos can't answer the sizing question

- **No app.json / Procfile / heroku.yml** in lucuma-odb (searched; deployment is container-registry-based per DEPLOYMENT.md). Process types are declared implicitly by which image is pushed to which registry path.
- **promote.sh** ([lucuma-apps](https://github.com/gemini-hlsw/lucuma-apps/blob/main/promote.sh)) promotes by `PATCH /apps/<app>/formation` with only `{"type", "docker_image"}` — dyno `size` and `quantity` are never in version control.
- Org-wide code search for `ps:scale`, `standard-2x`, `performance-m`, `pg:info`, `autoscal` finds nothing relevant (the only `performance-m` hit is Explore's retired `HEROKU.md` static-site setup).
- So the numbers live exclusively in the Heroku dashboard/API for the `gemini-hlsw` (Gemini) Heroku team.

## 3. Heroku plan reference (Dev Center, fetched 2026-09-02)

For interpreting whatever `heroku ps` / `pg:info` reports, and for scaling the load target once real values are known.

**Dynos (Common Runtime, "Cedar" classic tiers):**

| Plan | RAM | CPU | $/mo | Dedicated |
|---|---|---|---|---|
| Standard-1X | 0.5 GB | 1x share | $25 | no |
| Standard-2X | 1 GB | 2x share | $50 | no |
| Performance-M | 2.5 GB | 100%, 12x | $250 | yes |
| Performance-L | 14 GB | 100%, 50x | $500 | yes |
| Performance-L-RAM | 30 GB | 100%, 24x | $500 | yes |

(The newer "Fir" generation uses `dyno-<n>c-<m>gb` names, e.g. `dyno-2c-8gb` at $160/mo; only Performance/Private/Fir dynos support Heroku autoscaling.)

**Heroku Postgres (connection limit is the load-relevant number):**

| Plan | RAM | Storage | Connection limit | Notes |
|---|---|---|---|---|
| Essential-0/1 | — | 1/10 GB | **20** | implausible for prod ODB |
| Essential-2 | — | 32 GB | 40 | |
| Standard-0 / Premium-0 | 4 GB | 64 GB | **200** | |
| Standard-2 / Premium-2 | 8 GB | 256 GB | **500** | |
| Standard-3+ / Premium-3+ | 15 GB+ | 512 GB+ | 500 | limit caps at 500 for all higher tiers |

Heroku no longer publishes per-plan IOPS; Standard vs Premium differ in HA/failover, not throughput class.

**Connection arithmetic (inferred):** with the default pool of `2×cores+1` per process type, e.g. 2 × Performance-M web dynos (8 host cores visible to the JVM is common on Heroku) + 1 obscalc + 1 calibration could already approach a Standard-0's 200-connection cap — which is exactly why `ODB_MAX_CONNECTIONS` exists as an override. Whether production sets it is part of the ask below.

## 4. What to ask of whom

The fastest unblock, in order:

1. **Carlos himself:** `heroku login` locally (the existing `~/.netrc` Heroku entries are stale — the CLI gets `401 Invalid credentials`, which looks like an expired token, not absent access). Then run, read-only:
   ```
   for app in lucuma-postgres-odb-production lucuma-sso-production itc-production lucuma-resource-production; do
     heroku ps -a $app; heroku addons -a $app; heroku pg:info -a $app
   done
   heroku config -a lucuma-postgres-odb-production | grep -E 'MAX_CONNECTIONS'
   ```
2. **If no team access:** anyone who runs `promote.sh … production` has everything needed (the script does `heroku container:login` and `pg:backups:capture` against production) — i.e. the lucuma-odb maintainers / Gemini software group; per promote.sh, deploy notifications go to the `#gpp` Slack channel, so that's the place to ask. The GitHub org secret `HEROKU_API_KEY` (used by ci.yml and migration-test.yml) is owned by the gemini-hlsw org admins.
3. **Exact questions** (all answered by the commands in item 1):
   - dyno **type and quantity** per process type on each of the four apps, and whether autoscaling is enabled (and its thresholds);
   - `pg:info` for the ODB and SSO databases: plan, PG version, current connections vs limit, data size, cache hit rate;
   - the **Redis Cloud plan** on `itc-production` (memory limit, connection limit);
   - whether any app runs in a **Private Space** vs the Common Runtime (changes router behavior under load);
   - whether `ODB_MAX_CONNECTIONS` / `OBSCALC_MAX_CONNECTIONS` / `CALIBRATIONS_MAX_CONNECTIONS` are set in production config.

## 5. What the load target (ticket 016) can already mirror

Even before the numbers arrive, the production **shape** is fixed and mirrorable: four services with ODB+obscalc+calibration sharing one Postgres, SSO on its own Postgres, ITC on Redis-only, all behind Heroku's router (request timeout 30 s, one router hop). The unknowns are pure scale factors (dyno RAM/CPU × count, PG connection cap), so the target can be built now and re-sized in one variable change when the `heroku ps`/`pg:info` output lands. The existing AWS/compose sizing work in [`research/aws-load-target-options.md`](aws-load-target-options.md) (§ measured footprints) stays valid as the lower bound.
