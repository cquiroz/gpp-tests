# ODB GraphQL + Explore UI map for v1 test scenarios

Research date: 2026-08-14. Sources: [gemini-hlsw/lucuma-odb](https://github.com/gemini-hlsw/lucuma-odb) (`main`) and [gemini-hlsw/lucuma-apps](https://github.com/gemini-hlsw/lucuma-apps) (`main`, contains `explore/`).

## Summary

- All four scenarios are fully expressible in the ODB GraphQL API with tiny payloads: `createProgram` needs **no required fields at all** (`SET` is optional); `createObservation` needs only `programId`; `createTarget` needs `programId` + `SET.name` + `SET.sidereal{ra,dec,epoch}` + `SET.sourceProfile`; `updateObservations` takes `SET` + `WHERE {id {EQ}}` and the result echoes the updated observations (built-in read-back).
- A **guest user can create programs, observations, and targets** — `createProgram` access control is literally "always ok, for now", and obs/target creation only requires write access to the program (guests own their own programs). Only `createProposal` is gated (`requirePiAccess`, guest < PI), so **a program can carry observations without any proposal** and a proposal is not part of the minimal flow.
- Login in Explore: the login dialog offers exactly two buttons — **"Login with ORCID"** and **"Continue as Guest"** (guest enabled: `allowGuest = true`). Guest login is a plain `POST {sso}/api/v1/auth-as-guest` returning a JWT — trivially scriptable for load tests without ORCID.
- On first login with no programs, **Explore auto-creates a program** and routes to the Observations tab; manual creation is via side-menu "Manage Programs" → "Proposals & Programs" dialog → green **"Proposal"** button (it calls `createProgram` with `SET = null`).
- Read-heavy load candidates: Explore bulk-loads a program with paginated `observations(WHERE:…, OFFSET:…)`, `targets(WHERE:…, OFFSET:…)`, `programs(OFFSET:…)`, plus `program(programId:…)` detail/times/groups queries — all `{ matches […] hasMore }` shaped.
- **No Playwright/Cypress/e2e tests exist in either repo.** lucuma-odb has an extensive JVM integration-test suite (munit `OdbSuite` GraphQL-over-HTTP tests against a Postgres container) that is the best source of canonical mutation payloads; lucuma-apps has only Scala unit tests. Selectors/flows must be built from scratch (component source gives labels).
- Endpoints (from Explore's config): GraphQL HTTP `POST {odbRestURI}/odb`, WebSocket (subscriptions, graphql-ws) at `/ws`. Dev: `https://odb-dev.lucuma.xyz`, SSO `https://sso-dev.gpp.lucuma.xyz`; staging: `lucuma-postgres-odb-staging.herokuapp.com` / `sso-test.gpp.gemini.edu`; production: `lucuma-postgres-odb-production.herokuapp.com` / `sso.gpp.gemini.edu`. ([environments.conf.json](https://github.com/gemini-hlsw/lucuma-apps/blob/main/explore/common/src/main/public/environments.conf.json), [GraphQLRoutes.scala](https://github.com/gemini-hlsw/lucuma-odb/blob/main/modules/service/src/main/scala/lucuma/odb/graphql/GraphQLRoutes.scala) mounts at path `"odb"`)

Schema file: [modules/schema/src/main/resources/lucuma/odb/graphql/OdbSchema.graphql](https://github.com/gemini-hlsw/lucuma-odb/blob/main/modules/schema/src/main/resources/lucuma/odb/graphql/OdbSchema.graphql) (~23,400 lines; `type Mutation` at ~L3565, `type Query` at ~L16400).

## 1. Mutations and minimal required inputs

### createProgram

```graphql
mutation { createProgram(input: { SET: { name: "load-test-p1" } }) { program { id name } } }
```

- `CreateProgramInput { SET: ProgramPropertiesInput }` — `SET` itself is **optional**; Explore passes `null`.
- `ProgramPropertiesInput`: all fields optional — `name`, `description`, `goa`, `existence`, `activeStart`, `activeEnd` ([ProgramPropertiesInput.scala](https://github.com/gemini-hlsw/lucuma-odb/blob/main/modules/service/src/main/scala/lucuma/odb/graphql/input/ProgramPropertiesInput.scala)). Note: `name: ""` is rejected (NonEmptyString); `name: null` is fine.
- **Program types**: `enum ProgramType { CALIBRATION COMMISSIONING ENGINEERING EXAMPLE KECK LIBRARY MONITORING SCIENCE SUBARU SYSTEM }`. You cannot pick a type at creation — `createProgram` always makes a science-flavored program; type/semester/reference are changed later via `setProgramReference` which is **staff-only** ([AccessControl.scala L580–591](https://github.com/gemini-hlsw/lucuma-odb/blob/main/modules/service/src/main/scala/lucuma/odb/graphql/mapping/AccessControl.scala)).
- Result: `CreateProgramResult { program: Program! }`.

### createObservation

```graphql
mutation {
  createObservation(input: {
    programId: "p-123"
    SET: { subtitle: "scenario-3", targetEnvironment: { asterism: ["t-456"] } }
  }) { observation { id title subtitle } }
}
```

- `CreateObservationInput { programId | proposalReference | programReference, SET: ObservationPropertiesInput }` — one program identifier; `SET` optional (defaults applied: default constraint set, existence PRESENT — [ObservationPropertiesInput.scala `Create.Default`](https://github.com/gemini-hlsw/lucuma-odb/blob/main/modules/service/src/main/scala/lucuma/odb/graphql/input/ObservationPropertiesInput.scala)).
- Every `ObservationPropertiesInput` field is optional: `subtitle`, `scienceBand`, `posAngleConstraint`, `targetEnvironment` (with `asterism: [TargetId!]`), `constraintSet`, `schedulingConstraints`, `attachments`, `scienceRequirements`, `observingMode`, `existence`, `groupId`, `groupIndex`, `observerNotes`.
- Attach the target at creation via `SET.targetEnvironment.asterism` (or later via `updateObservations` / `updateAsterisms`).
- Note: `Observation.title` is **generated from the targets** ("Observation title generated from id and targets"); the user-editable free-text field is `subtitle`.
- Result: `CreateObservationResult { observation: Observation! }`.

### createTarget (sidereal)

Minimal required set (enforced in [SiderealInput.scala](https://github.com/gemini-hlsw/lucuma-odb/blob/main/modules/service/src/main/scala/lucuma/odb/graphql/input/SiderealInput.scala) and [TargetPropertiesInput.scala](https://github.com/gemini-hlsw/lucuma-odb/blob/main/modules/service/src/main/scala/lucuma/odb/graphql/input/TargetPropertiesInput.scala)):
- `SET.name` — "Target name is required on creation."
- exactly one of `sidereal` / `nonsidereal` / `opportunity`
- for sidereal: **`ra`, `dec`, and `epoch` are all required** — "RA, Dec, and Epoch must all be specified on target creation." (`ra`/`dec` are `@oneOf`: `degrees`/`hms|dms`/`microseconds|microarcseconds`/`hours`; `epoch` e.g. `"J2000.000"`)
- `SET.sourceProfile` — "Source Profile is required on creation."

Canonical minimal payload (adapted from the ODB's own test [mutation/createTarget.scala](https://github.com/gemini-hlsw/lucuma-odb/blob/main/modules/service/src/test/scala/lucuma/odb/graphql/mutation/createTarget.scala)):

```graphql
mutation {
  createTarget(input: {
    programId: "p-123"
    SET: {
      name: "LoadTest Star"
      sidereal: { ra: { degrees: "12.345" }, dec: { degrees: "45.678" }, epoch: "J2000.000" }
      sourceProfile: { point: { bandNormalized: { sed: { stellarLibrary: B5_III }, brightnesses: [] } } }
    }
  }) { target { id name } }
}
```

### updateObservations (edit + read-back in one call)

```graphql
mutation {
  updateObservations(input: {
    SET: { subtitle: "edited", constraintSet: { imageQuality: POINT_EIGHT, cloudExtinction: POINT_FIVE } }
    WHERE: { id: { EQ: "o-789" } }
  }) { observations { id subtitle constraintSet { imageQuality cloudExtinction skyBackground waterVapor } } }
}
```

- `UpdateObservationsInput { SET: ObservationPropertiesInput!, WHERE: WhereObservation, LIMIT, includeDeleted }`. The result selection **returns the updated observations**, so read-back can be in the same response; an independent read-back is `observation(observationId: "o-789") { … }`.
- `WhereObservation` supports `id`, `reference`, `program`, `subtitle`, `scienceBand`, `instrument`, `site`, `workflow`, plus `AND/OR/NOT`.
- Explore itself uses exactly this mutation shape ([ObsQueriesGQL.scala `UpdateObservationMutation`](https://github.com/gemini-hlsw/lucuma-apps/blob/main/explore/app/src/clue/scala/queries/common/ObsQueriesGQL.scala)) returning only `observations { id }`, and relies on its `observationEdit` subscription for the refresh.
- `ConstraintSetInput` fields (all optional on edit): `imageQuality` (`ImageQualityPreset`), `cloudExtinction` (`CloudExtinctionPreset`), `skyBackground`, `waterVapor`, `elevationRange { airMass { min max } | hourAngle { minHours maxHours } }`.

### createProposal — and whether it's needed

- `CreateProposalInput { programId: ProgramId!, SET: ProposalPropertiesInput! }`; `ProposalPropertiesInput` fields all optional (`category`, `callId`, `gemini`/`keck`/`subaru` proposal-type blocks).
- Gated by `requirePiAccess` in [MutationMapping.scala](https://github.com/gemini-hlsw/lucuma-odb/blob/main/modules/service/src/main/scala/lucuma/odb/graphql/mapping/MutationMapping.scala) (`user.role.access >= Access.Pi`) → **guests cannot create proposals**.
- **A program does NOT need a proposal to hold observations/targets** — nothing in `createObservation`/`createTarget` references a proposal; Explore's guest flow creates observation-bearing programs with no proposal. Proposals only matter for submission/TAC workflows.

## 2. Read queries Explore uses (load-test candidates)

Defined in [explore/app/src/clue/scala/queries/common/](https://github.com/gemini-hlsw/lucuma-apps/tree/main/explore/app/src/clue/scala/queries/common) (notably `ProgramSummaryQueriesGQL.scala`, `ProgramQueriesGQL.scala`). All list queries page on `OFFSET` (an id cursor) and loop while `hasMore` ([OdbObservationApiImpl.scala `drain`](https://github.com/gemini-hlsw/lucuma-apps/blob/main/explore/app/src/main/scala/explore/services/OdbObservationApiImpl.scala)):

| Explore operation | Query | Notes |
|---|---|---|
| `AllPrograms` | `programs(OFFSET: $OFFSET, includeDeleted: true) { matches {id name pi{…} type reference{label} proposal{reference{label}} proposalStatus existence} hasMore }` | Fills the "Proposals & Programs" dialog |
| `AllProgramObservations` | `observations(WHERE: $where, OFFSET: $OFFSET) { matches <ObservationSubquery> hasMore }` with `WHERE = {program:{id:{EQ: pid}}}` | The big one: ObservationSubquery pulls id, title, subtitle, observationTime/duration, posAngleConstraint, full targetEnvironment, constraintSet, schedulingConstraints, scienceRequirements, workflow, etc. |
| `AllProgramTargets` | `targets(WHERE: $where, OFFSET: $OFFSET) { matches {id target{…sidereal…sourceProfile…}} hasMore }` | |
| `ProgramDetailsQuery` | `program(programId: $pid) <ProgramDetailsSubquery>` | Program details incl. users, proposal |
| `ProgramTimesQuery` | `program(programId: $pid) <ProgramTimesSubquery>` | Time accounting (server-computed → heavier) |
| `ProgramGroupsQuery` | `program(programId: $pid) { allGroupElements { group … } }` | |
| `AllProgramAttachments` / `AllProgramConfigurationRequests` | `program(programId:…){ attachments … / configurationRequests(OFFSET:…){…} }` | |

All select-alls share the `SelectResult` shape: `{ matches: [X!]!, hasMore: Boolean! }`. Explore also opens **subscriptions** on load (`programEdit`, `observationEdit`, `groupEdit`, `targetEdit`, obscalc) over `/ws` — a realistic session is 1 HTTP burst + several long-lived WS subscriptions.

## 3. Explore UI flow

- **Login screen** ([UserSelectionForm.scala](https://github.com/gemini-hlsw/lucuma-apps/blob/main/ui/lib/src/main/scala/lucuma/ui/components/UserSelectionForm.scala)): dialog with buttons labeled `"Login with ORCID"` and `"Continue as Guest"`. Explore passes `allowGuest = true` ([ExploreLayout.scala ~L296](https://github.com/gemini-hlsw/lucuma-apps/blob/main/explore/app/src/main/scala/explore/ExploreLayout.scala)). Under the hood ([SSOClient.scala](https://github.com/gemini-hlsw/lucuma-apps/blob/main/ui/lib/src/main/scala/lucuma/ui/sso/SSOClient.scala)): guest = `POST {sso}/api/v1/auth-as-guest` (returns JWT body); ORCID = redirect to `{sso}/auth/v1/stage1?state={returnUrl}`; refresh = `POST {sso}/api/v1/refresh-token`.
- **Program creation**: after login with zero programs, Explore **auto-creates a program** (`createProgram(none)`) and navigates to the Observations tab ([ExploreLayout.scala, "automatically create a new program" effect](https://github.com/gemini-hlsw/lucuma-apps/blob/main/explore/app/src/main/scala/explore/ExploreLayout.scala)). Manual path: side-bar menu → item **"Manage Programs"** ([TopBar.scala](https://github.com/gemini-hlsw/lucuma-apps/blob/main/explore/app/src/main/scala/explore/TopBar.scala)) → dialog headed **"Proposals & Programs"** ([ProgramsPopup.scala](https://github.com/gemini-hlsw/lucuma-apps/blob/main/explore/app/src/main/scala/explore/programs/ProgramsPopup.scala)) → footer button labeled **"Proposal"** (success/green, `Icons.New`) creates a new program; other footer controls: "Show deleted" checkbox, "Cancel".
- **Observation creation**: Observations tab, observation tree panel — green button labeled **"Obs"**, tooltip "Add a new Observation" ([ObsTree.scala ~L562](https://github.com/gemini-hlsw/lucuma-apps/blob/main/explore/app/src/main/scala/explore/observationtree/ObsTree.scala)); sibling button "Group" adds a group.
- **Adding a target** ([AddTargetButton.scala](https://github.com/gemini-hlsw/lucuma-apps/blob/main/explore/app/src/main/scala/explore/targeteditor/AddTargetButton.scala)): an **"Add Target"** split-button whose menu actions include **"Target Search"**, **"Empty Sidereal Target"**, and **"Target of Opportunity"** (plus blind-offset actions).
  - *Name search*: the search form's input is labeled/placeholder **"Name"** ([SearchForm.scala](https://github.com/gemini-hlsw/lucuma-apps/blob/main/explore/app/src/main/scala/explore/targeteditor/SearchForm.scala)); sources are the program's own targets plus **Simbad** (`TargetSource.FromSimbad(ctx.simbadClient)`, `SimbadClient` from lucuma-catalog → **external CDS Simbad call from the browser**) and JPL **Horizons** for nonsidereal. Load/e2e tests that use name search therefore depend on an external service.
  - *Manual coordinates*: yes — "Empty Sidereal Target" creates a target immediately (default name/coords) and the sidereal target editor exposes editable RA/Dec/epoch/PM/RV/parallax fields (e.g. `PositionCoordinatesEditor.scala`, `RVInput.scala`), so coordinates can be typed without any catalog call.
- **Editing observation title/constraints**:
  - The user-editable text is the **subtitle**, edited inline on the observation card in the obs tree via an `EditableLabel` ([ObsBadge.scala ~L204](https://github.com/gemini-hlsw/lucuma-apps/blob/main/explore/app/src/main/scala/explore/observationtree/ObsBadge.scala)); the displayed title is derived from targets.
  - **Constraints** are edited in the Constraints tile of the selected observation ([ConstraintsPanel.scala](https://github.com/gemini-hlsw/lucuma-apps/blob/main/explore/app/src/main/scala/explore/constraints/ConstraintsPanel.scala)): dropdowns for Image Quality / Cloud Extinction / Sky Background / Water Vapor and an elevation-range selector with options labeled "Air Mass" / "Hour Angle". There is also a Constraints tab grouping observations by constraint set ([ConstraintGroupObsList.scala](https://github.com/gemini-hlsw/lucuma-apps/blob/main/explore/app/src/main/scala/explore/observationtree/ConstraintGroupObsList.scala)). Edits fire `UpdateObservationMutation` (updateObservations).

## 4. Existing e2e tests

- **None.** A recursive tree scan of both repos finds no Playwright, Cypress, Selenium, Puppeteer, or `*e2e*` files. lucuma-apps `explore` tests are pure Scala unit/model tests (`explore/model-tests`, `explore/common/src/test`). Explore is Scala.js + PrimeReact, and components rarely set stable `id`/`data-testid` attributes (a few form ids exist, e.g. the target search input `id = "search"`, checkbox `id = "show-deleted"`), so e2e selectors will mostly be label/role-based.
- The closest existing assets are lucuma-odb's **GraphQL integration tests** ([modules/service/src/test/scala/lucuma/odb/graphql/mutation/](https://github.com/gemini-hlsw/lucuma-odb/tree/main/modules/service/src/test/scala/lucuma/odb/graphql/mutation) — `createProgram.scala`, `createObservation.scala`, `createTarget.scala`, `updateObservations.scala`, `createProposal.scala`), which are the authoritative source of working payloads and expected errors, and Explore's clue query documents (section 2) which are the authoritative "what the UI actually sends".

## 5. Guest capability (from ODB source)

- Roles: `Access` ordering is `Guest < Pi < Ngo < Staff < Admin < Service` (checks are `user.role.access >= X`, [Services.scala L494-508](https://github.com/gemini-hlsw/lucuma-odb/blob/main/modules/service/src/main/scala/lucuma/odb/service/Services.scala)).
- **createProgram: guests allowed.** `selectForUpdate(CreateProgramInput)` is `Result(AccessControl.unchecked(...)) // always ok, for now` — no role check at all ([AccessControl.scala ~L608-612](https://github.com/gemini-hlsw/lucuma-odb/blob/main/modules/service/src/main/scala/lucuma/odb/graphql/mapping/AccessControl.scala)). The test suite runs `createProgram` with a guest in `validUsers` ([mutation/createProgram.scala](https://github.com/gemini-hlsw/lucuma-odb/blob/main/modules/service/src/test/scala/lucuma/odb/graphql/mutation/createProgram.scala)).
- **createObservation / createTarget / updateObservations: guests allowed on their own programs.** Access is "program is writable by user"; for Guest and Pi that means the user is linked to the program ([ProgramPredicates.scala `isVisibleTo`/`isWritableBy`](https://github.com/gemini-hlsw/lucuma-odb/blob/main/modules/service/src/main/scala/lucuma/odb/graphql/predicate/ProgramPredicates.scala)), and the creator of a program is linked as its PI. One exception: `createObservation` with an observing mode where `needsStaffAccess` (certain engineering/instrument configs) requires Staff ([AccessControl.scala ~L465-469](https://github.com/gemini-hlsw/lucuma-odb/blob/main/modules/service/src/main/scala/lucuma/odb/graphql/mapping/AccessControl.scala)); plain observations are fine. `guest` appears in `validUsers` of `createObservation.scala` tests too.
- **createProposal: guests denied** (`requirePiAccess`). Also staff-only: `setProgramReference`, `createCallForProposals`, `setAllocations`, `declineTooTrigger`, attachment `checked` flag.
- Practical upshot for load tests: guest JWTs from `POST {sso}/api/v1/auth-as-guest` are sufficient for all four scenarios (login, create program, create obs+target, edit+read-back). SSO also supports long-lived API keys (format `hexid.96-hex-chars`, [ApiKey.scala](https://github.com/gemini-hlsw/lucuma-odb/blob/main/modules/sso-backend-client/src/main/scala/ApiKey.scala), created via the SSO GraphQL `createApiKey` mutation) usable as `Authorization: Bearer <key>` against the ODB — but those attach to standard (ORCID) users, not guests.

## Open questions / caveats

- **Guest-allowed createProgram is flagged "for now"** in the source; the policy could tighten. Verify against the deployed env before building the whole suite on guest users.
- **Line numbers / labels drift**: both repos are active (`main` moves fast); UI labels were read from `main` on 2026-08-14. Explore also lives partly in `ui/` shared components in lucuma-apps and in the separate `lucuma-ui`/`lucuma-schemas` libraries — some subqueries (`ConstraintSetSubquery`, `TargetSubquery`) are defined in [gemini-hlsw/lucuma-schemas](https://github.com/gemini-hlsw/lucuma-schemas) and were not expanded here.
- **Simbad/Horizons are external dependencies** of the "Target Search" UI path (browser → CDS Simbad / JPL Horizons). For deterministic e2e/load tests prefer "Empty Sidereal Target" + manual coordinates, or seed targets via the API.
- **Dev/staging vs production**: environment endpoints were read from Explore's `environments.conf.json`; Heroku URLs for staging/production may be behind DNS aliases; confirm which environment the load test may legally hit and whether guest creation is rate-limited at SSO.
- **Explore uses WebSockets for all GraphQL**, not just subscriptions? Not verified — `odbURI` is `wss://…/ws` and `odbRestURI` is separate; clue's `StreamingClient` suggests queries/mutations may also go over the WS transport in Explore. A pure-HTTP load test (`POST /odb`) is still valid API-wise but won't exercise the WS path the UI uses; check traffic in the browser before finalizing the load model.
- **Auto-created program on guest login**: a UI e2e "create program" scenario must account for Explore auto-creating program #1; the "Proposal" button in "Proposals & Programs" is the explicit creation path (and despite the label it creates a program, with no proposal attached).
- `updateObservations` responses already include any requested fields of the updated observations, but Explore requests only `{ id }` and relies on subscriptions — an API-level "edit + read-back" scenario can either select fields in the mutation result or follow with `observation(observationId:)`; both are supported.
- NGO-role visibility is literally unimplemented (`case Ngo => ???` in ProgramPredicates) — irrelevant for these scenarios but a sign that role edge cases vary.
