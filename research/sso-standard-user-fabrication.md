# Fabricating standard SSO users without ORCID

**Written:** 2026-08-25. **Status:** implemented and verified — the recipe below is
[`stack/scripts/create-standard-users.sh`](../stack/scripts/create-standard-users.sh), run
against a live stack the same day: the fabricated PI's JWT was accepted by the ODB
(`createProgram` succeeded, role honored), the fabricated session's cookie got a 200 + JWT
from `POST /api/v1/refresh-token`, and re-running reused the same rows. All three gating
items from [`orcid-auth-testing-strategy.md`](orcid-auth-testing-strategy.md) §"open work
item" traced to source. Unblocks tiers 2 and 3 of that note's ladder. Grounding is primary source only:
the Scala and SQL of `gemini-hlsw/lucuma-odb` at commit
[`62e6989`](https://github.com/gemini-hlsw/lucuma-odb/tree/62e69890b6c6d60c0eb9f7e4ed441af91c6e2a5a)
(SSO now lives in `modules/sso-service` + `modules/sso-backend-client` +
`modules/sso-frontend-client`; the old `lucuma-sso` repo is archived), plus
`lucuma.core.model.OrcidId` from `gemini-hlsw/lucuma-core@main`.

All `file:line` citations below are at SHA `62e6989` unless noted. GitHub link prefix:
`https://github.com/gemini-hlsw/lucuma-odb/blob/62e69890b6c6d60c0eb9f7e4ed441af91c6e2a5a/`.

## Summary

Standard users can be fabricated entirely with SQL against the SSO Postgres database we
own, then handed to tests two ways: (a) mint a 1-hour JWT with the `create-jwt <role-id>`
CLI for API-level tests, or (b) inject the `lucuma-refresh-token` cookie for browser tests.
**The refresh token is stored unhashed** — the DB column is the raw session UUID, identical
to the cookie value — so both the strategy note's tier 2 and tier 3 are confirmed feasible,
and no prior assumption turned out wrong. The one non-obvious constraint: although the DB
column for ORCID iD is an unchecked `varchar`, the Scala read path decodes it through
`OrcidId.fromValue`, which enforces the ISO-7064 mod-11-2 checksum — so a fabricated ORCID
iD must have a valid check digit or `create-jwt`/`refresh-token` will crash when they read
the row back. The ODB trusts the signed JWT and its `lucuma-user` claim; it keeps its own
`t_user` table but populates it by upsert from the JWT on use (no pre-registration), so a
JWT for a DB-fabricated user is accepted with its role honored.

---

## 1. User / role tables and the fabrication SQL

Schema is three Flyway migrations under
[`modules/sso-service/src/main/resources/db/migration/`](https://github.com/gemini-hlsw/lucuma-odb/tree/62e69890b6c6d60c0eb9f7e4ed441af91c6e2a5a/modules/sso-service/src/main/resources/db/migration).

**Enums** (`V001__Initial_Schema.sql:5-11`):

- `lucuma_user_type` = `('guest','standard','service')`
- `lucuma_role_type` = `('pi','ngo','staff','admin')`
- `lucuma_ngo` = `('ar','br','ca','cl','gt','kr','lp','uh','us')`

**`lucuma_user`** (`V001:24-54`). Columns relevant to fabricating a *standard* user:

- `user_id lucuma_user_id PRIMARY KEY DEFAULT 'u-' || to_hex(nextval('lucuma_user_id_seq'))`
  — auto-generated `u-<hex>` GID; let the default assign it (`V001:23,26`).
- `user_type` — must be `'standard'`.
- `orcid_id lucuma_orcid_id UNIQUE` — **required** for standard users by CHECK
  (`V001:47-49`: guest/service must be NULL, everything else must be NOT NULL). The domain
  `lucuma_orcid_id` is a bare `character varying` with a `-- TODO format check`
  (`V001:14`), i.e. **the database performs no format or checksum validation**.
- `service_name` — must stay NULL for non-service users (CHECK `V001:44-45`).
- `orcid_access_token UUID`, `orcid_given_name`, `orcid_credit_name`, `orcid_family_name`,
  `orcid_email` — all nullable; supply names/email for a realistic profile, none required.
- `user_enabled BOOLEAN DEFAULT true`.
- Note `role_id` existed in V001 but is **dropped** in `V002:6-7`.

**`lucuma_role`** (`V001:58-81`). One row per role a user holds:

- `role_id lucuma_role_id PRIMARY KEY DEFAULT 'r-' || to_hex(nextval('lucuma_role_id_seq'))`
  — auto-generated `r-<hex>` GID (`V001:57,60`).
- `user_id` — FK to `lucuma_user(user_id,user_type)` MATCH FULL; the `user_type` column
  here defaults to `'standard'` and a CHECK pins it to `'standard'` (`V001:62,67-72`), so
  only standard users can own roles.
- `role_type lucuma_role_type NOT NULL`.
- `role_ngo lucuma_ngo` — **required iff `role_type='ngo'`, must be NULL otherwise**
  (CHECK `V001:75-76`). Uniqueness: one row per (user, non-ngo role_type) and one per
  (user, 'ngo', ngo) via partial unique indexes (`V001:90-95`).

**ORCID iD format constraint (enforced in Scala, not SQL).** The Skunk codec that reads
`orcid_id` back out decodes via `OrcidId.fromValue`
([`database/Codecs.scala:20-25`](https://github.com/gemini-hlsw/lucuma-odb/blob/62e69890b6c6d60c0eb9f7e4ed441af91c6e2a5a/modules/sso-service/src/main/scala/database/Codecs.scala#L20-L25)).
`OrcidId` requires the regex `\d{4}-\d{4}-\d{4}-\d{3}[\dX]` **and** a valid ISO-7064
mod-11-2 check digit (`lucuma-core` `OrcidId.scala`, `ValuePat` + `parseWith` + `checkDigit`).
The check-digit algorithm (reproduced in the SSO test helper
[`test/scala/orcid/OrcidIdGenerator.scala:23-31`](https://github.com/gemini-hlsw/lucuma-odb/blob/62e69890b6c6d60c0eb9f7e4ed441af91c6e2a5a/modules/sso-service/src/test/scala/orcid/OrcidIdGenerator.scala#L23-L31)):

```
total = fold over the 15 base digits: acc -> (acc + digit) * 2, from 0
remainder = total % 11
result = (12 - remainder) % 11
checkDigit = if result == 10 then "X" else result.toString
```

Consequence: you can INSERT any string into the column, but if you later `create-jwt` or hit
`refresh-token` for that user, the read decodes the ORCID iD and a bad checksum raises. Use a
checksum-valid iD. `0000-0002-1825-0097` (ORCID's own documentation example) is valid.

**Exact fabrication SQL** (standard PI user; let all GIDs default):

```sql
-- (1) the user. orcid_id must pass the ISO-7064 checksum (see above).
INSERT INTO lucuma_user (user_type, orcid_id, orcid_given_name, orcid_family_name, orcid_email)
VALUES ('standard', '0000-0002-1825-0097', 'Test', 'Pi', 'test-pi@example.test')
RETURNING user_id;                       -- e.g. u-1a3

-- (2) the role. role_type in ('pi','staff','admin') => role_ngo stays NULL.
INSERT INTO lucuma_role (user_id, role_type)
VALUES ('u-1a3', 'pi')                   -- user_type defaults to 'standard'
RETURNING role_id;                       -- e.g. r-2b7
```

For an NGO role, include the partner: `INSERT INTO lucuma_role (user_id, role_type, role_ngo)
VALUES ('u-1a3','ngo','us')`. For staff/admin, just change `role_type`. A user may hold
several roles (several rows); the "active" role is chosen at session/JWT time, below.

**How the ODB learns about users.** The ODB does **not** require pre-registration and does
**not** call back to the SSO DB for standard users. It trusts the signed JWT: `sso-backend-client`
decodes the `Authorization: Bearer` JWT, verifies its RSA signature against the SSO public
key, and reads the `User` out of the `lucuma-user` claim
([`SsoJwtReader.scala:99-114`](https://github.com/gemini-hlsw/lucuma-odb/blob/62e69890b6c6d60c0eb9f7e4ed441af91c6e2a5a/modules/sso-backend-client/src/main/scala/SsoJwtReader.scala#L99-L114),
[`SsoClient.scala:136-148`](https://github.com/gemini-hlsw/lucuma-odb/blob/62e69890b6c6d60c0eb9f7e4ed441af91c6e2a5a/modules/sso-backend-client/src/main/scala/SsoClient.scala#L136-L148)).
The ODB *does* keep its own `t_user` table, but it **upserts from the JWT-derived user** via
`UserService.canonicalizeStandardUser` — `insert into t_user (...) values (...) on conflict
(c_user_id) do update ...`
([`modules/service/.../UserService.scala:79-108`](https://github.com/gemini-hlsw/lucuma-odb/blob/62e69890b6c6d60c0eb9f7e4ed441af91c6e2a5a/modules/service/src/main/scala/lucuma/odb/service/UserService.scala#L79-L108)).
So the SSO user id + role in the JWT is the source of truth; the ODB's row is a mirror
created on first use. A JWT for a DB-fabricated user is accepted and its role honored.

---

## 2. Sessions / refresh token / cookie

**Table `lucuma_session`** (`V002__Refresh_Token.sql:12-35`):

- `refresh_token uuid PRIMARY KEY DEFAULT uuid_generate_v1()` — this *is* the session token.
- `user_id`, `user_type` (CHECK: only `'standard'` or `'guest'`), `role_id` (nullable, but a
  CHECK requires it non-null unless the session is a guest: `V002:33`).
- FKs cascade on delete of user or role (`V002:21-30`).
- **No hash column, no expiry column, no rotation column.** The stored value is the raw UUID.

**The token is not hashed and not a JWT.** The cookie carries the plaintext session UUID and
the DB stores that same UUID verbatim. This is the decisive fact for tier 3: we can fabricate
a session by inserting a row and read `refresh_token` straight back as the cookie value. There
is no server-held secret in the loop.

**Cookie** ([`CookieService.scala`](https://github.com/gemini-hlsw/lucuma-odb/blob/62e69890b6c6d60c0eb9f7e4ed441af91c6e2a5a/modules/sso-service/src/main/scala/CookieService.scala)):

- Name: `lucuma-refresh-token` (`CookieReader.CookieName`, `CookieService.scala:47`).
- Value: `token.value.toString()` — the session UUID, plain (`CookieService.scala:108-112`).
- Attributes (`CookieService.scala:97-112`): `domain = <config.cookieDomain>`, `path = "/"`,
  `sameSite = Strict`, `secure = (scheme === https)`, `httpOnly = (scheme === https)`,
  `expires = HttpDate.MaxValue` (effectively non-expiring). In a normal https stack that
  means Secure + HttpOnly + SameSite=Strict.
- Decode on the way in (`CookieService.scala:58-61`): the cookie content is parsed with
  `UUID.fromString`; anything not a UUID raises. `SessionToken` is just `case class
  SessionToken(value: UUID)` ([`SessionToken.scala:10`](https://github.com/gemini-hlsw/lucuma-odb/blob/62e69890b6c6d60c0eb9f7e4ed441af91c6e2a5a/modules/sso-service/src/main/scala/SessionToken.scala#L10)).

**`POST /api/v1/refresh-token`** ([`Routes.scala:68-78`](https://github.com/gemini-hlsw/lucuma-odb/blob/62e69890b6c6d60c0eb9f7e4ed441af91c6e2a5a/modules/sso-service/src/main/scala/Routes.scala#L68-L78)):
reads the cookie → `SessionToken` → `db.findUserFromToken(tok)` → if found, mints a fresh JWT
and returns it as the body (200). No cookie rotation happens here — the same refresh cookie
keeps working. `findUserFromToken` tries standard then guest
([`Database.scala:162-169`](https://github.com/gemini-hlsw/lucuma-odb/blob/62e69890b6c6d60c0eb9f7e4ed441af91c6e2a5a/modules/sso-service/src/main/scala/database/Database.scala#L162-L169));
the standard lookup `SelectStandardUserByToken` joins session→user→role on `refresh_token`
and requires `user_type='standard'` (`Database.scala:488-533`). **Expiry/rotation:** the JWT
itself is short-lived (see §3); the *session* row has no expiry — it lives until deleted. New
tokens are minted (`InsertStandardUserSessionToken`, `Database.scala:607-615`) on login and
`set-role`, but plain refresh does not rotate the cookie.

**Fabricate a session row** for the role created in §1 (`refresh_token` auto-generated):

```sql
INSERT INTO lucuma_session (user_id, user_type, role_id)
VALUES ('u-1a3', 'standard', 'r-2b7')
RETURNING refresh_token;                 -- e.g. 5b6e...-... : this is the cookie value
```

This is byte-for-byte what `createStandardUserSessionToken` runs
(`Database.scala:607-615`) minus the `WHERE role_id = ...` lookup — equivalently you can run
`SELECT user_id, user_type, role_id FROM lucuma_role WHERE role_id='r-2b7'` into the insert.
Which role_id you put in the session picks the *active* role in the JWT.

**Playwright cookie injection** (`context.addCookies` before first navigation):

```js
await context.addCookies([{
  name: 'lucuma-refresh-token',
  value: refreshTokenUuid,          // the RETURNING value above, as a lowercase UUID string
  domain: cookieDomain,             // == LUCUMA_SSO_COOKIE_DOMAIN of the running stack
  path: '/',
  sameSite: 'Strict',
  secure: true,                     // https stack
  httpOnly: true,
  expires: -1,                      // session cookie; or a far-future epoch for "non-expiring"
}]);
```

`cookieDomain` must equal the stack's `LUCUMA_SSO_COOKIE_DOMAIN`. In the local canned config
it is `local.lucuma.xyz` (`Config.local`, `Config.scala:86-99`); in the ephemeral stack it is
set from the environment (`Config.scala:119`). Because SSO, Explore, and the ODB all share
one registrable domain, `SameSite=Strict` is sent on Explore's same-site
`POST /api/v1/refresh-token` fetch, so Explore's refresh flow works from the injected cookie.

---

## 3. `create-jwt`, JWT shape, and what the ODB checks

**CLI entrypoint** is `Main.scala`
([`Main.scala:76-135`](https://github.com/gemini-hlsw/lucuma-odb/blob/62e69890b6c6d60c0eb9f7e4ed441af91c6e2a5a/modules/sso-service/src/main/scala/Main.scala#L76-L135)),
a `decline` `CommandIOApp` with subcommands `serve`, `create-service-user`, `create-jwt`.
The container binary is `/opt/docker/bin/lucuma-sso-service` (per bootstrap.sh:130).

- **`create-jwt <role-id>`** (`Main.scala:116-126, 356-369`). The argument is parsed as a
  `StandardRole.Id` GID via `Gid[StandardRole.Id].fromString` — i.e. exactly the `r-<hex>`
  value returned by the §1 role insert (e.g. `r-2b7`); an invalid GID is rejected. It then
  `createStandardUserSessionToken(roleId)` → `getStandardUserFromToken` → `newJwt(usr,
  Some(1.hour))`. **It prints the JWT on its own line** after a warning banner
  (`Main.scala:365-368`), and the JWT is valid **1 hour**.
- **JWT claims** ([`SsoJwtWriter.scala:51-72`](https://github.com/gemini-hlsw/lucuma-odb/blob/62e69890b6c6d60c0eb9f7e4ed441af91c6e2a5a/modules/sso-service/src/main/scala/SsoJwtWriter.scala#L51-L72)):
  `issuer="lucuma-sso"`, `audience={"lucuma"}`, `subject = user id`, `exp/nbf/iat` set
  (10s skew pad), and `content` is a JSON object with one key `lucuma-user` whose value is
  the encoded `User` ([`SsoJwtClaim.lucumaUser = "lucuma-user"`](https://github.com/gemini-hlsw/lucuma-odb/blob/62e69890b6c6d60c0eb9f7e4ed441af91c6e2a5a/modules/sso-backend-client/src/main/scala/SsoJwtClaim.scala#L28)).
  A standard user serializes as
  `{"type":"standard","id":"u-…","role":{...},"otherRoles":[...],"profile":{...}}`
  ([`UserCodec.scala:32-39`](https://github.com/gemini-hlsw/lucuma-odb/blob/62e69890b6c6d60c0eb9f7e4ed441af91c6e2a5a/modules/sso-frontend-client/src/main/scala/lucuma/sso/client/codec/user/UserCodec.scala#L32-L39));
  the role is `{"type":"pi|ngo|staff|admin","id":"r-…"[,"partner":"…"]}`
  ([`RoleCodec.scala:19-24`](https://github.com/gemini-hlsw/lucuma-odb/blob/62e69890b6c6d60c0eb9f7e4ed441af91c6e2a5a/modules/sso-frontend-client/src/main/scala/lucuma/sso/client/codec/user/RoleCodec.scala#L19-L24)).
- **Default JWT lifetime** is `Config.JwtLifetime = 10.minutes` (`Config.scala:50`), used by
  the `refresh-token`/`auth-as-guest`/`set-role` routes. `create-jwt` overrides to 1 hour.

**What the ODB checks.** RSA-signature verification against the SSO public key plus a JSON
parse of the `lucuma-user` claim — nothing else, no DB lookup for standard users
(`SsoJwtReader.scala:76-114`, `SsoClient.getJwtInfo` `SsoClient.scala:136-148`, whose
`UserInfo` even `assert`s the round-trip). Therefore **a `create-jwt` token for a
DB-fabricated user is accepted and its role honored**, provided the JWT is signed by the same
keypair the ODB trusts. In this stack that is guaranteed because SSO both mints the token and
publishes the public key from the one throwaway keypair bootstrap generates — the same
invariant already exploited for the service JWT (see `lib/service-jwt.js` and
`stack/scripts/bootstrap.sh:124-165`). Run `create-jwt` in the *running* `sso` container
(`compose exec sso …`), exactly like `create-service-user`, so the signing key matches.

**`create-service-user <name>` for contrast** (`Main.scala:110-114, 337-354`): inserts/【upserts
a `service`-type user (`Database.CanonicalizeServiceUser`, `Database.scala:649-658`), prints a
JWT valid **20 years**, claim `lucuma-user` = `{"type":"service","id":"u-…","name":"…"}`
(`UserCodec.scala:26-31`). This is the token bootstrap already scrapes.

**API-key path (alternative long-lived credential).** Table `lucuma_api_key`
(`V003__Api_Key.sql`): `api_key_id` (hex GID), `user_id`, `role_id` (FK to `lucuma_role`),
and `api_key_hash CHAR(32)`. Keys are minted only by the DB function `insert_api_key(user_id,
role_id)` (`V003:19-29`), which generates a 96-hex-char body, stores `md5(body)` as the hash,
and returns `api_key_id || '.' || api_key` (cleartext, shown once). The wire format is
`\<idHex\>.\<96 hex chars\>` (`ApiKey.scala:30-57`,
[`ApiKey.scala:48-49`](https://github.com/gemini-hlsw/lucuma-odb/blob/62e69890b6c6d60c0eb9f7e4ed441af91c6e2a5a/modules/sso-backend-client/src/main/scala/ApiKey.scala#L48-L49)).
Two ways to obtain one:

- `POST /api/v1/create-api-key?role=<r-id>` with a standard-user JWT (`Routes.scala:127-137`),
  or the `createApiKey` GraphQL mutation — both call `insert_api_key`.
- Or fabricate directly in SQL: `SELECT insert_api_key('u-1a3','r-2b7');` returns the key
  string. (The hash is `md5`, no salt, no server secret — but generating via the function is
  simplest.)

An API key is exchanged for a JWT at `GET /api/v1/exchange-api-key?key=<key>` **using a
service-user JWT** as the caller credential (`Routes.scala:140-151`); the returned JWT is
valid **3 hours** (`Routes.scala:149`). The ODB's `sso-backend-client` does this exchange
transparently and caches the result, so a client can send the API key as its bearer token
directly (`SsoClient.scala:106-148`). This is the longest-lived non-service standard credential
and needs no cookie.

---

## 4. Guest→standard promotion + ORCID config

**Promotion (stage2)** happens in `Routes.scala:168-194` → `db.promoteGuestUser`
(`Database.scala:177-208`). If the incoming ORCID profile does not already exist, the path is
(`Database.scala:198-203`): delete the guest's session rows, run `PromoteGuest` which
`UPDATE lucuma_user SET user_type='standard', orcid_id=…, orcid_* = …` on the guest's row
(same `user_id`; `Database.scala:422-447`), then `addRole` inserts a `lucuma_role` row and
`createStandardUserSessionToken` inserts a fresh `lucuma_session` row. If the ORCID profile
*already* exists, the guest row is deleted and its programs are chowned to the existing user
(`Routes.scala:183-189`, `Database.scala:190-195`). So the rows that change: `lucuma_user`
(type flips guest→standard, ORCID fields filled), `lucuma_role` (new row), `lucuma_session`
(old guest rows deleted, new standard row inserted). The migration comment at `V002:37-39`
spells out the delete-then-reinsert-sessions dance.

**ORCID base URL is NOT overridable by env/config.**
[`OrcidConfig.scala:26-35`](https://github.com/gemini-hlsw/lucuma-odb/blob/62e69890b6c6d60c0eb9f7e4ed441af91c6e2a5a/modules/sso-service/src/main/scala/config/OrcidConfig.scala#L26-L35)
hardcodes the host by environment: `Local | Review => sandbox.orcid.org`,
`Staging | Production => orcid.org`. Only `LUCUMA_ORCID_CLIENT_ID` and `_SECRET` come from the
environment; the host does not. So the strategy note's **tier-4 precondition resolves the
pessimistic way**: a mock-ORCID container would require compose network aliases /DNS override
for `sandbox.orcid.org` plus JVM truststore surgery (SSO uses `sandbox.orcid.org` over TLS).
Confirmed not worth it unless tiers 2-3 prove insufficient.

---

## Practical recipe (what bootstrap would run)

Assume the stack is up and `stack/.env.generated` is sourced (so `compose` targets the
running `sso`/`postgres`; the SSO signing keypair is fixed for the stack's lifetime).

**Tier 2 — a standard PI user + a 1-hour JWT (API tests / load VUs):**

```bash
# 1. Fabricate user + role in the SSO database, capturing the role id.
ROLE_ID=$(compose exec -T postgres psql -qtAX -U "${PG_USER:-jimmy}" -d lucuma-sso -c "
  WITH u AS (
    INSERT INTO lucuma_user (user_type, orcid_id, orcid_given_name, orcid_family_name, orcid_email)
    VALUES ('standard','0000-0002-1825-0097','Test','Pi','test-pi@example.test')
    RETURNING user_id
  )
  INSERT INTO lucuma_role (user_id, role_type)
  SELECT user_id, 'pi' FROM u
  RETURNING role_id;")

# 2. Mint the JWT in the RUNNING sso container (same keypair the ODB trusts). Prints the JWT
#    on its own line; grab the eyJ… token exactly as bootstrap does for the service JWT.
PI_JWT=$(compose exec -T sso /opt/docker/bin/lucuma-sso-service create-jwt "$ROLE_ID" \
  | grep -oE 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+' | tail -1)

# 3. Use it: Authorization: Bearer $PI_JWT against the ODB GraphQL endpoint.
#    Re-mint when the hour is up (or use an API key, below, for a 3h credential).
```

For staff/admin, change `'pi'`; for ngo, `INSERT INTO lucuma_role (user_id, role_type, role_ngo)
… VALUES … 'ngo','us'`. Give each fabricated user a distinct, checksum-valid ORCID iD
(`orcid_id` is UNIQUE).

**Tier 3 — a session cookie for Explore (browser tests):** reuse the `user_id`/`role_id` from
step 1, then:

```bash
REFRESH_TOKEN=$(compose exec -T postgres psql -qtAX -U "${PG_USER:-jimmy}" -d lucuma-sso -c "
  INSERT INTO lucuma_session (user_id, user_type, role_id)
  SELECT user_id, user_type, role_id FROM lucuma_role WHERE role_id = '$ROLE_ID'
  RETURNING refresh_token;")
# Hand REFRESH_TOKEN + the stack cookie domain to the test; inject with context.addCookies
# (name 'lucuma-refresh-token', see §2) before first navigation. Explore then calls
# POST /api/v1/refresh-token and gets a JWT with no ORCID involvement.
```

**Longer-lived credential (optional):** `SELECT insert_api_key('<user_id>','<role_id>');`
returns `id.body`; send it as the bearer token — `sso-backend-client` exchanges it for a
3-hour JWT automatically (needs the service JWT, which the stack already has).

## Open questions

- ~~DB role/user name for the stack's `sso` database~~ — resolved: SSO's compose
  `DATABASE_URL` is `postgres://${PG_USER:-jimmy}:…@postgres:5432/lucuma-sso`
  (`stack/docker-compose.yml:121`); the recipe above uses it.
- **`uuid_generate_v1()` extension** (`uuid-ossp`) is created by `V002:3`; assumed present in
  the running DB (it is, since SSO migrated). No action, noted for completeness.
- **Explore's exact refresh trigger timing** (does it call `refresh-token` on load, or only
  when a JWT nears expiry?) was not read from Explore source — Explore is a separate repo.
  The SSO side is confirmed; if a browser test sees no JWT, force a `refresh-token` call or
  navigate to a page that requires auth.
- **`otherRoles` in a fabricated JWT:** `create-jwt <role-id>` sets the active role from the
  session's `role_id` and populates `otherRoles` from all the user's other `lucuma_role` rows
  (`Database.scala:355-371`). To give a user multiple roles, insert multiple `lucuma_role`
  rows before minting; the active one is whichever `role_id` you pass to `create-jwt` (or put
  in the session). Confirmed from source; flagged only because tests may care.

## Prior-assumption check

No prior assumption in `orcid-auth-testing-strategy.md` turned out wrong. Specifically:

- Tier 2 (fabricate user+role, mint via `create-jwt`) — **confirmed** exactly as described.
- Tier 3 (fabricate session row, inject cookie, Explore refreshes) — **confirmed, and the
  feared blocker does not exist**: the refresh token is stored *unhashed* (raw UUID, no
  server-held secret), so we can generate token rows ourselves and read the cookie value
  straight back. The note's hedged worry ("if sessions cannot be fabricated because of
  hashing…") does not apply.
- Tier 4 precondition — **resolved pessimistically**: `OrcidConfig` hardcodes the ORCID host
  per environment; it is not env-overridable, so a mock-ORCID tier needs DNS/truststore
  surgery. Matches the note's "probably not worth it" and keeps tier 4 on hold.
