// The surge SLO file, opened once per VU and translated into k6 thresholds (ticket 023).
//
//   summaryTrendStats: sloTrendStats(["errors", "execution"]),
//   thresholds: { ...sloThresholds(["errors", "execution"]), ...informational },
//
// The file is the one statement of what "pass" means for a surge class; a script names the
// classes it exercises and gets their expressions verbatim, so the k6 exit code and the
// verdict that tools/surge-verdict.js renders from the summary export agree by construction.
import { parseSurgeSlos, thresholdsFor, trendStatsFor } from "../../lib/surge-slos.js";

/** Relative to this module (k6 resolves `open()` that way). */
const SLO_FILE = "../surge-slos.json";

export const SURGE_SLOS = parseSurgeSlos(JSON.parse(open(SLO_FILE)));

/**
 * @param {string[]} classes keys under `classes` in the file
 * @param {{arm?: boolean}} [opts] `arm: false` names the metrics without a limit, so they
 *   show in the summary (and to the verdict) without being able to fail the run
 */
export function sloThresholds(classes, opts) {
  return thresholdsFor(SURGE_SLOS, classes, opts);
}

/**
 * The trend stats the summary export must carry for the verdict to read these classes:
 * k6 exports only the configured stats, whatever its thresholds evaluated.
 *
 * @param {string[]} classes
 */
export function sloTrendStats(classes) {
  return trendStatsFor(SURGE_SLOS, classes);
}
