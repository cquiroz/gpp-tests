# Explore feature inventory for automated testing

An inventory of what Explore does, read from the lucuma-apps source at `8f68fdca54`
(2026-10-25), with a note per feature on whether this suite could test it automatically,
what it would take, and what already exists. [`tests/COVERAGE.md`](../tests/COVERAGE.md)
is the coverage ledger by area and stays the input to "what spec next"; this file is the
wider list it picks from, so the two should be read together and this one should be the
one that grows.

How to read the columns:

- **Layer** — where a test of this feature belongs. `e2e` is Playwright against the
  ephemeral stack through Explore's UI; `gql` is the same behaviour at the GraphQL layer
  (k6 regression, `lib/odb-operations.js`); `both` is the usual pair the scenario catalog
  wants. A feature that is purely a rendering of ODB data is `e2e` only; one Explore
  merely forwards to the ODB can often be checked at `gql` first and in the UI later.
- **Today** — `covered`, `partial`, `none`, as in COVERAGE.md.
- **Done** — the same thing as a number, for sorting and counting: `1` not done, `2`
  partial, `3` complete. Change both columns together when a spec lands.
- **Needs** — what has to exist before a spec can be written. `ids` means Explore does
  not ship a `data-testid` for the element yet (the contract in
  [`explore-ask-data-testid-contract.md`](explore-ask-data-testid-contract.md) and
  Explore's `CLAUDE.md` is the mechanism; ids ship by PR to lucuma-apps and a new ask is
  one more table there). `net` means the feature reaches a service the stack does not
  run (Simbad, Gaia, CDS HiPS tiles, the Gemini archive); the stack already lets the ODB
  reach Gaia and Simbad, and Explore's own Simbad and Horizons searches go straight from
  the browser to those services, so these are runnable but not hermetic. `role` means it needs a fabricated staff or NGO identity
  (`tests/support/standard-users.ts`, built since ticket 017). `store` means it uploads
  through the object store (in the stack since ticket 028).

Test ids shipped today (from `rg '"(explore|ui)-[a-z0-9-]+"'` in lucuma-apps): login,
top bar (menu, user, Manage Programs), programs dialog (dialog, create, row, select), obs
tree (add obs, add daytime cal), target add (button, empty sidereal), configuration mode
picker (mode, instrument, AO filter, rows, accept, ITC progress), visitor editor (six
fields), sequence tile (planned, customized, step), sequence-copy dialog (five), daytime
cal instrument, proposal (title, category, band3, partners, errors, submit, retract),
user preferences (guide button), and `explore-mode-summary`. Everything else is text,
role, or CSS class.

## 1. Shell, session and navigation

