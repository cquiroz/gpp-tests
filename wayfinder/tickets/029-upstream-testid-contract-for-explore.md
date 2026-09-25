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
