---
id: 017
title: "Standard-user pool and the proposal loop in k6"
labels: [wayfinder:task]
status: closed
assignee: claude
blocked-by: [028]
---

## Question

*Reshaped by ticket 020; no longer blocked on the migration — it lands on the `surge`
branch here.* Surge traffic is proposal traffic, and guests can't touch proposals. Build
the **standard-user pool**: per-run fabricated PIs (about 250, one per VU) and a handful
of staff users via the existing SSO insert script, tokens through the SSO API, a k6 auth
helper alongside the guest one. Then the **proposal loop**: one CfP seeded with a
far-future deadline; each PI creates a program and proposal, edits, **uploads a Science and
a Team attachment** (the odb refuses to submit without them since 2026-09-07 — two REST
uploads per proposal, through the odb's attachment endpoint into the stack's object store,
ticket 028), submits, and churns through retract/resubmit — driven by an **arrival-rate
executor** so the tier's submissions-per-hour figure (realistic 100–250, ceiling 500) is
literal. Upload size and count per submission become part of the workload model. Each PI also needs
a partner, an educational status and an affiliation set on the program user before the odb
will submit (rules of 2026-09-07/10 — `setProgramUserDetails` in the operations library). Proposal
scenarios enter the scenario-parity catalog alongside the existing e2e proposal specs.
Developable against the local compose stack.

## Resolution (2026-10-06)

**The pool.** `stack/scripts/create-standard-users.sh` now fabricates, after the two browser
personas, `POOL_PI_COUNT` PIs (250) and `POOL_STAFF_COUNT` staff (4) in one psql round trip:
a temp table of fabricated ORCID iDs (`0009-01xx-xxxx-xxxC`, ISO-7064 check digit computed in
bash — a bad digit does not fail the INSERT, it crashes refresh-token later), set-based
inserts into `lucuma_user`, `lucuma_role` and `lucuma_session` where missing, and one JSON
read-back written to `stack/.env.standard-users.json` (`{cookieDomain, pi: [{userId, roleId,
refreshToken}], staff: [...]}`, mode 600, under the gitignored `stack/.env*` glob). Idempotent:
a rerun yields a byte-identical file; the whole script takes ~15 s, of which the pool is ~2 s
and the rest the two JWT mints that were already there. Bootstrap runs it as before, so every
stack — local, CI, the AWS target — has the pool, and the wizard copies the file to the
generator beside `.env.standard-users`.

k6 side: `k6/lib/standard-users.js` opens the file once (SharedArray) and gives
`poolUser(kind, index)` / `loginAsPoolUser(kind, index)`; `k6/lib/auth.js` gained
`loginWithRefreshToken` (each standard session carries its own cookie jar, so a VU can hold a
guest and a standard identity at once, as the regression does) and `refreshed()` now fails a
standard session whose refresh is refused instead of silently becoming a guest. **A VU's
identity is `exec.vu.idInTest - 1` plus a per-script offset** — unique across a whole run,
including a composed one (018), so no two VUs ever share a user; the pool just has to be at
least as large as the run's VU count. Lesson, learned the hard way: k6 has no
`exec.vu.idInScenario`; the first subscriber run indexed the pool with NaN and every tab was
the browser persona. `poolUser` now fails on a non-integer index, and the subscriber fixtures
draw from the pool (`SUBSCRIBER_PI_OFFSET`, `SUBSCRIBER_STAFF_OFFSET`), falling back to the
personas only when there is no pool.

