// Observe execution on its own (ticket 021): N Observe instances executing seeded GMOS
// observations against the ODB, for developing and reading the stall metrics on their own.
// The surge run (`k6/surge.js`, ticket 018) layers the same VU body
// (`k6/lib/execution-vu.js`) over proposal and subscriber traffic.
//
//   source stack/.env.generated
//   OBSERVE_INSTANCES=2 STEP_SECONDS_MIN=5 STEP_SECONDS_MAX=10 DURATION=3m k6 run k6/execution.js
//
// Each VU is one Observe server instance with the service identity, on a constant-vus
// executor: an instance never ramps, it is either executing or not. Each seeds its own
// observations at start, re-seeding when they run out.
import tempo from "./vendor/http-instrumentation-tempo.js";
import { INSECURE_TLS, TEMPO_ENABLED, TESTID, endpoints } from "./lib/config.js";
import { CADENCE } from "./lib/execution.js";
import { EXECUTION_BREAKDOWN, executionVu } from "./lib/execution-vu.js";
import { sloThresholds, sloTrendStats } from "./lib/slos.js";

if (TEMPO_ENABLED) {
  tempo.instrumentHTTP({ propagator: "w3c" });
}

/** Observe instances: 2 in the realistic tier, 4 in the ceiling tier (ticket 020). */
const OBSERVE_INSTANCES = Number(__ENV.OBSERVE_INSTANCES || 2);

export const options = {
  insecureSkipTLSVerify: INSECURE_TLS,
  // The summary export carries only these trend stats, so every aggregation the SLO file
  // thresholds on has to be named here for the verdict to read it (ticket 023).
  summaryTrendStats: sloTrendStats(["errors", "execution"]),
  scenarios: {
    observe: {
      executor: "constant-vus",
      vus: OBSERVE_INSTANCES,
      duration: __ENV.DURATION || "10m",
      gracefulStop: "60s",
    },
  },
  thresholds: {
    // The execution class's SLOs and the error floor, verbatim from k6/surge-slos.json
    // (ticket 023): the k6 exit code is the verdict.
    ...sloThresholds(["errors", "execution"]),
    // Informational: the breakdown by blocking point is what a run of this script is for.
    ...EXECUTION_BREAKDOWN,
  },
};

export function setup() {
  console.log(
    `execution run ${TESTID} against ${endpoints.odbGraphqlUrl}: ${OBSERVE_INSTANCES} Observe ` +
      `instance(s), ${CADENCE.min}–${CADENCE.max} s per step`,
  );
}

export default async function () {
  await executionVu();
}