| Feature | What it does | Layer | Today | Done | Needs |
|---|---|---|---|---|---|
| Guest login | "Continue as Guest" on the login dialog creates an SSO guest | both | covered (`journey.spec.ts`, k6 `login`) | 3 | — |
| Standard-user session | PI/staff session via injected SSO cookie; name in the top bar | e2e | covered (`standard-user.spec.ts`) | 3 | — |
| ORCID login | "Login with ORCID": the OAuth redirect to orcid.org and SSO's callback. Being a standard user is not what this gates: the suite already fabricates PI and staff users and injects their session, so only the handshake itself is untested | e2e | none, by decision | 1 | a mock of ORCID's three OAuth endpoints in the stack; on hold because SSO hardcodes the orcid.org host ([orcid-auth-testing-strategy.md](orcid-auth-testing-strategy.md)). Real ORCID credentials in CI are ruled out |
| Guest to standard promotion | A guest who logs in with ORCID keeps their programs under the new standard identity | both | none | 1 | same blocker: the promotion runs through the ORCID callback |
| Logout | Toolbar menu → Logout returns to the login dialog | e2e | none | 1 | ids (menu items are PrimeReact `MenuItem`s; same fix as Manage Programs) |
| Role switch | Staff/NGO/PI role dropdown in the top bar (`RoleSwitch.scala`, `#role-selector-switch`) switches the SSO role and reloads program visibility | both | covered (`role-switch.spec.ts`, k6 `role-switch`; the `TEST_DUAL` persona holds pi and staff) | 3 | — |
| Landing branch | No program in URL: a user who can see no program gets one auto-created and lands on the obs tree; one who can see some gets the Proposals & Programs dialog | e2e | covered (`landing.spec.ts`: a guest lands on the obs tree of a program made for them, read back from the ODB; a PI with a program gets the dialog with that program listed) | 3 | — |
| Connections status | ODB and prefs websocket indicators (`ConnectionsStatus.scala`); Explore renders nothing past the spinner until both connect | e2e | partial (shell render proves both) | 2 | ids to assert the indicator itself |
| Tab navigation | Overview, Proposal, Observations, Targets, Constraints, Scheduling tabs and their URL routes (`Page.scala`: 19 pages) | e2e | partial (journey lands on Observations) | 2 | ids for the tab buttons; the URL shapes are stable and assertable now |
| Deep links and reference resolvers | `/G-2026A-0001`, `/G-2026A-0001-Q`, `/G-2026A-0001-Q-0001` resolve to the proposal, program or observation page; unknown labels toast and fall back | both | covered (`deep-links.spec.ts`; the proposal reference in `proposals.spec.ts` scenario 5; k6 `resolve-reference`) | 3 | — |
| Recent programs | "Recent Progs" submenu of the toolbar menu, from local prefs | e2e | none | 1 | ids |
| Keyboard shortcuts | `o/t/r/n/s` switch tabs, `j/k` move in the obs tree, `y`/`mod+c` copy and `p`/`mod+v` paste observations, `F1`/`?` opens the shortcuts help, `w` cycles wavelength units (`shortcuts.scala`) | e2e | covered (`keyboard-shortcuts.spec.ts`: tabs, `j`/`k`/`s`, `y`/`p` with the clone read back, `w` with Hasura read-back, F1) | 3 | — . Upstream bug: `?` is dead, react-hotkeys-hook 5 matches on the key code so `shift+?` never fires and the `shift+slash` twin is registered but unhandled (`ExploreLayout.scala`) |
| Getting Started guide | Help panel toggled from the toolbar and from User Preferences | e2e | covered (`getting-started.spec.ts`; the guide text is fetched from GitHub, so `net`) | 3 | — |
| About, User Manual, Help Desk, Feedback | External links in the menu | e2e | none, low value | 1 | ids |
| PWA update toast | Service-worker "new version" prompt (`ExplorePWA.scala`) | — | not testable in the stack (needs two builds) | 1 | skip |
| Log level menu | Staff-only Info/Debug/Trace | — | skip | 1 | — |

## 2. Programs and proposals