**The loop** (`k6/lib/proposals.js`, `k6/proposals.js`). One iteration is one submission.
What the ODB requires before it accepts one, each verified against the stack: PI partner,
educational status and affiliation (`setProgramUserDetails`), an abstract, **at least one
defined observation** — probed 2026-10-06: a program with none is refused with "At least one
observation must be defined", so an empty program cannot submit and every new proposal
creates a GMOS-N long-slit observation and polls `observationWorkflow` until it leaves
UNDEFINED (`gpp_proposal_definition_wait`, 3 s locally; `PROPOSAL_DEFINITION_TIMEOUT_SECONDS`
180) — the proposal against the call, and the Science and Team attachments. Staff open the
call in `setup()`; `createCallForProposals` is staff-only, so the pool's first staff member
does it. Later submissions on a PI are, with `RESUBMIT_SHARE` (0.3), a retract, an abstract
edit, a 5–15 s pause and a resubmission of one of theirs. Scenario names: `proposal-call`,
`proposal-create`, `proposal-attachments`, `proposal-submit` (submit + read-back of the minted
reference; `odb_write_duration{operation:SetProposalStatus}` is the SLO's subject),
`proposal-retract`; `gpp_proposal_submissions` counts what took, tagged FirstSubmission /
Resubmission.

**Arrival rate.** `ramping-arrival-rate`, `timeUnit: 1h`, ramp (`RAMP`, 1 m) to
`SUBMISSIONS_PER_HOUR` (250; the ceiling is 500) and hold for `DURATION`; `PREALLOCATED_PIS`
defaults to the rate times two minutes, `MAX_PIS` 50, `gracefulStop` 4 m so a proposal built
near the end still submits. `dropped_iterations: count==0` is a threshold: an iteration k6
had no free PI for is a submission the ODB never saw, so the literal rate did not happen.

**Attachment sizes — decided: pad.** `padPdf` in `lib/attachments.js` grows the 631-byte
fixture to `PROPOSAL_ATTACHMENT_SIZES` (science 2 MiB, team 512 KiB — an assumption; see the
map) by appending one PDF comment line and a fresh `%%EOF`; the odb and versitygw store and
list the padded size. k6 builds the padded bodies lazily per VU (`SCIENCE_ATTACHMENT_BYTES`,
`TEAM_ATTACHMENT_BYTES` override), so idle pre-allocated VUs cost nothing. The k6
regression's one submission uploads the padded sizes too (2.5 MiB per nightly run, through
versitygw in CI and the real bucket on AWS), so the realistic REST leg is exercised every
night; only the browser suite sends the bare fixture.

**Parity.** `proposal-call`, `proposal-create` and `proposal-submit` now run on both sides;
`proposal-retract` is k6-only with its reason (the e2e retracts inside scenario 4 and through
Explore's button in scenario 5). The k6 regression runs the lifecycle once: staff call, PI
proposal, uploads, defined, submit, retract/edit — 14/14 scenarios, 117 checks, 0 GraphQL
errors locally.

**First runs, local stack (Docker VM, obscalc at its 1 GiB limit):**

| Run | Submissions | Dropped | Submit p95 | Upload p95 | Definition wait |
|---|---|---|---|---|---|
| 250/h for 4 m (ramp 30 s), 11 PIs | 17 (15 first, 2 resubmits) | 0 | 955 ms | 104 ms | 3.05 s |
| 500/h for 1 m (ramp 15 s), 19 PIs | 9 | 0 | 142 ms | — | ~3 s |

All checks green (251 and 145), 50/50 scenarios, 0 GraphQL errors; 30 attachments, 39.3 MB
in the object store for the first run; each program owned by a distinct pool PI (verified in
`t_program_user`). Iterations take ~3.7 s median, so a dozen PIs cover the ceiling rate with
room; a slower obscalc would show up in `gpp_proposal_definition_wait` first and
`dropped_iterations` second.

**On AWS (2026-10-07, after the truststore fix in ticket 028's update):** the regression's
lifecycle passed on the target in bucket mode — 114 checks, the observation defined on the
first poll (24 ms), 2.5 MiB through the proxy and the instance role. The proposal *profile*
has not run on AWS yet.

**Not done here.** An AWS stage for the proposal profile (018 composes it; the wizard already
ships the pool to the generator). Pre-seeding proposals during the ramp so the steady state is
mostly churn (map, "Deadline mix"). Finder-chart and MOS-mask uploads. The `email_send_error`
path is exercised on every submission (the stand-in answers), but k6 does not read the mail
record — the e2e does.
