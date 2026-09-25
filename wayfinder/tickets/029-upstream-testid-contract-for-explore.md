---
id: 029
title: "Upstream ask: a data-testid contract for Explore"
labels: [wayfinder:task]
status: open
assignee: carlos.quiroz
blocked-by: []
---

## Question

Spec §10 ask 1 was "add `data-testid` to the elements the v1 journey touches". Ticket 010
promoted it to **own the contract** — a versioned manifest of stable ids in lucuma-apps
with an existence check in *their* CI — and named it one of the four things in the frozen
upstream footprint (bundle artifact, one dispatch step, this contract, a docs pointer).
Nothing has been asked for yet.

The cost is live and compounding. `tests/support/selectors.ts` holds 21 locators that read
Explore's DOM by position (the toolbar menu is "the last button in the toolbar"), by
stylesheet class (the whole ObsBadge subtitle editor) and by copy; two more need
`.first()`. Four of the five original selectors were wrong on the first real boot
(`research/prototype-status-2026-08.md`). `tests/COVERAGE.md` has fourteen areas still to
write, each mostly selector work, and every one written before the ids land is one more to
migrate after.

The ask is written as
[`research/explore-ask-data-testid-contract.md`](../../research/explore-ask-data-testid-contract.md)
— 23 ids in three priorities, each mapped to its `selectors.ts` locator and its Explore
source; the Scala.js mechanism (`withMods`, verified against lucuma-react `v0.106.0` and
primereact `10.9.9`, so no upstream change for buttons, dialogs, inputs or dropdowns); the
manifest shape and where it lives; and a grep-the-linked-bundle CI check. Carlos carries it
to `gemini-hlsw/lucuma-apps`, as with [019](019-upstream-operation-name-on-spans.md).

Two things to watch while it is open:

- **One sub-ask is not in lucuma-apps.** `MenuItem.Item` exposes no `id` and no extra
  attributes, so "Manage Programs" needs `id: js.UndefOr[String]` added in lucuma-react
  first. It is the only id the suite would read as `#id` rather than `getByTestId`.
- **The manifest rides the bundle artifact** from ticket 010 (spec §10 ask 3), served as
  `/testids.json`, so ids and bundle can never be out of step. If that artifact slips, the
  manifest needs another delivery path.

This repo's side of the bargain, due the week the ids land: migrate `selectors.ts` to the
manifest, and move the four `page.getByText` validation checks in
`tests/e2e/proposals.spec.ts` (`:230–233`) into it scoped to `explore-proposal-errors`, so
`selectors.ts` is again the only file that reads Explore's DOM.

Resolution records where the ask landed upstream, what shipped against the four acceptance
criteria, and the commit that migrates `selectors.ts`.

## Findings so far

Three updates arrived in quick succession and each revised the last; this is the settled
state, not a log of them.

**Landed: 18 of the 23 ids, on branch `data-testid-contract`, PR to follow.** Everything
except items **2–6**, the observation subtitle ids, which were dropped. Names match the ask
exactly. The repeated-element pattern works as proposed — static id on the root,
`data-program-id="p-…"` alongside it — and `loggedInLanding` keeps the `.first()` on its
`.or()`, which is the correction we sent back on the ask.

Two shapes differ from a plain `getByTestId`, both as the ask anticipated: item 16 is a
plain `id` on the `<li>` (`page.locator("#explore-menu-manage-programs")`), because
PrimeReact's menu model carries no `data-*`; and item 10's id sits on the split button's
wrapper, so the click is `getByTestId("explore-target-add").locator("button").first()`.
That second `.first()` is upstream's own instruction and is selecting within a known
wrapper, not identifying an element — worth noting because acceptance criterion 1 in the
ask claims `loggedInLanding`'s is the only one left.

**Declined: all of the contract machinery.** No JSON manifest, no `/testids.json` in the
bundle, no `version` field, no check in lucuma-apps CI. The ids are string literals written
at each element — there is no `TestId.scala` and no constants file, so the scaladoc that
was briefly offered as the rename guarantee does not exist either. What remains of the
promise is that they mention a rename in the PR that does it. A typo'd id also compiles,
where a constant would not have.

