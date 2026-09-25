# Ask for the Explore team: own a `data-testid` contract

*Written 2026-09-24 for spec §10 ask 1 and the testid contract decided in ticket 010
(`wayfinder/tickets/010-decide-dev-process-integration.md`). Carry this to
`gemini-hlsw/lucuma-apps` as an issue or a PR conversation. Explore source read at
lucuma-apps `main` `d3de3e27a7` (2026-09-23), with the versions it pins: lucuma-react
`v0.106.0`, primereact `10.9.9`.*

> **Answered 2026-09-25 — the ids yes, the contract no.** lucuma-apps took 18 of the 23
> (branch `data-testid-contract`) and dropped items **2–6**, the observation subtitle ids;
> `journey.ts` scenario 4 is parked rather than held for them. Declined with them: the
> manifest machinery — no `/testids.json`, no `version` field, no check in their CI, and no
> constants file, the ids being literals at each element. "Shape: the manifest" and "Shape:
> the check in lucuma-apps CI" below record what was asked for, not what was built — see
> [ticket 029](../wayfinder/tickets/029-upstream-testid-contract-for-explore.md).

## The ask, in one sentence

Put a `data-testid` on each of the 23 Explore elements listed below, keep the ids in one
versioned manifest in lucuma-apps, and add a CI check that fails when an id in the manifest
stops reaching the bundle.

## Why

**Selectors are the suite's largest recurring cost, and the backlog multiplies it.** Four
of the five Explore selectors were wrong on the first real boot
(`research/prototype-status-2026-08.md`). `tests/COVERAGE.md` lists seventeen functional
areas, three of them fully covered today; each of the fourteen still to write is mostly
selector work.

**Today the suite reads Explore's DOM by position, by stylesheet class and by copy.** The
toolbar menu is "the last button in the toolbar". The observation subtitle editor is found
by its CSS class. "Add a target" and "Partners" need `.first()`. A layout change, a class
rename or a copy edit turns the nightly run red, and the developer who made the change
never sees it.

**Explore has no `data-testid` today** (grepped 2026-09-24). All of Explore's DOM that the
suite touches is in `tests/support/selectors.ts` (21 locators), plus four validation-message
checks in `tests/e2e/proposals.spec.ts`. The list below covers both.

**Why a contract and not only ids.** Ids without a check drift the same way labels do, only
more slowly. Ticket 010 froze the upstream footprint: bundle artifact, one dispatch step,
this contract with its check, and a docs pointer. Nothing else goes upstream. In the
glossary's words: Explore devs promise the ids exist; scenarios promise to locate elements
only through them.

## Where: the ids

**Naming.** `explore-<area>-<element>`, kebab case, static strings. Elements in the shared
`ui/` library (also used by Observe) take `ui-` instead of `explore-`.

**Repeated elements.** The id stays static. The entity id goes in its own attribute on the
repeated root (`data-obs-id`, `data-program-id`), and children are scoped by that root. The
manifest stays a closed list, not a pattern.

```ts
page.getByTestId("explore-programs-row").and(page.locator(`[data-program-id="${pid}"]`))
    .getByTestId("explore-programs-select")
```

**Only what a scenario uses.** Where a label appears in a second place that no scenario
touches (noted below), that copy gets no id until a scenario needs it.

Paths are under `explore/app/src/main/scala/explore/` unless they start with `ui/`.

### Priority 1: addressed by position, by class, or with no accessible name

These break on any layout or styling change. Do them first.

| # | Id | Element | Source | `selectors.ts` today |
|---|----|---------|--------|----------------------|
| 1 | `explore-topbar-menu` | Toolbar menu button (icon only) | `TopBar.scala:353` | `mainMenuButton`: last toolbar button |
| 2 | `explore-obs-badge` + `data-obs-id` | Observation card root | `observationtree/ObsBadge.scala:328` | new; scoping root for 3–6 |
| 3 | `explore-obs-badge-subtitle-edit` | Pencil button (icon only) | `EditableLabel.scala`, `leftButton` | `obsBadgeSubtitleEdit`: CSS class |
| 4 | `explore-obs-badge-subtitle-input` | Swapped-in input (React id `_r_9_`) | `EditableLabel.scala`, the `InputText` | `obsBadgeSubtitleInput`: CSS class |
| 5 | `explore-obs-badge-subtitle` | Subtitle text | `EditableLabel.scala`, the text `<span>` | `obsBadgeSubtitle`: CSS class |
| 6 | `explore-obs-badge-subtitle-add` | "Add description" | `EditableLabel.scala`, the add `Button` | `obsBadgeAddDescription` |
| 7 | `explore-programs-row` + `data-program-id` | One row of the programs table | `programs/ProgramTable.scala:290`, via `rowMod` | `programRow`: row filtered by id cell |
| 8 | `explore-programs-select` | Per-row "Select" | `programs/ProgramTable.scala:123` | `selectProgramButton` |
| 9 | `explore-proposal-category` | Category dropdown (no accessible name) | `proposal/ProposalDetailsTile.scala:697` | no locator yet; next proposal scenario |

