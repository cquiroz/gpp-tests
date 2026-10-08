// The proposal loop on its own (ticket 017): PIs submitting proposals against one Call for
// Proposals at a literal rate, for developing and reading the proposal class on its own.
// The surge run (`k6/surge.js`, ticket 018) layers the same VU body
// (`k6/lib/proposal-vu.js`) under execution, subscribers and the regular mix.
//
//   source stack/.env.generated
//   SUBMISSIONS_PER_HOUR=250 DURATION=10m npm run k6:proposals
//
// Submissions arrive on a ramping-arrival-rate executor — ramp to the tier's rate, hold —
// so the realistic tier's 100–250 per hour and the ceiling's 500 are what the ODB actually
// sees, whatever each submission costs. Each VU is one PI from the standard-user pool
// (`stack/.env.standard-users.json`, written at bootstrap), kept for the run: a PI's first
// iteration builds a complete proposal from nothing and submits it; later ones either do
// that again or retract, edit and resubmit one of theirs. Staff open the call in `setup()`.
//
// `dropped_iterations` is the honest number here: an iteration k6 could not start because
// every PI was still busy with an earlier submission means the arrival rate was not met.
import tempo from "./vendor/http-instrumentation-tempo.js";
import { INSECURE_TLS, TEMPO_ENABLED, TESTID, endpoints } from "./lib/config.js";
import { PI_POOL_OFFSET, PROPOSAL_BREAKDOWN, openCallAsStaff, proposalVu } from "./lib/proposal-vu.js";
import { sloThresholds, sloTrendStats } from "./lib/slos.js";
import { poolSize } from "./lib/standard-users.js";

if (TEMPO_ENABLED) {
  tempo.instrumentHTTP({ propagator: "w3c" });
}

/** Submissions per hour: realistic tier 100–250, ceiling 500 (ticket 020). */
const SUBMISSIONS_PER_HOUR = Number(__ENV.SUBMISSIONS_PER_HOUR || 250);
const DURATION = __ENV.DURATION || "10m";
const RAMP = __ENV.RAMP || "1m";

/** PIs this script may draw from the pool. */
const MAX_PIS = Number(__ENV.MAX_PIS || 50);

/**
 * PIs k6 keeps ready. A submission from scratch takes a minute or two (mostly waiting for
 * obscalc), so the pool has to cover the rate times that; k6 adds VUs up to MAX_PIS when
 * it falls short and counts a dropped iteration when even that is not enough.
 */
const PREALLOCATED_PIS = Number(
  __ENV.PREALLOCATED_PIS || Math.min(MAX_PIS, Math.ceil((SUBMISSIONS_PER_HOUR / 3600) * 120) + 2),
);

export const options = {
  insecureSkipTLSVerify: INSECURE_TLS,
  // The summary export carries only these trend stats, so every aggregation the SLO file
  // thresholds on has to be named here for the verdict to read it (ticket 023).
  summaryTrendStats: sloTrendStats(["errors", "proposals"]),
  scenarios: {
    proposals: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1h",
      preAllocatedVUs: PREALLOCATED_PIS,
      maxVUs: MAX_PIS,
      stages: [
        { duration: RAMP, target: SUBMISSIONS_PER_HOUR },
        { duration: DURATION, target: SUBMISSIONS_PER_HOUR },
      ],
      // A submission in flight at the end is allowed to finish: a proposal built but never
      // submitted would count as a failure that the deadline did not cause.
      gracefulStop: __ENV.GRACEFUL_STOP || "4m",
    },
  },
  thresholds: {
    // The proposal class's SLOs and the error floor, verbatim from k6/surge-slos.json
    // (ticket 023): submit latency, and the arrival rate as a claim — an iteration k6 had no
    // free PI for is a submission the ODB never saw, so the literal "N per hour" did not
    // happen. The scenario must stay named `proposals` for the file's sub-metric to match.
    ...sloThresholds(["errors", "proposals"]),
    // Informational: the loop's parts, so the summary shows them.
    ...PROPOSAL_BREAKDOWN,
  },
};

export function setup() {
  const data = openCallAsStaff();
  console.log(
    `proposals run ${TESTID} against ${endpoints.odbGraphqlUrl}: ${SUBMISSIONS_PER_HOUR}/h for ` +
      `${DURATION} after a ${RAMP} ramp, call ${data.callId}, ${PREALLOCATED_PIS}–${MAX_PIS} PIs ` +
      `from a pool of ${poolSize("pi")} (offset ${PI_POOL_OFFSET})`,
  );
  return data;
}

/** @param {{callId: string}} data */
export default function (data) {
  proposalVu(data);
}
