# lucuma-odb: guest program visibility, refresh flow, API keys

Verified against `gemini-hlsw/lucuma-odb` @ `main` (commit `67fba49`, shallow clone, 2026-08).

## FACT 1 — Guest program visibility

The `programs` query filters every result through `Predicates.program.isVisibleTo(user)`
([QueryMapping.scala L668–L695](https://github.com/gemini-hlsw/lucuma-odb/blob/main/modules/service/src/main/scala/lucuma/odb/graphql/mapping/QueryMapping.scala#L668),
[ProgramPredicates.scala L22–L29](https://github.com/gemini-hlsw/lucuma-odb/blob/main/modules/service/src/main/scala/lucuma/odb/graphql/predicate/ProgramPredicates.scala#L22)):

```scala
def isVisibleTo(user: User): Predicate =
  user.role.access match {
    case Guest | Pi => Contains(path / "users" / "userId", Const(user.id.some)) // user is linked
    case Ngo => ???
    case Staff | Admin | Service => True
  }
```

- **Guest (and Pi)**: only programs where the user appears in the program's `users`
  list (linked, e.g. as PI of a program they created). A fresh guest sees an **empty list**.
- **Staff / Admin / Service**: predicate is `True` — they see **all programs**.
- Ngo is unimplemented (`???` — would throw).

## FACT 2 — Headless guest session refresh (sso-service)

[Routes.scala L68–L94](https://github.com/gemini-hlsw/lucuma-odb/blob/main/modules/sso-service/src/main/scala/Routes.scala#L68),
[CookieService.scala L47, L96–L113](https://github.com/gemini-hlsw/lucuma-odb/blob/main/modules/sso-service/src/main/scala/CookieService.scala#L47),
[config/Config.scala L50](https://github.com/gemini-hlsw/lucuma-odb/blob/main/modules/sso-service/src/main/scala/config/Config.scala#L50).

- `POST /api/v1/auth-as-guest` → `201 Created`, body = JWT (`JwtLifetime = 10.minutes`),
  plus `Set-Cookie`:
  - name **`lucuma-refresh-token`**, content = session-token UUID
  - `Domain=<cookieDomain>`, `Path=/`, `SameSite=Strict`,
    `Secure` + `HttpOnly` when the deployment's `secure` flag is on
  - **`Expires=HttpDate.MaxValue`** — effectively permanent, not a session cookie;
    server-side validity is the DB session-token row.
- `POST /api/v1/refresh-token` reads only that cookie, looks the token up in the DB,
  and returns `200` with a fresh 10-minute JWT. `403 Forbidden` if the cookie is
  missing/invalid.
- **No CSRF token and no Origin requirement**: the http4s `CORS` middleware
  ([CorsMiddleware.scala](https://github.com/gemini-hlsw/lucuma-odb/blob/main/modules/common-middleware/src/main/scala/lucuma/common/middleware/CorsMiddleware.scala))
  only acts when an `Origin` header is present; requests without one pass through.
  `SameSite=Strict` is browser-only and ignored by k6's cookie jar. So a k6 client
  that captures the cookie from `auth-as-guest` and replays it works fine — just use
  HTTPS if the cookie is marked `Secure`, and hit the same host so `Domain` matches.

## FACT 3 — `POST /api/v1/create-api-key?role=`

[Routes.scala L127–L138](https://github.com/gemini-hlsw/lucuma-odb/blob/main/modules/sso-service/src/main/scala/Routes.scala#L127):
`jwtReader.findStandardUser(r)` — a **GUEST JWT cannot create an API key**
(`403 "Standard user required."`). The standard user must also own the requested
role id (`403 "Role is not owned by user."` otherwise).

## Caveats

- Verified on a local shallow clone of `main` (`67fba49`); links point at `main` and
  line numbers may drift with future commits.
- `isWritableBy = isVisibleTo` with a TODO ("not true for COI_RO"), so guest
  visibility currently implies writability on linked programs.
- `logout` for guests has a TODO to delete the guest user — guest users/sessions
  currently persist in the DB; load tests will accumulate guest rows.
- Guest→standard upgrade: the ORCID stage2 flow promotes an existing guest session
  if the cookie is present; irrelevant to headless k6 use but explains the cookie reuse.
