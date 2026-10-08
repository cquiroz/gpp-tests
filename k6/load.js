// The nightly load suite (spec §6).
//
//   SUITE=load GPP_THRESHOLDS="$(node tools/compute-thresholds.js)" \
//     k6 run -o experimental-prometheus-rw --summary-export out/k6-summary.json k6/load.js
//
// The claim is "tonight is slower than last night", not absolute capacity: thresholds come
// from the run-data ledger (threshold-free for the first three nights), and the profile is
// fixed so night-over-night numbers are comparable.
//
// Every VU is an SSO guest running the regular-operations mix (`k6/lib/guest-vu.js`): the
// ramp doubles as seeding, then a 60/40 read/write loop. The surge run (`k6/surge.js`)
// layers the same mix under proposals, execution and subscribers.
import tempo from "./vendor/http-instrumentation-tempo.js";
import {
  INSECURE_TLS,
  TEMPO_ENABLED,
  TESTID,
  endpoints,
  ledgerThresholds,
} from "./lib/config.js";
import { READ_SHARE, guestIteration } from "./lib/guest-vu.js";
import { sloThresholds, sloTrendStats } from "./lib/slos.js";

if (TEMPO_ENABLED) {
  tempo.instrumentHTTP({ propagator: "w3c" });
}

export const options = {
  insecureSkipTLSVerify: INSECURE_TLS,
  // The summary export carries only these trend stats, so every aggregation the SLO file
  // thresholds on has to be named here for the verdict to read it (ticket 023).
  summaryTrendStats: sloTrendStats(["regular"]),
  // k6 runs on a hosted GitHub runner; its CPU is the recorded ceiling for v1 (spec §6).
  scenarios: {
    guests: {
      executor: "ramping-vus",
      startVUs: 0,
      gracefulRampDown: "60s",
      stages: [
        { duration: __ENV.STAGE_1 || "5m", target: Number(__ENV.VUS_LOW || 50) },
        { duration: __ENV.STAGE_2 || "10m", target: Number(__ENV.VUS_HIGH || 200) },
        { duration: __ENV.STAGE_3 || "20m", target: Number(__ENV.VUS_HIGH || 200) },
        { duration: __ENV.STAGE_4 || "5m", target: 0 },
      ],
    },
  },
  thresholds: {
    // A functional floor that is armed on every run, baseline nights included: the ODB
    // answers a rejected GraphQL operation with HTTP 200 and an `errors` array, so
    // `http_req_failed` stays at 0% even if every mutation is failing. Without this, a night
    // where nothing worked would pass — and be recorded as a clean baseline.
    // Every operation adds one check, so this covers GraphQL-level failures too.
    checks: [`rate>${__ENV.MIN_CHECK_RATE || 0.99}`],
    // Latency and error-rate thresholds come from the ledger, and are empty for the first
    // three nights (spec §6). Ledger entries override the floors above by metric name.
    ...ledgerThresholds(),
    // The regular class's surge SLOs (ticket 023), named but not armed: the gate of this
    // suite is the ledger, but naming the per-scenario sub-metrics puts them in the summary,
    // so tools/surge-verdict.js can read the regular class off a trend run too.
    ...sloThresholds(["regular"], { arm: false }),
  },
};

export function setup() {
  console.log(
    `load run ${TESTID} against ${endpoints.odbGraphqlUrl} ` +
      `(${Math.round(READ_SHARE * 100)}% reads, thresholds: ${JSON.stringify(ledgerThresholds())})`,
  );
}

export default function () {
  guestIteration();
}
