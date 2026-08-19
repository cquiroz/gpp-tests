// Custom metrics, and the only labels they are allowed to carry.
//
// Reads and writes are tracked separately because the spec's thresholds are separate
// (p95 read < 2 s, p95 mutation < 5 s) and because a write regression and a read regression
// mean different things. Label keys are enforced by lib/tags.js — the free Grafana Cloud
// tier's 10k series budget is shared with production metrics (spec §7).
import { Counter, Rate, Trend } from "k6/metrics";
import { metricTags } from "../../lib/tags.js";
import { SUITE, TAG_TESTID, TESTID } from "./config.js";

export const readDuration = new Trend("odb_read_duration", true);
export const writeDuration = new Trend("odb_write_duration", true);
export const graphqlErrors = new Counter("odb_graphql_errors");

// The regression suite's contribution to Grafana: per-scenario pass/fail and duration, a
// dozen series, so pass-rate-over-time exists for both suites (spec §7).
export const scenarioPass = new Rate("gpp_scenario_pass");
export const scenarioDuration = new Trend("gpp_scenario_duration", true);

/**
 * Build the label set for a sample. Always includes the suite; `testid` only when the
 * escape hatch is open.
 *
 * @param {{scenario?: string, operation?: string, status?: string}} extra
 */
export function tags(extra) {
  const candidate = { suite: SUITE, ...extra };
  if (TAG_TESTID) candidate.testid = TESTID;
  return metricTags(candidate, { allowTestid: TAG_TESTID });
}
