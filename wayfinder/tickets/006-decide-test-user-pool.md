---
id: 006
title: "Decide test-user pool provisioning and token fetch"
labels: [wayfinder:grilling]
status: open
assignee:
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
