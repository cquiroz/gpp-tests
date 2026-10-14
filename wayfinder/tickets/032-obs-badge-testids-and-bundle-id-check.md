---
id: 032
title: "The obs-badge subtitle testids, and a check that our ids are in the bundle"
labels: [wayfinder:task]
status: open
assignee:
blocked-by: []
---

## Question

Two things [029](029-upstream-testid-contract-for-explore.md) left behind when it closed.

**1. The obs-badge subtitle ids (029's items 2–6).** Upstream dropped them from the batch:
`explore-obs-badge` with `data-obs-id`, and `explore-obs-badge-subtitle`, `-subtitle-edit`,
`-subtitle-input` and `-subtitle-add`. The mapping to Explore source and to our locators is in
`research/explore-ask-data-testid-contract.md` (rows 2–6). Until they land, `journey.spec.ts`
scenario 4 stays skipped, and nothing in the UI checks Explore's `observationEdit`
subscription: that a change made elsewhere arrives in an already-open page. `ObsBadge.scala`
on lucuma-apps `main` still had no testids on 2026-10-10. Carlos carries the ask upstream,
as with 029 and 031. Done here: the four obs-badge locators in `tests/support/selectors.ts`
move to the ids, scenario 4 is unskipped, and `tests/COVERAGE.md` moves Program details back
to `partial`.

**2. Check that our ids are in the bundle, on our side.** lucuma-apps declined a CI check
(029, criterion 3), so a removed or renamed id shows up here as a scenario timing out minutes
in. Before the suite runs, grep the linked Explore bundle for every id `selectors.ts` uses,
and fail with "id X is not in this bundle". Drive the check from our own list, never from the
bundle: the bundle has about 300 `(explore|ui)-…` tokens, almost all CSS class names. It runs
wherever a bundle is in hand: locally with `EXPLORE_BUNDLE_DIR`, in the per-merge lane (010),
and against the dev deploy by fetching its main script.

Resolution records the upstream PR for part 1 and the commit adding the check for part 2.
