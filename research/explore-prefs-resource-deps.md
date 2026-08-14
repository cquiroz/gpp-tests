# Explore dependencies: preferences DB, resource service, SSO scheme

Research date: 2026-08-14. Sources: `gemini-hlsw/lucuma-apps` (branch `main`), `gemini-hlsw/lucuma-odb`, `gemini-hlsw/clue`, `gemini-hlsw/lucuma-ui` — all read from shallow clones of `main`.

## Summary

1. **Preferences DB is a startup blocker, not a graceful degradation.** Explore connects to the prefs websocket in parallel with the ODB websocket inside `GraphQLClients.init`, and lucuma-ui's `ConnectionManager` refuses to render the logged-in app until *both* connect. With Explore's unbounded exponential-backoff reconnection strategy, `connect()` on an unreachable endpoint never completes and never fails — the user gets the login form, logs in, and then hangs on the default pending render (spinner) forever. Once *connected*, though, preference *data* degrades gracefully: every read falls back to defaults on error and every write is fire-and-forget. The prefs service itself is not a separate repo — it is a stock Hasura (GraphQL Engine) instance in front of Postgres, with full config/migrations/metadata versioned in `lucuma-apps/explore/hasura/user-prefs/`. It is deployable as a stock Hasura container + Postgres + `hasura migrate apply` / `hasura metadata apply`, and Explore connects to it with **no auth payload**.
2. **Resource service: zero references in Explore.** Neither the Explore source nor `environments.conf.json` mentions it. It lives in `lucuma-odb/resource/` ("telescope calendar and configuration/resource manager, e.g. ICTD replacement", port 8484, `lucuma-resource-*` Heroku apps) and is not needed for login, create-program, or create-observation. (Don't confuse it with the ODB's internal per-program "resource count/limit" columns, which are plain ODB Postgres.)
3. **Explore does not hardcode https for SSO** — the browser client uses `sso.uri` from config verbatim (fetch with `credentials: include`), and the maintainers' own local workflow runs Explore at `http://local.lucuma.xyz:8080`. On the server side, `sso-service` sets the session cookie's `Secure`/`HttpOnly` flags from `config.scheme === https`; the scheme is `http` (flags off) only in the `Local` environment and hardcoded `https` in every other environment. So a plain-http throwaway SSO works cookie-wise **iff** it runs as `LUCUMA_SSO_ENVIRONMENT=local` (or a patched config), and — because the cookie is `SameSite=Strict` with a fixed `local.lucuma.xyz` domain in Local mode — the browser must reach both Explore and SSO on hosts under the same registrable domain (the stock recipe: `/etc/hosts` alias `local.lucuma.xyz -> 127.0.0.1`).

---

## 1. Preferences DB

### Where the client is created

