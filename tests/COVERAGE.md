# Explore coverage map

What the e2e suite covers per Explore functional area, and in what order the gaps get
closed. This file is the input to every "what test do we write next" decision — new specs
land as one file per area (`tests/e2e/<area>.spec.ts`), self-seeding through GraphQL and
using the UI only for the behavior under test.

**Status** — `covered`: the daily journey or an area spec exercises it; `partial`: touched
incidentally, no dedicated assertions; `none`: untested.
**Priority** — `P0`: belongs in the daily regression run; `P1`: full-suite (weekly / on
demand); `P2`: blocked or deferred (blocker noted). Priorities below are proposals —
reorder from real usage knowledge.

| Area | What it includes | Status | Where | Priority |
|---|---|---|---|---|
| Session & login | Guest login, injected standard sessions (pi/staff), logged-in shell renders | covered | `journey.spec.ts`, `journey-pi.spec.ts`, `journey-staff.spec.ts`, `standard-user.spec.ts` | P0 |
| Program management | Create, select, list in Proposals & Programs dialog | covered | `journey.spec.ts` scenario 2 | P0 |
| Program details | Name/subtitle edits, notes, program-level views | partial (subtitle edit only) | `journey.spec.ts` scenario 4 | P1 |
| Observations: lifecycle | Create, clone, delete, activate/deactivate | partial (create only) | `journey.spec.ts` scenario 3 | P0 |
| Targets: manual sidereal | Empty sidereal target, coordinate entry | partial (created via UI, coordinates set via API) | `journey.spec.ts` scenario 3 | P1 |
| Targets: catalog search | Simbad name search in the Add Target dialog | none | — | P1 (spec §12 item) |
| Targets: editing | Magnitudes, proper motion, radial velocity, SED | none | — | P1 |
| Instrument configuration | GMOS long-slit mode selection, wavelength, grating/filter | partial (set via API, not UI) | `journey.spec.ts` scenario 3 | P1 |
| Calculated results (ITC/obscalc) | Exposure time / S2N appears for a valid config | covered (appearance asserted) | `journey.spec.ts` scenario 3 | P0 |
| Constraint sets | IQ, cloud extinction, sky background, water vapor, elevation | none | — | P1 |
| Timing windows | Create/edit windows, repeat rules | none | — | P1 |
| Observation groups | Scheduling groups, AND/OR groups, drag into groups | none | — | P1 |
| Attachments | Finder charts, proposal attachments upload/list | none | — | P2 — needs an object store, not just fixtures: the ODB runs with dummy Cloudcube credentials (`stack/docker-compose.yml`), so there is nowhere to upload. This also gates proposal *submission through the UI* (see Proposals) |
| Program users & invitations | Invite, roles, revoke | partial (a PI's partner link is set and read back) | `proposals.spec.ts` scenario 2 | P1 — the unblocker landed (fabricated standard users + session injection); invite/revoke is now ordinary work |
| Proposals | Create, partners/time split, submit | covered (create, splits, submit + retract; UI editor and its validation. UI *submit* blocked — see note) | `proposals.spec.ts` | P1 |
| User preferences persistence | Grid layouts, tile states surviving reload (Hasura path) | partial (prefs socket proven alive by shell render) | `journey.spec.ts` scenario 1 | P1 |
| New-user signup | ORCID flow | none | — | P2 (mock-ORCID tier only; the real-ORCID leg stays a manual smoke test by decision — [decision note](../research/orcid-auth-testing-strategy.md)) |

## Proposals: what "covered" means here, and where it stops

`proposals.spec.ts` is the first spec to need two roles at once, and the first where the ODB's
rules and Explore's diverge — worth writing down, because the divergence is the finding:

- **Only staff may open a Call for Proposals**, and a proposal cannot be submitted without one.
  That is why the whole area waited on the fabricated standard users; the spec asserts the
  refusal for a PI as well as the success for staff.
- **The ODB requires** a matching call type, partner splits summing to 100, a Band 3 decision,
  a PI affiliated with a partner, and observations that are *defined* — an empty observation is
  refused with "contains undefined observations". All of it is in the fixture, and the
  observation's workflow state is polled rather than assumed.
- **Explore requires more**: title, abstract, category, every investigator's partner, the PI's
  email, splits, defined observations — **and an uploaded Science and Team attachment**
  (`explore/model/Proposal.scala`). The fixture satisfies everything except the attachments,
  so Explore correctly leaves "Submit Proposal" disabled and names the two missing files.
  Scenario 3 asserts exactly that, which is real behaviour rather than a stand-in.
- **So submission is asserted through the ODB** (scenario 4: submit, read back the status and
  the minted proposal reference, retract, read back). Driving the button in a browser needs an
  object store the ephemeral stack does not have — the Attachments row above.

## Ground rules for new specs

1. One file per area; every spec runs against a fresh guest and seeds its own state via
   `tests/support/odb.ts` — never depend on another spec's leftovers.
2. UI action → GraphQL read-back assertion, same as the journey (spec §5).
3. All selectors live in `tests/support/` — one module per area once an area has more
   than a handful.
4. P0 areas run daily; the full suite runs weekly and via `workflow_dispatch`.
5. An area is `covered` only when its row names the spec file and the spec asserts the
   area's core behavior, not merely renders it.