**3–6 live in `EditableLabel`, not in `ObsBadge`.** `ObsBadge.scala:238` passes CSS classes
into the shared `EditableLabel` (also used by `AttachmentsTile`). The ask is one optional
`testIdPrefix` prop on `EditableLabel` that derives `-subtitle`, `-subtitle-edit`,
`-subtitle-input` and `-subtitle-add`. ObsBadge passes `explore-obs-badge`. The manifest
lists the derived ids explicitly. **6 is the exception in this section:** it has an
accessible name today and would otherwise be Priority 3, but it comes off the same prefix
prop as 3–5, so it lands with them.

### Priority 2: the label appears more than once

These work today only because of `.first()` or because the other copy is on another tab.

| # | Id | Element | Source | `selectors.ts` today |
|---|----|---------|--------|----------------------|
| 10 | `explore-target-add` | "Add a target" split button | `targeteditor/AddTargetButton.scala:405`, label from `targeteditor/TargetTable.scala:282` | `addTargetButton`: `.first()` |
| 11 | `explore-target-add-empty-sidereal` | "Empty Sidereal Target" in the Add Target popup | `targeteditor/AddTargetButton.scala:321`, rendered by `Action.toButton` (`:156`) | `emptySiderealTargetItem` |
| 12 | `explore-obs-tree-add-obs` | "Obs" in the observations tree | `observationtree/ObsTree.scala:576` | `obsTreeAddObservationButton`: `/^obs$/` |
| 13 | `explore-proposal-partners` | "Partners" label | `proposal/ProposalDetailsTile.scala:296` | `proposalPartnersLabel`: `.first()` |

**On 10.** PrimeReact puts extra props on the split button's wrapper `<div>`, not on the
main button inside it. The suite will click
`getByTestId("explore-target-add").locator("button").first()`, which needs no wrapper
change.

**On 11.** `AddTargetButton`'s local `Action` case class needs an optional `testId` field
that `toButton` applies. The same label also appears in `targeteditor/TargetEditor.scala:628`
(the ToO resolve popup), which no scenario uses.

**On 12.** `observationtree/AsterismGroupObsList.scala:575` has another "Obs" button (targets
tab), which no scenario uses.

**On 13.** The `selectors.ts` doc comment points at `PartnerSplitsEditor.scala`; the label
is in `ProposalDetailsTile.scala`.

### Priority 3: role and text today

These break only on copy changes. Do them last, in the same PR.

| # | Id | Element | Source | `selectors.ts` today |
|---|----|---------|--------|----------------------|
| 14 | `ui-login-guest` | "Continue as Guest" | `ui/lib/src/main/scala/lucuma/ui/components/UserSelectionForm.scala:102` | `guestLoginButton` |
| 15 | `explore-topbar-user` | Signed-in user name | `TopBar.scala:350`, the `MainUserName` span | `toolbarUserLabel` |
| 16 | `explore-menu-manage-programs` | "Manage Programs" menu item | `TopBar.scala:165` | `managePrograms` (see the menu gap below) |
| 17 | `explore-programs-dialog` | "Proposals & Programs" dialog | `programs/ProgramsPopup.scala:132` | `programsDialog` |
| 18 | `explore-programs-create` | Footer "Proposal" (creates a program) | `programs/ProgramsPopup.scala:166` | `createProgramButton` |
| 19 | `explore-proposal-submit` | "Submit Proposal" | `proposal/ProposalSubmissionBar.scala:134` | `submitProposalButton` |
| 20 | `explore-proposal-retract` | "Retract Proposal" | `proposal/ProposalSubmissionBar.scala:163` | `retractProposalButton` |
| 21 | `explore-proposal-title` | Title input | `proposal/ProposalDetailsTile.scala:687` | `proposalTitleField` |
| 22 | `explore-proposal-band3` | "Consider for Band 3" | `proposal/ProposalDetailsTile.scala:429` | `proposalBand3Field` |
| 23 | `explore-proposal-errors` | Proposal errors tile | `proposal/ProposalErrorsTile.scala:24` | none; `proposals.spec.ts:230–233` reads the page text |

**`loggedInLanding` needs no id of its own.** It is "programs dialog or the obs tree's Obs
button", the two branches of `ExploreLayout`'s `optProgramId.fold`. With 17 and 12 it
becomes
`getByTestId("explore-programs-dialog").or(getByTestId("explore-obs-tree-add-obs")).first()`.
The `.first()` stays: it disambiguates a union that Playwright's strict mode would fail if
both branches ever resolved at once, which is not the same thing as picking an element out
of a list by position.

**On 23.** The ODB's validation messages ("science attachment is required", …) stay text,
because the text *is* what the test checks. The id only scopes the check to the errors
tile, so the same words elsewhere on the page cannot satisfy it.

## Shape: emitting ids in Scala.js

**Plain VDOM.** The same mechanism Explore already uses for `data-theme`
(`HelpBody.scala:59`):

```scala
val testIdAttr = VdomAttr("data-testid")
extension (id: TestId) def tag: TagMod = testIdAttr := id.value
```

