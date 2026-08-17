---
id: 006
title: "Decide test-user pool provisioning and token fetch"
labels: [wayfinder:grilling]
status: closed
assignee: carlos.quiroz
blocked-by: [002]
---

## Question

Decide how the test-user pool is provisioned and managed: how many users, naming
convention, where their credentials live (CI secrets, sealed file?), how tokens are
fetched via the SSO API at run start, token lifetime versus run duration (mid-run
refresh needed?), and how data created by test users is distinguishable and cleanable.

Sharpened by the [deployment-shapes research](002-research-lucuma-deployment-shapes.md):
SSO offers two browserless paths — `auth-as-guest` (no credentials, 10-minute JWTs) and
`exchange-api-key` via a service user (3-hour user JWTs; service JWT minted with SSO's
`create-service-user` CLI). Decide which the pool uses: are guest users privileged
enough in ODB to create programs/observations, or does the pool need standard users
with API keys — and if standard, how are they created without ORCID accounts?

## Resolution

Grounding facts: [research/guest-visibility-refresh.md](../../research/guest-visibility-refresh.md)
(guests see only their own programs; `auth-as-guest` sets a long-lived
`lucuma-refresh-token` cookie usable headlessly with no CSRF/Origin checks; guests
cannot create API keys).

- **No pre-created pool. Each load VU is a guest** — `POST /api/v1/auth-as-guest` at
  ramp start *is* the provisioning. It survives the per-run DB reset by construction
  and needs **zero test credentials** (the only secrets anywhere are infrastructure
  ones: `HEROKU_API_KEY`, Grafana write tokens).
- **Token lifetime, twofold**: baseline mechanism is a **per-VU refresh loop** — each
  VU holds its refresh cookie in its k6 cookie jar and refreshes its 10-minute JWT
  every ~8 minutes (verified headless; mildly realistic, Explore does the same). And a
  **spec ask to lucuma-odb**: parameterize `Config.JwtLifetime` (already `TODO`-marked)
  as an env var, default 10 min; once merged, test environments set it long and load
  scripts drop the refresh loop.
- **Seed corpus amendment to the load-model ticket**: a central corpus would be
  invisible to guest VUs, so **each guest VU self-seeds its own working set (~3–5
  programs with observations) during ramp**, then runs its measured 60/40 loop over
  its own data. Aggregate corpus lands in the same ballpark (200 VUs × 3–5).
- **Regression runs**: the browser journey already logs in as guest (v1-scenarios
  ticket); the k6 regression variants use guest tokens the same way.
- **Standard-user pool = phase 2**, wired to the "role-diverse scenarios" fog item:
  bootstrapped per run (SSO DB inserts + API keys + 3-hour exchange JWTs), forced by
  the first scenario guests can't do (proposals; API keys are standard-user-only).
