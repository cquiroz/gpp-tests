// The surge run (ticket 018, CONTEXT.md "Surge run"): the end of a Call for Proposals,
// composed from the layers that were each built and read on their own —
//
//   guests            the regular-operations read/write mix (k6/lib/guest-vu.js), ramping VUs
//   proposals         PIs submitting at a literal rate (k6/lib/proposal-vu.js), arrival rate
//   observe           Observe server instances executing sequences (k6/lib/execution-vu.js),
//                     constant VUs for the whole run
//   explore           PIs holding Explore tabs, eight subscriptions each
//                     (k6/lib/subscriber-vu.js), ramping VUs
//   observe-browsers  staff with Observe's browser open, three subscriptions each, constant
//
// — in two tiers, over the 75-minute shape ticket 020 decided: 10 minutes of ramp, 60 steady,
// 5 of drain. Every class's surge SLO is armed from k6/surge-slos.json, so the k6 exit code is
// the verdict, and tools/surge-verdict.js renders the summary export as one table per class.
//
//   source stack/.env.generated && source stack/.env.standard-users
//   SUITE=load SURGE_TIER=realistic npm run k6:surge
//   SUITE=load SURGE_TIER=ceiling RAMP_MINUTES=1 STEADY_MINUTES=3 DRAIN_MINUTES=1 npm run k6:surge
//
// | Layer                             | realistic | ceiling |
// |-----------------------------------|-----------|---------|
// | SUBMISSIONS_PER_HOUR              | 250       | 500     |
// | EXPLORE_SUBSCRIBERS (PIs)         | 100       | 200     |
// | OBSERVE_INSTANCES (service JWT)   | 2         | 4       |
// | OBSERVE_BROWSERS (staff)          | 2         | 4       |
// | REGULAR_VUS (guests)              | 200       | 200     |
//
// Any figure can be overridden by name. Identities: guests are SSO guests, Observe instances
// use the service JWT, and every other VU is its own PI or staff member from the standard-user
// pool by its test-wide VU id — k6 hands VU ids out across all scenarios from one counter, so
// the pool of each kind must be at least the run's total VU count (`setup()` refuses
// otherwise; POOL_PI_COUNT and POOL_STAFF_COUNT at bootstrap size it).
import { fail } from "k6";
import tempo from "./vendor/http-instrumentation-tempo.js";
import { INSECURE_TLS, TEMPO_ENABLED, TESTID, endpoints } from "./lib/config.js";
import { CADENCE } from "./lib/execution.js";
import { EXECUTION_BREAKDOWN, executionVu } from "./lib/execution-vu.js";
import { READ_SHARE, guestIteration } from "./lib/guest-vu.js";
import { PROPOSAL_BREAKDOWN, openCallAsStaff, proposalVu } from "./lib/proposal-vu.js";
import { sloThresholds, sloTrendStats } from "./lib/slos.js";
import { poolSize } from "./lib/standard-users.js";
import { SUBSCRIPTION_BREAKDOWN, exploreTabVu, observeBrowserVu } from "./lib/subscriber-vu.js";

if (TEMPO_ENABLED) {
  tempo.instrumentHTTP({ propagator: "w3c" });
}

/** The two tiers of ticket 020. */
const TIERS = {
  realistic: { submissionsPerHour: 250, exploreSubscribers: 100, observeInstances: 2, observeBrowsers: 2, regularVus: 200 },
  ceiling: { submissionsPerHour: 500, exploreSubscribers: 200, observeInstances: 4, observeBrowsers: 4, regularVus: 200 },
};

const TIER_NAME = __ENV.SURGE_TIER || "realistic";
const TIER = TIERS[/** @type {keyof typeof TIERS} */ (TIER_NAME)];
if (!TIER) throw new Error(`SURGE_TIER must be one of ${Object.keys(TIERS).join(", ")}, got ${TIER_NAME}`);

/** @param {string} name @param {number} fallback */
function figure(name, fallback) {
  return Number(__ENV[name] || fallback);
}

export const SURGE = {
  tier: TIER_NAME,
  submissionsPerHour: figure("SUBMISSIONS_PER_HOUR", TIER.submissionsPerHour),
  exploreSubscribers: figure("EXPLORE_SUBSCRIBERS", TIER.exploreSubscribers),
  observeInstances: figure("OBSERVE_INSTANCES", TIER.observeInstances),
  observeBrowsers: figure("OBSERVE_BROWSERS", TIER.observeBrowsers),
  regularVus: figure("REGULAR_VUS", TIER.regularVus),
  /** PIs the proposal layer may hold at once (k6 drops an iteration past this). */
  maxPis: figure("MAX_PIS", 50),
  /** Minutes: 10 ramp, 60 steady, 5 drain (ticket 020). Fractions are fine for a smoke. */
  rampMinutes: figure("RAMP_MINUTES", 10),
  steadyMinutes: figure("STEADY_MINUTES", 60),
  drainMinutes: figure("DRAIN_MINUTES", 5),
  /** How long a subscriber holds a session before reconnecting, and how often it edits. */
  sessionSeconds: figure("SESSION_SECONDS", 600),
  editCadenceSeconds: figure("EDIT_CADENCE_SECONDS", 30),
};

/**
 * PIs k6 keeps ready for the arrival rate: a submission from scratch takes a minute or two
 * (mostly waiting for obscalc), so cover the rate times that, up to the cap.
 */