| Feature | What it does | Layer | Today | Done | Needs |
|---|---|---|---|---|---|
| Proposals & Programs dialog | List, create ("Proposal" footer button creates a program), select, "Show deleted" toggle (`#show-deleted`) | both | covered (create, select, list) | 3 | — |
| Program delete/undelete | Trash / restore per row | both | none | 1 | ids on the row buttons (`data-program-id` scopes the row already) |
| Program name and description | Editable name in the dialog row and the Overview "Program description" tile (markdown) | both | none | 1 | ids |
| Program details tile | Reference, start/end, thesis, proprietary months, status, ToO activation ceiling, support users, notification toggles (`ProgramDetailsTile.scala`) | e2e | none | 1 | ids; most fields are staff-only edits (role) |
| Program notes | Markdown notes with private/public flag (`ProgramNotesTile`, `ProgramNoteEditor`) | both | none | 1 | ids |
| Program users and invitations | Add user, invite by email (`InviteUserPopup`: creates a key), redeem key (`RedeemInvitationsPopup`), roles, data-access flags, revoke | both | partial (PI partner link read back) | 2 | ids; invite emails land in the stack's Mailgun stand-in (`tests/support/mail.ts`), so the key can be read from the mail or from the dialog |
| Proposal editor | Title, category, abstract, call, type (Classical/Queue/DD/FT/LP/PW/SV), band 3, partner splits, PI/CoI affiliations, min total time | both | covered for the fixture's fields and splits validation | 3 | ids for the remaining fields (type, abstract, call dropdown) |
| Proposal errors tile | Explore's own list of what blocks submission | e2e | covered | 3 | — |
| Proposal attachments | Science/Team PDF upload, replace, delete, download in the proposal tab | both | covered at the ODB REST layer; Explore's upload button not yet driven | 2 | store; ids on `FileUploadButton` rows |
| Proposal PDF summary | Generated proposal summary PDF (`ProposalPdfSummaryTile`) | e2e | none | 1 | depends on the ODB's summary generation being on in the stack |
| Submit / retract | Submission bar, state-dependent buttons, deadline lock | both | covered (`proposals.spec.ts` 4–5, k6 submit/retract) | 3 | — |
| Submitted-proposal banner | `SubmittedProposalMessage`: read-only state after submission | e2e | partial (buttons asserted, banner not) | 2 | ids |
| Call for proposals (staff) | Open/close calls, deadlines, instruments | gql | covered (`proposal-call`) | 3 | the UI for calls lives outside Explore |
| AEON required instruments | Multi-facility proposal table | e2e | none | 1 | ids; low priority |
| Configuration requests | Program tab: request approval for unrequested configurations, withdraw, resubmit; staff approve/deny with justification feedback (`ProgramConfigRequestsTile`, `ProgramUnrequestedConfigsTile`, `ConfigurationRequestEditorPopup`) | both | none | 1 | ids; role for the staff side; the GraphQL side is plain mutations and could land in k6 first |
| Time award and time accounting | Tables of awarded, prepared, used, remaining time by band (`TimeAwardTable`, `TimeAccountingTable`) | both | none | 1 | the award is a staff mutation; the "used" column needs visits, which the k6 execution VU already records, so a joint scenario is possible |

## 3. Observation tree and observation lifecycle

| Feature | What it does | Layer | Today | Done | Needs |
|---|---|---|---|---|---|
| Create observation | "Obs" button; also "Grp" and "Add a new Daytime Calibration" (`explore-obs-tree-add-daytime-cal`) | both | covered (obs only) | 2 | ids for Grp (daytime cal has one) |
| Clone (Duplicate) | Per-badge duplicate button copies the observation | both | partial (the clone itself, through the `p` shortcut in `keyboard-shortcuts.spec.ts`; the badge button not yet) | 2 | ids on the badge buttons (ticket 032 items 2–6 are the subtitle set; the clone/delete buttons need a sibling ask) |
| Delete and undelete | Badge delete; multi-select delete with the "Observations delete" confirm dialog; undo restores | both | none | 1 | ids |
| Subtitle edit | Badge "Add description" / pencil / inline input | both | written, skipped (journey scenario 4) | 1 | ids (ticket 032) |
| Science band | Popup menu on the badge sets the band from the program's allocations | both | none | 1 | ids; needs a time award first (staff) |
| Workflow state | Activate/inactivate, ready/ongoing/completed badges, state transitions | both | none | 1 | ids; the workflow-state mutation is not in `lib/odb-operations.js` yet (the proposal spec polls the state, it does not set it) |
| Observer notes, priority, ToO activation | Observation Details tile fields | both | none | 1 | ids |
| Tellurics | Telluric selection per observation (badge dropdown Hot/A0V/…/None) | both | none | 1 | ids; only for spectroscopy modes that take tellurics |
| Blind offset indicator | Badge icon when a blind offset is set | e2e | none | 1 | ids |
| Groups | Create AND/OR groups, name, ordered, same-night, min/max delay, min required, planned/min/max time (`GroupEditBody`); nest and reorder | both | none | 1 | ids; the GraphQL side is plain and could land in k6 first |
| Drag and drop in the tree | Move observations into groups and reorder (`ObsTree`, `ViewCommon`) | e2e | none | 1 | ids + Playwright `dragTo`; react-beautiful-dnd needs the keyboard path or mouse steps |
| Copy / paste observations | `y`/`p` across the tree, and into asterism, constraint set or scheduling group views (`actions/*PasteInto*`) | e2e | partial (`y`/`p` across the tree; the paste-into views not yet) | 2 | ids for the paste-into views |
| Multi-select | Shift/ctrl click selects an `ObsIdSet`; the Targets/Constraints/Scheduling tabs then edit the set at once | e2e | none | 1 | ids |
| Observations Summary | Table view of all observations with column selector, sticky columns, filters (`ObsSummaryTile`) | e2e | none | 1 | ids on rows (`data-obs-id` pattern, as with programs) |
| Group warnings | Overview tile listing group-level problems | e2e | none | 1 | ids |
| Sequence copy dialog | When cloning an executed observation: copy all steps / pending steps / generate new | e2e | none, but the five ids ship | 1 | needs visits recorded, which the k6 execution VU can do against the stack |

