// The scenario parity catalog: the single list of test scenarios, and which suite covers
// each — the Playwright e2e journey (`tests/e2e/`), the k6 GraphQL suites (`k6/`), or both.
//
// The invariant this file exists to hold: **every scenario runs on both sides unless its
// entry says why it cannot.** Payload parity is already by construction (both suites import
// every document from `lib/odb-operations.js`); this catalog closes the coverage layer, where
// the correspondence used to live only in matching names ("scenario 2: create a program" ↔
// "create-program") that nothing enforced.
//
// Enforcement is two-sided and runs in `npm run check` / CI:
//   - `lib/scenario-catalog.test.js` proves the k6 side: the scenario names used in `k6/`
//     equal the catalog's k6 set exactly. The names stay string literals in the k6 sources
//     on purpose — they are Grafana series labels, and dashboards and the threshold ledger
//     reference them greppably — so the test enforces the correspondence instead of an import.
//   - `tools/verify-parity.js` proves the e2e side against `playwright test --list`: every
//     spec title has an entry here, and every expected title has a spec.
//
// So adding a scenario to either suite without deciding about the other is a red check, and
// the fix is stated in the failure: add the counterpart, or record here why it is one-sided.

/**
 * @typedef {object} Scenario
 * @property {string} key Canonical name. For both-sided scenarios it is the k6 series name.
 * @property {string[] | null} e2e The Playwright spec titles this scenario appears as, with
 *   any identity suffix (` [pi]`, ` [staff]`) stripped — one scenario can run under several
 *   identities and several login mechanics. `null`: no e2e coverage.
 * @property {string | null} k6 The k6 scenario name (the `scenario` metric tag and Grafana
 *   series label). `null`: no GraphQL-level coverage.
 * @property {string} [reason] Required when either side is `null`: why the scenario is
 *   one-sided. This is where "the divergence is the finding" gets recorded.
 */

import { OBSERVING_MODES, modeTestTitle } from "./observing-modes.js";

/** @type {Scenario[]} */
export const SCENARIOS = [
  {
    key: "login",
    e2e: [
      "scenario 1: login as guest",
      "scenario 1: login by injected session",
    ],
    k6: "login",
  },
  {
    key: "create-program",
    e2e: ["scenario 2: create a program"],
    k6: "create-program",
  },
  {
    key: "create-observation",
    e2e: ["scenario 3: create an observation with a target and configuration"],
    k6: "create-observation",
  },
  {
    key: "edit-observation",
    e2e: ["scenario 4: edit the subtitle and read it back after a reload"],
    k6: "edit-observation",
  },
  {
    key: "read-mix",
    e2e: null,
    k6: "read-mix",
    reason:
      "The same reads happen in the e2e run implicitly — Explore itself issues them when a " +
      "program opens (spec §5). The named scenario exists so k6 can weight and measure them " +
      "as the dominant read in the load model (spec §6).",
  },
  {
    key: "calculated-results",
    e2e: null,
    k6: "calculated-results",
    reason:
      "The e2e counterpart is a step inside scenario 3 ('calculated results appear'), which " +
      "polls until obscalc reports READY. At the GraphQL layer only answerability is checked, " +
      "with sequence_unavailable tolerated — see the comment on calculatedResultsScenario in " +
      "k6/lib/scenarios.js.",
  },
  {
    // Staff open the call (ticket 017). In k6 it is the regression suite's one call and the
    // surge script's setup(); the e2e spec also asserts the PI is refused.
    key: "proposal-call",
    e2e: ["scenario 1: staff opens a call for proposals"],
    k6: "proposal-call",
  },
  {
    // Program, PI details, abstract, a defined observation, the proposal — everything the ODB
    // requires before a submission except the attachments (k6/lib/proposals.js).
    key: "proposal-create",
    e2e: ["scenario 2: the PI's proposal is written against that call"],
    k6: "proposal-create",
  },
  {
    key: "proposal-validation",
    e2e: [
      "scenario 3: Explore shows the proposal, and refuses to submit it incomplete",
    ],
    k6: null,
    reason:
      "Inherently one-sided: it asserts Explore's own validation exceeding the ODB's (the " +
      "disabled Submit button naming the missing attachments — tests/COVERAGE.md). There is " +
      "no API-level analogue by definition.",
  },
  {
    // The upload leg of a submission (ticket 028). On the browser side it happens inside
    // scenario 4 below, with the same two files from lib/attachments.js; a separate e2e
    // title would only upload the fixture a second time.
    key: "proposal-attachments",
    e2e: null,
    k6: "proposal-attachments",
    reason:
      "Covered in e2e as a step of proposal-submit (scenario 4 uploads both attachments " +
      "before submitting); the REST request is shared through lib/attachments.js.",
  },
  {
    // Submit and read back the minted reference. The e2e scenario also asserts the refusal
    // without attachments and the submission email; k6 asserts the submission took, which is
    // what the surge measures at a rate (k6/proposals.js).
    key: "proposal-submit",
    e2e: [
      "scenario 4: the ODB refuses to submit without attachments, then submits and retracts once both are uploaded",
    ],
    k6: "proposal-submit",
  },
  {
    // Retract and edit: the first half of the deadline churn (ticket 017).
    key: "proposal-retract",
    e2e: null,
    k6: "proposal-retract",
    reason:
      "Covered in e2e as the last step of proposal-submit (scenario 4 retracts by API) and " +
      "by proposal-submit-ui (Explore's Retract button); k6 names it so the churn half of " +
      "the proposal loop has its own series.",
  },
  {
    key: "proposal-submit-ui",
    e2e: ["scenario 5: Explore's own Submit and Retract buttons drive the same lifecycle"],
    k6: null,
    reason:
      "Inherently one-sided: it asserts that Explore's buttons (ProposalSubmissionBar.scala) " +
      "issue the mutation scenario 4 already proved by API, and swap places as the status " +
      "changes.",
  },
  {
    // One e2e test per mode against one k6 scenario whose per-mode checks carry the mode key
    // (ticket 030). The two layers deliberately build different observations — k6 from the
    // fixture table, the browser from Explore's defaults — see lib/observing-modes.js.
    key: "observing-modes",
    e2e: OBSERVING_MODES.map(modeTestTitle),
    k6: "observing-modes",
  },
  {
    // The ODB traffic one Observe server instance produces while executing a sequence, as the
    // service identity: the surge run's time-critical class (ticket 021).
    key: "execution",
    e2e: null,
    k6: "execution",
    reason:
      "Observation execution has no browser counterpart by design: driving the real Observe " +
      "application is out of scope (wayfinder/map-gpp-tests.md), and the execution VU " +
      "reproduces its ODB call order and transport split instead (k6/lib/execution.js).",
  },
  {
    // A PI's open Explore tab: eight live subscriptions on one program over graphql-transport-ws,
    // measured for round trip and socket responsiveness (ticket 022).
    key: "explore-tab",
    e2e: null,
    k6: "explore-tab",
    reason:
      "The browser suite holds these subscriptions implicitly whenever Explore is open; the " +
      "named k6 scenario exists to hold a population of them and measure the socket " +
      "(k6/lib/subscribers.js).",
  },
  {
    // A staff member's Observe browser with one observation loaded: three subscriptions.
    key: "observe-browser",
    e2e: null,
    k6: "observe-browser",
    reason:
      "Driving the real Observe application is out of scope (wayfinder/map-gpp-tests.md); the " +
      "subscriber VU holds the subscriptions its browser would (k6/lib/subscribers.js).",
  },
  {
    key: "standard-user-smoke",
    e2e: ["a fabricated standard PI drives Explore via cookie injection"],
    k6: null,
    reason:
      "An auth-mechanics smoke for browser cookie injection " +
      "(research/orcid-auth-testing-strategy.md). The GraphQL layer's login is a token " +
      "fetch, already covered by the 'login' scenario.",
  },
];