Finding what exists is `rg '"(explore|ui)-[a-z0-9-]+"' explore/app/src/main/scala
ui/lib/src/main/scala` in lucuma-apps, minus `explore-guide-button`, which is not part of
this set.

**What that costs.** The enforcement half of the contract is exactly what was refused, so
the glossary's "Explore devs promise the ids exist" (`CONTEXT.md`) is a convention with no
check behind it. A removed id is caught by a red run here, hours later, instead of a red
job upstream before merge — which is where we already were, so nothing regressed. What did
improve is real: restyling, layout changes and copy edits stop breaking the suite, and only
a deliberate removal or rename does.

**Mitigation, needing no upstream footprint: run the existence check here.** The ask wanted
it to grep the *linked* bundle, because Scala.js dead-code elimination drops what nothing
reads — and this repo has a linked bundle in hand already, in the per-merge lane (ticket
010) and locally through `CADDYFILE=./caddy/Caddyfile.bundle` + `EXPLORE_BUNDLE_DIR`.
Grepping it for the ids `selectors.ts` uses, before the suite runs, turns "a scenario timed
out four minutes in" into "id X is not in this bundle". Drive it from our own list rather
than from their `rg` output, which is a superset. Supersedes the `/testids.json` fail-fast
in the bargain paragraph above, which upstream has asked three times now to drop.

**Migration: 17 of the 21 locators in `selectors.ts` move when the PR merges.** Everything
except the four obs-badge ones (`obsBadgeSubtitle`, `obsBadgeSubtitleEdit`,
`obsBadgeSubtitleInput`, `obsBadgeAddDescription`), which stay on CSS classes and text and
are used only by the parked scenario below — `obsBadgeAddDescription` by nothing at all.
Two ids arrive with no locator yet: `explore-proposal-category`, which gets one when a
proposal scenario needs it, and `explore-proposal-errors`, which is where the four
`page.getByText` validation checks in `tests/e2e/proposals.spec.ts` (`:230–233`) move so
that `selectors.ts` is again the only file reading Explore's DOM. After that, no selector
in active use is addressed by class or by position. Nothing migrates before the PR lands:
Firebase dev hosting serves `main`, which has no ids.

**Decision: park scenario 4 rather than hold the batch for items 2–6.** `test.skip(true, …)`
at the top of `tests/support/journey.ts` scenario 4, with the reason pointing here; the body
is untouched, so unskipping is a one-line revert if the ids ever land. `tests/COVERAGE.md`
drops Program details from `partial` to `none` and names this ticket.

Skipping rather than deleting is what the parity machinery wants: `tools/verify-parity.js`
discovers titles through `playwright test --list`, which lists skipped specs, so
`lib/scenario-catalog.js` keeps its `edit-observation` entry and its k6 counterpart
untouched. Deleting would have forced that entry to `e2e: null` with a written reason — a
bigger claim than "waiting on an upstream id". `npm run typecheck` and
`npm run verify:parity` are green (17 specs ↔ 10 catalog titles).

The cost, recorded so it is not rediscovered later: no UI-side check of Explore's
`observationEdit` subscription runs until this is unskipped. The prefs and ODB sockets are
still proven by the shell rendering at all (scenario 1), but nothing now asserts that a
change made elsewhere arrives in an already-open page.

**Verified against a local build**, lucuma-apps `data-testid-contract` at `b6724eb18a`
built to `explore/heroku/static` (the path `stack/caddy/Caddyfile.bundle` expects). All 18
ids are present in the linked bundle — nothing was dropped by dead-code elimination — and
both questions left open with upstream are answered by the source:

- **Item 16 does not wait on anything.** `TopBar.scala:169` passes
  `id = "explore-menu-manage-programs"` to the menu item and the branch compiles, so the
  lucuma-react change has landed. It is a plain `<li id>`, read as
  `page.locator("#explore-menu-manage-programs")`.
- **Item 10 is on the empty-list branch only.** `TargetTable.scala:276-281` puts
  `testId := "explore-target-add"` inside `if (allRowsForEmpty.isEmpty)`, on the `<div>`
  wrapping the split button. The journey is unaffected because it adds the first target,
  but a scenario adding a *second* one will not find this id — worth knowing before the
  Targets areas (`tests/COVERAGE.md`, P1) get written. The label itself occurs once in the
  source, so `addTargetButton`'s current `.first()` is disambiguating the two `<button>`s
  PrimeReact renders inside a split button, not two places in the app; upstream's
  `.locator("button").first()` is the same disambiguation done explicitly.