## 4. Targets

| Feature | What it does | Layer | Today | Done | Needs |
|---|---|---|---|---|---|
| Add empty sidereal target | Creates a target with placeholder coordinates | both | covered | 3 | — |
| Add from Simbad | Name search in the Add Target dialog, results table, select (`TargetSource.FromSimbad`, `TargetSelectionPopup`) | e2e | none | 1 | net; ids on the search box and result rows |
| Add from program | Existing program target into the asterism | e2e | none | 1 | ids |
| Target of Opportunity | ToO target creation | both | none | 1 | ids |
| Non-sidereal target | Horizons name search and user-supplied ephemeris keys (`TargetSource.FromHorizons`) | both | none | 1 | net (JPL Horizons, called from the browser); ids |
| Target editor: coordinates | RA/Dec, epoch, proper motion, parallax, radial velocity / redshift (`RVInput`, `PositionCoordinatesEditor`) | both | partial (coordinates set via API) | 2 | ids |
| Target editor: search form | "Fetch" from Simbad into an existing target, "Replace Target Data" | e2e | none | 1 | net; ids |
| Source profile and SED | Point/uniform/gaussian, spectral definition (stellar library, galaxy, planet, power law, black body, user-defined), brightnesses table, emission lines (`spectralDefinition/*`) | both | none | 1 | ids; a good `gql` candidate first because the ITC needs it |
| Asterism table | Multiple targets per observation, add/remove, reorder | both | none | 1 | ids (`explore-target-add` only renders when empty) |
| Target clone on edit | Editing a target shared by other observations offers clone-vs-edit-all (`TargetCloneSelector`) | both | none | 1 | ids |
| Target import | CSV/text import popup with error column (`TargetImportPopup`) | e2e | none | 1 | ids |
| Target summary table | Program-wide targets tab with columns and selection | e2e | none | 1 | ids |
| Target paste / delete | Program-level target actions (`targets/*`) | e2e | none | 1 | ids |
| Aladin sky view | HiPS image, overlays, mouse position, toolbar (center on target), preferences menu, FOV shapes, AGS overlay, tracking map | e2e | none | 1 | net (CDS tiles); only the controls are assertable, not the image |
| AGS (guide star) | Automatic guide-star search, probe selection, position angle modes (`UseAgs`, `GuideProbeControl`, `PAConfigurationPanel`) | both | none | 1 | net (Gaia through the ODB); results are nondeterministic by catalog revision, so assert "a candidate was found", not which |
| Blind offset | Blind-offset target control | both | none | 1 | ids |
| Region editor | Region (non-point) targets | both | none | 1 | ids |
| Elevation plot | Night/semester plots, moon, series options (`plots/*`) | e2e | none | 1 | Highcharts SVG; assert the tile and series toggles only |