/**
 * Strips the identity suffix `defineJourney` appends to scenario titles (` [pi]`,
 * ` [staff]`), so titles compare against the catalog's canonical form.
 *
 * @param {string} title
 * @returns {string}
 */
export function stripIdentitySuffix(title) {
  return title.replace(/\s\[[^\]]+\]$/, "");
}

/** Every e2e title the catalog expects a spec for. */
export function expectedE2eTitles() {
  return SCENARIOS.flatMap((s) => s.e2e ?? []);
}

/** Every k6 scenario name the catalog expects the k6 sources to use. */
export function expectedK6Names() {
  return SCENARIOS.flatMap((s) => (s.k6 ? [s.k6] : []));
}

/**
 * Internal-consistency problems with the catalog itself. Empty means valid; the unit test
 * and `tools/verify-parity.js` both refuse a catalog with problems.
 *
 * @returns {string[]}
 */
export function catalogProblems() {
  const problems = [];
  const seen = { key: new Set(), e2e: new Set(), k6: new Set() };

  for (const s of SCENARIOS) {
    if (seen.key.has(s.key)) problems.push(`duplicate key: ${s.key}`);
    seen.key.add(s.key);

    if (s.e2e === null && s.k6 === null) {
      problems.push(`${s.key}: covered by neither suite — delete it or cover it`);
    }
    if (s.e2e !== null && s.e2e.length === 0) {
      problems.push(`${s.key}: e2e must be null or a non-empty list of titles`);
    }
    if ((s.e2e === null || s.k6 === null) && !s.reason) {
      problems.push(`${s.key}: one-sided but carries no reason`);
    }

    for (const title of s.e2e ?? []) {
      if (seen.e2e.has(title)) problems.push(`duplicate e2e title: ${title}`);
      seen.e2e.add(title);
      if (title !== stripIdentitySuffix(title)) {
        problems.push(`${s.key}: e2e title carries an identity suffix: ${title}`);
      }
    }
    if (s.k6) {
      if (seen.k6.has(s.k6)) problems.push(`duplicate k6 name: ${s.k6}`);
      seen.k6.add(s.k6);
    }
  }

  return problems;
}
