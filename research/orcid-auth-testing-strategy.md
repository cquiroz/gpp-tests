# Testing beyond guests: how to handle ORCID authentication

**Written:** 2026-08-25. **Status:** decision note. Resolves the "needs standard users"
blocker on the P2 rows of [`tests/COVERAGE.md`](../tests/COVERAGE.md) (proposals, program
sharing) and records where the automation scope line sits. Grounding:
[`lucuma-deployment-shapes.md`](lucuma-deployment-shapes.md) §auth,
[`guest-visibility-refresh.md`](guest-visibility-refresh.md), ticket
[006](../wayfinder/tickets/006-decide-test-user-pool.md).

## What ORCID actually gates

Only the interactive browser flow. Explore's login dialog has two buttons; "Continue as
Guest" is `POST /api/v1/auth-as-guest` with no ORCID involvement, and the whole v1 suite
runs on it. "Login with ORCID" is the `stage1`/`stage2` OAuth redirect — the single path
that talks to ORCID's servers. SSO requires `LUCUMA_ORCID_CLIENT_ID`/`_SECRET` to *boot*
in every environment but never exercises them outside that flow; the ephemeral stack
boots with dummies (`stack/docker-compose.yml` sso environment).

Standard users do not inherently need ORCID either. SSO's own backdoors:

- `create-service-user <name>` — bootstrap already runs it for the service JWT.
- `create-jwt <role-id>` — mints a 1-hour JWT for any **existing** user role.
- API keys (`createApiKey` via SSO GraphQL; `exchange-api-key` given a service JWT) —
  long-lived credentials that attach to standard users.

Per the deployment-shapes research: standard users can be fabricated by inserting rows
into the SSO database we own. The exact SQL was not traced (open item, below).

## The decision: a four-tier ladder, dodging ORCID until the last tier

1. **Guests for everything they can do** — all current coverage and the entire load
   suite. The zero-credential principle (spec §4, §9) stays intact.
2. **API-level role coverage: fabricated standard users.** Bootstrap inserts user + role
   rows into SSO's Postgres, then mints JWTs with `create-jwt` (same pattern as the
   service JWT). Unlocks proposals/sharing scenarios at the GraphQL layer and
   role-diverse load VUs.
3. **Browser role coverage: session injection, not login.** A browser test as a
   standard/staff user needs SSO's refresh cookie, not the ORCID dance. Bootstrap
   fabricates the session row (we own SSO's database and keypair); the test sets the
   cookie with Playwright's `context.addCookies()` before first navigation, and Explore
   refreshes tokens normally from there. Same philosophy as journey scenario 3: seed
   through the backdoor, test the behavior that matters.
4. **Only if the real flow itself must be exercised: a mock ORCID container** in
   compose, faking the three OAuth endpoints, with SSO pointed at it. This is also the
   only way to test guest→standard *promotion* (it goes through stage2).
   **Precondition to check before promising it:** whether `OrcidConfig`
   (lucuma-odb `modules/sso-service`) lets the ORCID base URL be overridden or hardcodes
   orcid.org — if hardcoded, this tier needs compose network aliases plus JVM truststore
   surgery and is probably not worth it. Hold until tiers 2–3 prove insufficient.

**Never: real ORCID credentials in CI** — not even sandbox.orcid.org accounts. It would
break "no test-user credentials exist", add an external service to every run, and
automate a third party's login form (brittle, and against most providers' terms). The
real "Login with ORCID" button against real ORCID stays a manual smoke test. The scope
line: we test GPP, not ORCID — SSO's OAuth integration is tested where it lives.

## The open work item (gates tiers 2–3)

Trace in lucuma-odb `modules/sso-service`:

1. The user/role tables and the SQL to fabricate a standard user with a given role
   (research already flags this untraced: `lucuma-deployment-shapes.md` open question 3).
2. The session/refresh-token storage and cookie format, so bootstrap can fabricate a
   session and tests can inject the cookie.
3. Confirm `create-jwt <role-id>` output is accepted by the ODB for a fabricated user.

Estimated at about half a day of source reading plus a bootstrap extension
(`stack/scripts/`), all local to this repo — no cross-team ask, no new secrets.

## What this means per coverage-map row

| Row | Unblocked by |
|---|---|
| Program users & invitations | tier 2 (API assertions) + tier 3 (browser as inviter/invitee) |
| Proposals | tier 2 + tier 3, staff role for review-side views |
| New-user signup (ORCID flow) | tier 4 only, and only partially — the real-ORCID leg stays manual by decision |