## 5. Observation configuration

| Feature | What it does | Layer | Today | Done | Needs |
|---|---|---|---|---|---|
| Mode picker | Spectroscopy/Imaging/Visitor/Keck/Subaru, instrument filter, modes table, ITC column, accept | both | covered for every single-target mode, taking defaults (`observing-modes.spec.ts`) | 3 | — |
| Science requirements | Wavelength, resolution, S/N or time-and-count exposure time mode, wavelength coverage, focal plane, capability (`SpectroscopyConfigurationPanel`, `ExposureTimeModeEditor`, `TimeAndCountEditor`) | both | none per field | 1 | ids |
| Imaging requirements | Filters, variant, S/N (`ImagingConfigurationPanel`, `ImagingFiltersPanel`) | both | none per field | 1 | ids |
| Per-instrument advanced editors | GMOS N/S long slit, MOS, IFU; Flamingos-2 long slit, imaging, MOS; GNIRS long slit, IFU, imaging, wavelengths; GHOST IFU; IGRINS-2; visitor/resident visitor; Altair; Keck/Subaru exchange (`config/*Panel.scala`) | both | none | 1 | ids; one spec per instrument, asserting the ODB's observing-mode read-back after an edit |
| Revert to basic configuration | "Advanced configuration" buttons: revert, apply (`AdvancedConfigButtons`) | both | none | 1 | ids |
| Offsets and telescope configs | Spatial offsets editor, presets, generator (`config/offsets/*`) | both | none | 1 | ids |
| MOS mask | Mask picker (upload a custom mask) | both | none | 1 | store; ids |
| Position angle | Fixed, allow flip, average parallactic, unconstrained | both | none | 1 | ids |
| Observation time | Observation date/time editor (`ObsTimeEditor`) | both | none | 1 | ids |
| Daytime calibration | Daytime configuration tile, calibration sets table, instrument (`DaytimeConfigurationTile`, `explore-daytime-cal-instrument`) | both | none | 1 | role (staff) |
| ITC tile | Spectroscopy plot and imaging results, exposure count, S/N at wavelength, graph controls (`itc/*`) | e2e | partial (appearance) | 2 | ids on the result figures |
| Sequence tile | Generated sequence steps, planned time, "customized" flag, per-instrument tables, execution state per step | e2e | covered (planned + steps exist) | 3 | — ; executed-step rendering needs visits (k6 execution VU) |
| Validations | Observation validations table (Overview "warnings and errors") | e2e | none | 1 | ids |
| Archive duplication search | "Run check" against the Gemini archive for duplicates | e2e | none | 1 | net (archive); skip in CI |

## 6. Constraints and scheduling

| Feature | What it does | Layer | Today | Done | Needs |
|---|---|---|---|---|---|
| Constraint set | Image quality, cloud extinction, water vapor, sky background, elevation range (air mass / hour angle), "likelihood of selected conditions" | both | none | 1 | ids; `lib/odb-operations.js` already reads `constraintSet` back, so the assertion side exists |
| Constraints tab | Shared constraint groups across selected observations | both | none | 1 | ids |
| Timing windows | Inclusion/exclusion windows, forever/through, repeat period and count, delete | both | none | 1 | ids |
| Scheduling mode | Scheduling tab per observation set | both | none | 1 | ids |
| Scheduling groups | Shared windows across selected observations | both | none | 1 | ids |

## 7. Attachments and finder charts