- Config field: [`explore/common/src/main/scala/explore/model/AppConfig.scala`](https://github.com/gemini-hlsw/lucuma-apps/blob/main/explore/common/src/main/scala/explore/model/AppConfig.scala) decodes `preferencesDBURI` from [`explore/common/src/main/public/environments.conf.json`](https://github.com/gemini-hlsw/lucuma-apps/blob/main/explore/common/src/main/public/environments.conf.json) (dev: `wss://gpp-prefs-dev.lucuma.xyz/v1/graphql`, staging: `wss://prefs-test.gpp.gemini.edu/...`, prod: `wss://prefs.gpp.gemini.edu/...`). Locally overridable via `EXPLORE_PREFS_URI` (applied in [`explore/app/src/main/webapp/main.jsx`](https://github.com/gemini-hlsw/lucuma-apps/blob/main/explore/app/src/main/webapp/main.jsx), only when the page host matches `local.lucuma.xyz` / `local.gemini.edu`).
- Client construction: [`explore/app/src/main/scala/explore/model/GraphQLClients.scala`](https://github.com/gemini-hlsw/lucuma-apps/blob/main/explore/app/src/main/scala/explore/model/GraphQLClients.scala) —
  `WebSocketJsClient.of[F, UserPreferencesDB](prefsURI.toString, "PREFS", reconnectionStrategy)` (clue websocket client). Note `init`:

  ```scala
  def init(payload: F[Map[String, Json]]): F[Unit] =
    (preferencesDB.connect(), odb.connect(payload)).parTupled.void
  ```

  The prefs client is connected **with no auth payload** (`connect()` = empty init payload) — the Hasura endpoint is effectively unauthenticated from Explore's point of view.
- Wired in [`explore/app/src/main/scala/explore/model/AppContext.scala`](https://github.com/gemini-hlsw/lucuma-apps/blob/main/explore/app/src/main/scala/explore/model/AppContext.scala) (`GraphQLClients.build[F](config.odbURI, config.preferencesDBURI, ...)`).

### What happens if the endpoint is unreachable

- The reconnection strategy in [`explore/app/src/main/scala/explore/Explore.scala`](https://github.com/gemini-hlsw/lucuma-apps/blob/main/explore/app/src/main/scala/explore/Explore.scala) (~line 118) **always returns `Some(delay)`** (exponential backoff, 1s → capped 60s, unbounded attempts).
- In clue ([`core/src/main/scala/clue/websocket/ApolloClient.scala`](https://github.com/gemini-hlsw/clue/blob/master/core/src/main/scala/clue/websocket/ApolloClient.scala), `connect`/`doConnect`/`handleRetry`): `connect()` completes only when the latch is released by the server's `connection_ack`. On a failed attempt, `handleRetry` consults the reconnection strategy; because Explore's strategy never returns `None`, the client stays in `Connecting` and retries forever — the `connect()` effect **never completes and never raises**.
- The connect is gated on login by `IfLogged` → `ConnectionManager` in lucuma-ui ([`modules/ui/ui/src/main/scala/lucuma/ui/components/state/ConnectionManager.scala`](https://github.com/gemini-hlsw/lucuma-ui/blob/main/modules/ui/ui/src/main/scala/lucuma/ui/components/state/ConnectionManager.scala)):

  ```scala
  .useResourceOnMountBy: (props, _, payloadRef) => // Returns Pot[Unit]; Ready when connected.
    Resource.make(props.openConnections(payloadRef.getAsync))(_ => props.closeConnections) >>
      Resource.eval(props.onConnect)
  .render: (_, children, _, connectedPot) =>
    connectedPot.renderPot(_ => children)
  ```

  `openConnections` is `ctx.clients.init(_)` (passed at [`ExploreLayout.scala` ~line 300](https://github.com/gemini-hlsw/lucuma-apps/blob/main/explore/app/src/main/scala/explore/ExploreLayout.scala)). Children — the entire logged-in UI — render only when the Pot is Ready, i.e. when **both** ODB and prefs websockets have connected.

- **Net behavior**: the app shell and login form load fine (prefs not involved); after the user picks a login, the UI sits at the default pending render (spinner) indefinitely if the prefs websocket cannot connect. So an unreachable `preferencesDBURI` effectively **blocks the app post-login**, despite preferences being described as non-critical.

### Graceful degradation exists only at the data layer (once connected)

- [`explore/app/src/main/scala/explore/common/UserPreferencesQueries.scala`](https://github.com/gemini-hlsw/lucuma-apps/blob/main/explore/app/src/main/scala/explore/common/UserPreferencesQueries.scala): reads use `.handleError(_ => none)` then `.getOrElse(GlobalPreferences.Default)` / default layouts / `Transformation.Default`; writes/mutations end in `.attempt` (errors swallowed).
- [`explore/app/src/main/scala/explore/cache/PreferencesCacheController.scala`](https://github.com/gemini-hlsw/lucuma-apps/blob/main/explore/app/src/main/scala/explore/cache/PreferencesCacheController.scala): merges query results over `ExploreGridLayouts.DefaultLayouts`, subscriptions use `.ignoreGraphQLErrors`.
- The per-user prefs "profile" insert on login (`createUserPrefs` in [`ExploreLayout.scala` ~line 260](https://github.com/gemini-hlsw/lucuma-apps/blob/main/explore/app/src/main/scala/explore/ExploreLayout.scala)) is `.start.void` — fire-and-forget, non-blocking.
- [`explore/USERPREFS.md`](https://github.com/gemini-hlsw/lucuma-apps/blob/main/explore/USERPREFS.md): "This is not considered critical and we would take the freedom of deleting the preferences if it makes the transition simpler."

### What the prefs service is

- **No separate repo.** Everything lives in `lucuma-apps/explore/`:
  - [`explore/hasura/user-prefs/`](https://github.com/gemini-hlsw/lucuma-apps/tree/main/explore/hasura/user-prefs) — Hasura CLI project (`config.yaml` v3, `metadata/`, `migrations/default/` with ~48 timestamped migrations from `1664379876162_init` onward, `migrateDev.sh`/`migrateMaster.sh`).
  - [`explore/USERPREFS.md`](https://github.com/gemini-hlsw/lucuma-apps/blob/main/explore/USERPREFS.md) — ops doc: it is **stock Hasura GraphQL Engine over Postgres** on Heroku (`user-prefs-master`, `user-prefs-development`, `user-prefs-staging`, `user-prefs`; fronted by `gpp-prefs-dev.lucuma.xyz` etc.), updated with `hasura migrate apply` + `hasura metadata apply` + `hasura metadata reload`.
  - Required Hasura env vars: `HASURA_GRAPHQL_EXPERIMENTAL_FEATURES=naming_convention`, `HASURA_GRAPHQL_DEFAULT_NAMING_CONVENTION=graphql-default`.
  - [`explore/fetchUserPreferencesSchema.sh`](https://github.com/gemini-hlsw/lucuma-apps/blob/main/explore/fetchUserPreferencesSchema.sh) regenerates the client schema; [`explore/db.sql`](https://github.com/gemini-hlsw/lucuma-apps/blob/main/explore/db.sql) is a small legacy bootstrap (88 lines), the real schema comes from the migrations.
- **Deployable as stock Hasura container + Postgres + migrations: yes.** `docker run hasura/graphql-engine` with the two naming-convention env vars + a Postgres `DATABASE_URL`, then `hasura migrate apply --database-name default` and `hasura metadata apply` from `explore/hasura/user-prefs/`. Since Explore sends no auth payload on the websocket, the instance must accept unauthenticated queries (the deployed instances evidently run without requiring a client-side admin secret/JWT; table metadata in the repo defines no role-based permissions, i.e. access is admin/unauthenticated-role level).

## 2. Resource service

- **Not referenced by Explore at all.** `grep -ri '8484|lucuma-resource|resource.service'` over `lucuma-apps/explore` returns nothing; `environments.conf.json` has only `odbURI`, `odbRestURI`, `preferencesDBURI`, `itcURI`, `sso.uri`, `otelEndpoint`. The only hit in `lucuma-apps` is the ops helper [`promote.sh`](https://github.com/gemini-hlsw/lucuma-apps/blob/main/promote.sh) (`image_name["RESOURCE"]="lucuma-resource"`), which is a deployment convenience for the whole GPP fleet, not an Explore runtime dependency.
- The service itself lives in **`lucuma-odb/resource/`** ([README](https://github.com/gemini-hlsw/lucuma-odb/blob/main/resource/README.md)): "a combination telescope calendar and configuration/resource manager (e.g. ICTD replacement)". Standalone Grackle/Skunk GraphQL service, own Postgres (`DATABASE_URL`), port 8484 (`build.sbt`: `reStart / envVars += "PORT" -> "8484"`, `dockerExposedPorts ++= Seq(8484)`), SSO env vars `RESOURCE_SSO_ROOT` / `RESOURCE_SSO_PUBLIC_KEY` / `RESOURCE_SSO_SERVICE_JWT`. CI pushes it to Heroku apps `lucuma-resource-dev` / `-staging` (`lucuma-odb/.github/workflows/ci.yml`).
- **Not needed for core flows** (login, create program, create observation): those go through SSO + the ODB GraphQL service only. The similarly named "program resource limit/count" in the ODB (`ProgramService.scala`, `V1182__program_resource_limit.sql`, error tag `program_resource_limit_exceeded`) is internal ODB Postgres bookkeeping — unrelated to the resource service.

## 3. SSO scheme from the browser

### Client side (Explore / lucuma-ui)

- Explore takes `sso.uri` from config verbatim (`SSOConfig` inside `AppConfig`); the browser client [`lucuma-ui .../lucuma/ui/sso/SSOClient.scala`](https://github.com/gemini-hlsw/lucuma-ui/blob/main/modules/ui/ui/src/main/scala/lucuma/ui/sso/SSOClient.scala) builds every request from `config.uri` (`/api/v1/refresh-token`, `/api/v1/auth-as-guest`, `/auth/v1/stage1`, `/auth/v1/set-role`, `/api/v1/logout`) with `FetchClientBuilder.withCredentials(RequestCredentials.include)`. **No scheme is hardcoded or checked** — an `http://` `sso.uri` is used as-is. (Contrast: Simbad requests do force https via `_.copy(scheme = Scheme.https.some)` in `AppContext.scala`; nothing similar for SSO.)
- The maintainers' local workflow is plain http: [`explore/README.md`](https://github.com/gemini-hlsw/lucuma-apps/blob/main/explore/README.md) runs the app at `http://local.lucuma.xyz:8080/` with `/etc/hosts` alias `127.0.0.1 local.lucuma.xyz`, and documents `EXPLORE_SSO_URI` (plus `EXPLORE_PREFS_URI`, `EXPLORE_ODB_URI`, ...) overrides.

### Server side (lucuma-odb `modules/sso-service`) — cookie attributes

- Session cookie construction: [`modules/sso-service/src/main/scala/CookieService.scala`](https://github.com/gemini-hlsw/lucuma-odb/blob/main/modules/sso-service/src/main/scala/CookieService.scala):

  ```scala
  ResponseCookie(
    name     = CookieName,          // "lucuma-refresh-token"
    domain   = Some(domain),
    sameSite = Some(SameSite.Strict),
    secure   = secure,
    httpOnly = secure,              // note: HttpOnly tied to the same flag
    path     = Some("/"),
  )
  ```

- The `secure` flag comes from the deployment scheme: [`Main.scala` ~line 230](https://github.com/gemini-hlsw/lucuma-odb/blob/main/modules/sso-service/src/main/scala/Main.scala): `CookieService[F](config.cookieDomain, config.scheme === Scheme.https)`.
- The scheme is environment-derived, [`config/Config.scala`](https://github.com/gemini-hlsw/lucuma-odb/blob/main/modules/sso-service/src/main/scala/config/Config.scala):
  - `Environment.Local` (the default when `LUCUMA_SSO_ENVIRONMENT` is unset): `Uri.Scheme.http`, cookieDomain/hostname hardcoded `local.lucuma.xyz`, port 8080, random in-memory RSA keypair. → cookie has **`Secure` off and `HttpOnly` off** — works over plain http.
  - Any other environment (`review`/`staging`/`production`): scheme **hardcoded `Uri.Scheme.https`** → `Secure` (and `HttpOnly`) on; the refresh-token cookie would simply never be sent by the browser over plain http, breaking `refresh-token`/`set-role`/`logout`.
- CORS allows http origins: [`modules/common-middleware/.../CorsMiddleware.scala`](https://github.com/gemini-hlsw/lucuma-odb/blob/main/modules/common-middleware/src/main/scala/lucuma/common/middleware/CorsMiddleware.scala) — `withAllowCredentials(true)`, origin allowed if host equals or is a subdomain of the configured domain; the https-only restriction (`corsOverHttps`) defaults to **false**, and sso-service calls it as `CorsMiddleware.cors(domain = List(config.cookieDomain))` (`ServerMiddleware.scala` line 51).

### Verdict for a plain-http throwaway SSO

- Works, with three constraints:
  1. Run sso-service with `LUCUMA_SSO_ENVIRONMENT` unset/`local` (http scheme → non-Secure cookie), or patch `Config` if you need a non-local env over http.
  2. `SameSite=Strict` + `domain=local.lucuma.xyz` (fixed in Local mode) means Explore and SSO must be reached under the same registrable domain — e.g. Explore at `local.lucuma.xyz:8080`, SSO at `local.lucuma.xyz:8081`. `localhost` for one and `local.lucuma.xyz` for the other would be cross-site and the cookie would not flow.
  3. `Config.local` still requires ORCID env vars (`LUCUMA_ORCID_CLIENT_ID`/`SECRET` via `OrcidConfig.config(Local)` — no defaults, README: "we can't fake this part"), even if you only use guest login. Guest login itself (`POST /api/v1/auth-as-guest`, `Routes.scala` line 81) needs no ORCID round-trip: it returns the JWT in the body and sets the refresh cookie.
- Also note: JWTs travel as `Authorization: Bearer` headers over the ODB websocket / GraphQL calls (see `UserVault.authorizationHeader`, `ConnectionManager.payload`), so nothing besides the SSO refresh cookie is scheme-sensitive. In Local mode the SSO signs JWTs with a **random per-boot keypair**, so any service validating those JWTs (ODB, resource) must be pointed at that same local SSO's public key.

## Open questions / caveats

- **Not verified at runtime**: the "hangs forever on unreachable prefs" conclusion is from code reading (clue `handleRetry` + `ConnectionManager` gating + always-`Some` backoff). Edge cases (e.g. how the JS `WebSocket` error path differs between DNS failure, TLS failure, and TCP refusal) were not exercised; all funnel through clue's `onClose`/connect-failure path, but timing differs. A 2-minute test with `EXPLORE_PREFS_URI=ws://127.0.0.1:1/v1/graphql` would confirm.
- **Hasura auth posture**: the repo's table metadata defines no per-role select/insert permissions and Explore connects without credentials; I did not find the deployed instances' env (whether `HASURA_GRAPHQL_ADMIN_SECRET`/`HASURA_GRAPHQL_UNAUTHORIZED_ROLE` are set server-side, or whether an edge proxy injects anything). For a self-hosted stock container you'd have to run it effectively open (or replicate whatever the deployed proxy does) for Explore to connect as-is.
- **Prefs schema drift**: Explore's generated `UserPreferencesDB` schema must match the Hasura metadata; deploy from the same commit's `hasura/user-prefs` as the Explore build (`fetchUserPreferencesSchema.sh` regenerates the client side).
- **`connection_init` payload on prefs**: `preferencesDB.connect()` sends an empty graphql-ws init payload; if a future Hasura config requires a JWT in the init payload, the current Explore code has nowhere to supply it.
- **SameSite nuance**: same-site is judged by registrable domain (`lucuma.xyz`, `gemini.edu`), so the production split (explore.gemini.edu vs sso.gpp.gemini.edu) is same-site; a throwaway must reproduce that property.
- The `promote.sh` fleet script and Heroku app naming were only skimmed; whether any *other* lucuma app in the monorepo (observe, sequencer UI) talks to the resource service was not exhaustively checked — Explore does not.