const PREALLOCATED_PIS = Number(
  __ENV.PREALLOCATED_PIS ||
    Math.min(SURGE.maxPis, Math.ceil((SURGE.submissionsPerHour / 3600) * 120) + 2),
);

/** The whole run: ramp, steady, drain. */
const TOTAL_MINUTES = SURGE.rampMinutes + SURGE.steadyMinutes + SURGE.drainMinutes;

/** Every VU id the run can hand out; the pool of each kind must cover it. */
export const TOTAL_VUS =
  SURGE.regularVus + SURGE.maxPis + SURGE.exploreSubscribers + SURGE.observeInstances + SURGE.observeBrowsers;

/** @param {number} minutes */
const minutes = (minutes) => `${minutes}m`;

/** The shape every ramping layer follows. @param {number} target */
const shape = (target) => [
  { duration: minutes(SURGE.rampMinutes), target },
  { duration: minutes(SURGE.steadyMinutes), target },
  { duration: minutes(SURGE.drainMinutes), target: 0 },
];

/** Every class in the file; the surge is the run that exercises them all. */
const CLASSES = ["errors", "execution", "proposals", "regular", "subscriptions"];

export const options = {
  insecureSkipTLSVerify: INSECURE_TLS,
  // The summary export carries only these trend stats, so every aggregation the SLO file
  // thresholds on has to be named here for the verdict to read it (ticket 023).
  summaryTrendStats: sloTrendStats(CLASSES),
  scenarios: {
    guests: {
      executor: "ramping-vus",
      exec: "guests",
      startVUs: 0,
      stages: shape(SURGE.regularVus),
      gracefulRampDown: "60s",
    },
    // Must stay named `proposals`: the SLO file's `dropped_iterations{scenario:proposals}`
    // is the arrival-rate claim (ticket 023).
    proposals: {
      executor: "ramping-arrival-rate",
      exec: "proposals",
      startRate: 0,
      timeUnit: "1h",
      preAllocatedVUs: PREALLOCATED_PIS,
      maxVUs: SURGE.maxPis,
      stages: shape(SURGE.submissionsPerHour),
      // A submission in flight at the end is allowed to finish: a proposal built but never
      // submitted would count as a failure that the deadline did not cause.
      gracefulStop: __ENV.GRACEFUL_STOP || "4m",
    },
    observe: {
      executor: "constant-vus",
      exec: "observe",
      vus: SURGE.observeInstances,
      duration: minutes(TOTAL_MINUTES),
      gracefulStop: "60s",
    },
    explore: {
      executor: "ramping-vus",
      exec: "explore",
      startVUs: 0,
      stages: shape(SURGE.exploreSubscribers),
      gracefulRampDown: "30s",
    },
    "observe-browsers": {
      executor: "constant-vus",
      exec: "observeBrowsers",
      vus: SURGE.observeBrowsers,
      duration: minutes(TOTAL_MINUTES),
      gracefulStop: "30s",
    },
  },
  thresholds: {
    // Every class's surge SLOs, verbatim from k6/surge-slos.json (ticket 023): the k6 exit
    // code is the verdict.
    ...sloThresholds(CLASSES),
    // Informational breakdowns, as in each standalone profile.
    ...EXECUTION_BREAKDOWN,
    ...PROPOSAL_BREAKDOWN,
    ...SUBSCRIPTION_BREAKDOWN,
  },
};

export function setup() {
  // The pool is indexed by test-wide VU id, so a pool smaller than the VU count would hand
  // one identity to two VUs — and the model says identities are per VU (ticket 017).
  for (const kind of /** @type {const} */ (["pi", "staff"])) {
    const size = poolSize(kind);
    if (size < TOTAL_VUS) {
      fail(
        `the standard-user pool has ${size} ${kind} identities but this run can hand out ${TOTAL_VUS} VU ids; ` +
          `re-run stack/scripts/create-standard-users.sh with POOL_PI_COUNT and POOL_STAFF_COUNT >= ${TOTAL_VUS}`,
      );
    }
  }
  const data = openCallAsStaff();
  console.log(
    `surge run ${TESTID} (${SURGE.tier} tier) against ${endpoints.odbGraphqlUrl}: ` +
      `${SURGE.rampMinutes}+${SURGE.steadyMinutes}+${SURGE.drainMinutes} min; ` +
      `${SURGE.submissionsPerHour} submissions/h (${PREALLOCATED_PIS}–${SURGE.maxPis} PIs, call ${data.callId}), ` +
      `${SURGE.exploreSubscribers} Explore tabs, ${SURGE.observeInstances} Observe instance(s) at ` +
      `${CADENCE.min}–${CADENCE.max} s/step, ${SURGE.observeBrowsers} Observe browser(s), ` +
      `${SURGE.regularVus} guests (${Math.round(READ_SHARE * 100)}% reads); ${TOTAL_VUS} VU ids over a pool of ` +
      `${poolSize("pi")} PIs / ${poolSize("staff")} staff`,
  );
  return data;
}

export function guests() {
  guestIteration();
}

/** @param {{callId: string}} data */
export function proposals(data) {
  proposalVu(data);
}

export async function observe() {
  await executionVu();
}

/** A held session: stay SESSION_SECONDS, edit on the cadence, leave cleanly, reconnect. */
function session() {
  return {
    holdMs: SURGE.sessionSeconds * 1000,
    cadenceMs: SURGE.editCadenceSeconds * 1000,
    drop: false,
  };
}

export async function explore() {
  await exploreTabVu(session());
}

export async function observeBrowsers() {
  await observeBrowserVu(session());
}