| Feature | What it does | Layer | Today | Done | Needs |
|---|---|---|---|---|---|
| Program attachments | Overview "Attachments" tile: upload by type, description edit, replace, delete, download; delete refused when assigned (`AttachmentsTile`) | both | partial (proposal PDFs via REST) | 2 | store; ids on `FileUploadButton` and rows |
| Finder charts | Per-observation finder chart upload, link to targets, overlay controls (`findercharts/*`) | both | none | 1 | store; ids |
| MOS mask upload | See §5 | both | none | 1 | store; ids |

## 8. User preferences (Hasura)

| Feature | What it does | Layer | Today | Done | Needs |
|---|---|---|---|---|---|
| Tile layouts | Drag/resize tiles per tab, survive reload; "Reset Tile Layouts" | e2e | covered (`layout-preferences.spec.ts`: a resize read back from Hasura and across a reload; Reset Tile Layouts deletes the rows and the default returns) | 3 | — |
| Tile open/closed state | Minimize tiles; persisted | e2e | covered (`layout-preferences.spec.ts`; stored as height 1 of the tile's layout row, there is no separate column) | 3 | — |
| Table column visibility and sort | Persisted per `TableId` | e2e | covered (`layout-preferences.spec.ts`: the Observations Summary's RA column and a sort by target, read back from `lucumaTablePreferences` and across a reload) | 3 | — |
| Aladin preferences | FOV, overlays, survey; persisted | e2e | none | 1 | ids |
| Global preferences | Wavelength units, elevation plot options, theme | e2e | partial (wavelength units, via `w`, read back from Hasura after a reload) | 2 | ids |
| User Preferences dialog | API keys (create with role, delete), clean local cache, show/hide Getting Started | e2e | partial (show/hide Getting Started, persisted) | 2 | ids; API-key creation is also a `gql` candidate, since the key is an SSO mutation the suite does not exercise yet |

## 9. Live updates

| Feature | What it does | Layer | Today | Done | Needs |
|---|---|---|---|---|---|
| Observation/target/program subscriptions | A change made through the API shows up in an open Explore tab without reload | e2e + k6 | k6 measures the subscription round trip (`explore-tab` subscriber VU); no browser assertion | 2 | a two-client spec: mutate through GraphQL, assert the UI updated; cheap once ids exist |
| Multi-tab consistency | Two browser contexts on the same program | e2e | none | 1 | same as above with two Playwright contexts |
| Undo / redo | Every edit goes through `UndoContext` (`UNDO.md`); undo restores the remote copy | e2e | covered (`undo-redo.spec.ts`: a constraint dropdown and the target name, each undone and redone with the ODB read back; Explore binds no key for it, the obs tree's buttons are the only path) | 3 | — |

## What to pick first

Ranked by value to the regression claim over cost, given what the stack and the ids
allow today:

1. **Observation lifecycle through the UI** — clone, delete/undelete, workflow state,
   science band. P0 in COVERAGE.md and still `partial`. Blocked only by badge ids; fold
   the clone/delete buttons into ticket 032's ask so one lucuma-apps PR unblocks both.
2. **Constraint set and timing windows** — pure ODB forwarding, deterministic, one tile
   each. Needs ids on about ten inputs; the GraphQL variant can land in k6 the same week.
3. **Groups** — create, type, ordered, delays; then drag-and-drop separately.
4. **Target editor fields** — coordinates, proper motion, RV, then source profile. The
   source profile is what the ITC consumes, so it also hardens observing-modes.
5. **Program users and invitations** — the mail stand-in already captures the invite
   email; the redeem popup closes the loop with a second fabricated user.
6. **Undo/redo and live updates** — cheap once anything above has ids, and they test the
   two mechanisms every Explore feature relies on.
7. **Per-instrument advanced editors** — large surface, one spec per instrument,
   after the mode picker ids pattern (`explore-config-*`) is extended.

Deferred by nature, not by priority: anything needing Simbad, Gaia, HiPS tiles or the
archive (runnable, not hermetic; keep out of the daily run), ORCID login (decision),
PWA update, the PDF summary (depends on the ODB's generator in the stack).