`<.span(LayoutStyles.MainUserName, TestId.TopbarUser.tag)(user.displayName)`.

**No lucuma-react change for buttons, dialogs, inputs or dropdowns.** Verified against
lucuma-react `v0.106.0` and primereact `10.9.9`:

- lucuma-react's `Button`, `Dialog`, `InputText` and `SplitButton` take
  `modifiers: Seq[TagMod]` with `.withMods(...)` and pass them to PrimeReact.
- PrimeReact merges unknown props (`getOtherProps(props)`) into the root element: the
  `<button>`, the `<input>`, the `role="dialog"` element, the split button's wrapper `<div>`.
- lucuma-ui's `FormDropdownOptional` and `FormEnumDropdownView` take `modifiers` too
  (`ProposalDetailsTile.scala:704` already sets `^.id := "category"` that way).
  `FormInputTextView` takes trailing `TagMod`s (`:694` passes `^.autoFocus`).

So: `Button(icon = Icons.Bars, ...).withMods(TestId.TopbarMenu.tag)`. Put `withMods` before
`.when(...)` / `.unless(...)`, which turn the `Button` into a `TagMod`.

**The menu gap: one small lucuma-react change.** lucuma-react's `MenuItem.Item` exposes no
`id` and no extra attributes, and PrimeReact's menu model has no per-item `data-*` either.
PrimeReact does render `item.id` as the `<li id>` (`tieredmenu.esm.js`, `id: key`). The ask
to lucuma-react:

- add `id: js.UndefOr[String]` to `MenuItem.Item` and `MenuItem.SubMenu`, set on the
  literal the way `className` is.

Explore then sets `id = TestId.MenuManagePrograms.value`, and the suite addresses 16 with
`page.locator("#explore-menu-manage-programs")`. It is the only id not read through
`getByTestId`. The check below still covers it, because it checks the manifest string, not
the attribute name.

## Shape: the manifest

**One source, two readers.** A JSON file in lucuma-apps is the source of truth. An sbt
source generator turns it into Scala constants, and the Explore build copies it into the
bundle.

```json
{
  "version": 1,
  "ids": {
    "explore-topbar-menu": "Toolbar menu button, TopBar.scala",
    "explore-obs-badge-subtitle-edit": "Pencil beside an observation subtitle, EditableLabel",
    "explore-menu-manage-programs": { "attr": "id", "note": "PrimeReact menu item, <li id>" }
  }
}
```

```scala
enum TestId(val value: String):
  case TopbarMenu           extends TestId("explore-topbar-menu")
  case ObsBadgeSubtitleEdit extends TestId("explore-obs-badge-subtitle-edit")
```

**Where it lives.** `explore/common` for `explore-*` ids, `ui/lib` for `ui-*` ids, both in
the lucuma-apps monorepo and covered by the same check.

**How gpp-tests reads it.** The manifest is served as `/testids.json` inside the Explore
bundle artifact that ticket 010 already delivers, so ids and bundle are never out of step.
`selectors.ts` fails fast with a clear message if an id it uses is missing.

**Versioning.** `version` goes up only when an id is renamed or removed; adding ids does not
bump it. A bump means gpp-tests needs a matching `selectors.ts` change, and the Explore PR
says so.

## Shape: the check in lucuma-apps CI

**Grep the linked bundle.** After `fullLinkJS`, a short script reads the manifest and greps
the output JS for each id. A missing id fails the job. No browser, no stack, a few seconds.

- It proves the id is still reachable from app code, not only defined, because Scala.js
  dead-code elimination drops constants nothing reads.
- **Verify that once when adding the check:** delete one `withMods(TestId.X.tag)` and
  confirm the job goes red. If the enum keeps every string alive, grep the Scala sources
  for each `TestId.X` use instead.

**Not a render test.** Rendering these components in a unit test needs the full
`AppContext`, ODB and SSO, which is what gpp-tests already does nightly.

## Acceptance

1. Every locator in `tests/support/selectors.ts` switches to `getByTestId` (the menu item:
   `#id`), with no position, CSS-class or copy-text selector left *identifying* an element.
   The single surviving `.first()` is `loggedInLanding`'s, on an `.or()` of two testids.
2. The regression suite is green against a local bundle carrying the ids:
   `CADDYFILE=./caddy/Caddyfile.bundle EXPLORE_BUNDLE_DIR=<explore dist>` (README,
   "Running the regression suite locally").
3. Deleting one id from Explore code makes the lucuma-apps CI check fail.
4. `/testids.json` is present in the bundle artifact.

## What gpp-tests does in return

- Moves the four `page.getByText` checks in `proposals.spec.ts` into `selectors.ts`, scoped
  to 23, so `selectors.ts` is again the only file that reads Explore's DOM.
- Migrates `selectors.ts` the week the ids land, and reads the manifest.
- Treats a red run on a manifest id as an Explore regression, and anything else as its own.

## Timing

Before the `tests/COVERAGE.md` backlog is built out. Every area added on role and text
selectors is one more to migrate later.
