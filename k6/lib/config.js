// Shared k6 configuration. Endpoints, run identity and thresholds all come from the
// environment so the same scripts point at the ephemeral stack (regression) or the
// persistent load target (nightly load run) — spec §3 and §6.
import { stackEndpoints } from "../../lib/endpoints.js";
import { ENVIRONMENT_OF, testId } from "../../lib/run-identity.js";

export const SUITE = __ENV.SUITE === "load" ? "load" : "regression";
export const ENVIRONMENT = __ENV.OTEL_ENVIRONMENT || ENVIRONMENT_OF[SUITE];
export const TESTID = testId({ suite: SUITE, runId: __ENV.GITHUB_RUN_ID });

export const endpoints = stackEndpoints(__ENV);

// The ephemeral stack fronts everything with Caddy's internal CA, which k6 is not asked to
// trust (spec §3). Set K6_INSECURE_SKIP_TLS_VERIFY=false against a real-certificate target.
export const INSECURE_TLS = __ENV.K6_INSECURE_SKIP_TLS_VERIFY !== "false";

// Run identity normally lives on annotations, not on labels (spec §7). This opens the
// escape hatch for a one-off investigation where slicing metrics by run is worth the series.
export const TAG_TESTID = __ENV.K6_TAG_TESTID === "true";

// Traceparent injection, so a slow request can be found in Tempo (spec §7).
export const TEMPO_ENABLED = __ENV.K6_TEMPO !== "false";

/**
 * Thresholds are computed outside k6, from the run-data ledger, by
 * tools/compute-thresholds.js — the first three nights run threshold-free (spec §6).
 * Passed in as JSON so the script itself has no notion of "last night".
 */
export function ledgerThresholds() {
  if (!__ENV.GPP_THRESHOLDS) return {};
  try {
    return JSON.parse(__ENV.GPP_THRESHOLDS);
  } catch (error) {
    throw new Error(`GPP_THRESHOLDS is not valid JSON: ${error}`);
  }
}

/** Uniform think time between actions in a user session (spec §6: 1–5 s). */
export const THINK_TIME_SECONDS = {
  min: Number(__ENV.THINK_TIME_MIN || 1),
  max: Number(__ENV.THINK_TIME_MAX || 5),
};
