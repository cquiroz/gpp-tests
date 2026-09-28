---
id: 031
title: "Upstream: data-testids for Explore's observation configuration"
labels: [wayfinder:task]
status: open
assignee: carlos.quiroz
blocked-by: []
---

## Question

[030](030-observing-modes-regression-scenarios.md) selects every observing mode through
Explore's UI, and Explore's configuration tile has no stable hooks (the reason the journey
sets its mode by API — `research/prototype-status-2026-08.md` item 6). Add them ourselves
as a PR to `gemini-hlsw/lucuma-apps`, extending the contract from
[029](029-upstream-testid-contract-for-explore.md) (same naming, same manifest).

**Only what 030 uses** — 030 accepts Explore's defaults, so no per-field ids (grating,
filter, FPU, wavelength):

- the observing mode / instrument picker, and its options (one id, the mode on a
  data attribute, as 029's repeated-element pattern);
- the time-estimate display;
- the sequence tile.

Also confirm while there that visitor and exchange are reachable through the same picker.

Resolution records the PR, the ids that shipped, the dev deploy that carries them, and the
`selectors.ts` commit that consumes them.