- Item 11 arrived as the ask proposed it — an optional `testIdOpt` on `AddTargetButton`'s
  local `Action` case class (`AddTargetButton.scala:326`).

**One finding for the check script: drive it from our own id list, never from the bundle.**
The bundle carries ~300 tokens matching `(explore|ui)-[a-z0-9-]+`, almost all of them CSS
class names (`explore-aladin-button`, `explore-accent-color`, …). There is no way to tell a
testid from a stylesheet class by pattern, so the check has to assert "every id
`selectors.ts` uses is present", which is the direction that matters anyway.

### Migration done and verified locally

Branch `migrate-selectors-to-testids`. All 17 migratable locators moved to `getByTestId`
(the menu item to `#explore-menu-manage-programs`), `proposalErrors` added, and the four
validation checks in `tests/e2e/proposals.spec.ts` scoped to it — so `selectors.ts` is again
the only file naming Explore's DOM.

Verified against the real thing rather than reasoned about: lucuma-apps `b6724eb18a` built
to `explore/heroku/static` and served through `CADDYFILE=./caddy/Caddyfile.bundle`, with
`LUCUMA_APPS_REF=data-testid-contract` so the Hasura prefs migrations came from the same
commit (51 of them at `b6724eb`). The suite is green both before the migration (proving the
branch breaks no existing selector) and after: 14 passed, 3 skipped, ~1.1 min each time.
`npm run check` passes.

Three locators needed more than a bare `getByTestId`, each for a reason readable in the
Explore source:

- `toolbarUserLabel` keeps its `name` argument as `.filter({ hasText })`, so the assertion
  stays "this identity is shown" rather than "a name is shown".
- `addTargetButton` is `getByTestId("explore-target-add").locator("button").first()` — the
  id is on the wrapper `<div>`, as upstream documented.
- `proposalBand3Field` is `getByTestId("explore-proposal-band3").locator("input")`. Band 3
  is a dropdown whose id arrives via `modifiers`, which PrimeReact puts on the wrapper, so
  `toHaveValue` has to reach the input inside. Title differs: it takes a trailing `TagMod`
  (alongside `^.autoFocus`), which lands on the `<input>` itself.

**Operational finding, unrelated to the ids but found getting here.** `npm run stack:up`
against a `caddy_data` volume older than seven days serves TLS leaves signed by an expired
intermediate: Caddy renews the intermediate on boot but keeps serving the stale leaf, which
surfaces as `CERT_HAS_EXPIRED` from `npm run verify:operations`. `docker restart
gpp-tests-caddy-1` fixes it in seconds. Worth a line in the README's switches section.

### Landed upstream; waiting on the dev deploy

Merged to lucuma-apps `main` as `46c237cbae` (PR #1580). **Do not merge
`migrate-selectors-to-testids` until the dev deploy carries it** — the nightly runs against
Firebase dev hosting, which still served `c814a6dcb7` (PR #1572) at merge time, and a
bundle without the ids turns every migrated locator red. The gate is a hash, not a guess:

    explore/deployed-git-hash.sh explore-gemini-dev.web.app

Merge when that prints `46c237cbae` or later.

**The rename guarantee found a home after all.** `ee04a1df43` adds a "Test ids for the
end-to-end suite" section to `explore/CLAUDE.md`: it documents the `testId :=` convention,
the `data-program-id` and menu-`id` exceptions and the `rg` incantation, then says *never
remove or rename these ids*, that nothing in lucuma-apps checks them so a drop only shows
as a red gpp-tests nightly, and that an element being rewritten must carry its id across.

That last clause is the use-site-deletion case this ticket flagged as uncovered, and it is
aimed at the agents doing much of the editing. It supersedes the note above that the
promise lost its home when `TestId.scala` turned out not to exist. Still no check, so the
bundle grep is still worth building — but the convention is now written where an editor
will actually meet it.
