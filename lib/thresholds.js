/**
 * Baseline-first threshold calibration (spec §6).
 *
 * The load suite's claim is "tonight is slower than last night", so thresholds are derived
 * from the recent nights recorded in the `run-data` ledger rather than from an absolute
 * capacity number: the first three nights run threshold-free to establish a baseline, then
 * each metric is armed at the baseline median plus headroom — never looser than the spec's
 * cap, never tighter than a noise floor.
 *
 * @typedef {{suite?: string, outcome?: string, metrics?: {readP95Ms?: number, writeP95Ms?: number, errorRate?: number}}} HistoryEntry
 * @typedef {{mode: "baseline"|"armed", runsAvailable: number, baseline: {readP95Ms?: number, writeP95Ms?: number}, thresholds: Record<string, string[]>}} Calibration
 */

export const BASELINE_RUNS_REQUIRED = 3;

/** The absolute caps the spec states; calibration may tighten these but never loosen. */
export const SPEC_LIMITS = {
  readP95Ms: 2000,
  writeP95Ms: 5000,
  errorRate: 0.01,
};

/** A night 50% slower than the baseline is a regression worth failing on. */
const HEADROOM = 1.5;

/** Below this, p95 noise on a shared runner would fail runs for nothing. */
const FLOOR_MS = 500;

/**
 * @param {HistoryEntry[]} history entries from the `run-data` ledger, oldest first
 * @param {{suite?: string, window?: number, arm?: boolean}} [opts]
 * @returns {Calibration}
 */
export function calibrate(history, opts = {}) {
  const suite = opts.suite ?? "load";
  const window = opts.window ?? BASELINE_RUNS_REQUIRED;

  // Only clean runs of this suite that actually carried metrics can define a baseline.
  const usable = (history ?? []).filter(
    (entry) =>
      entry?.suite === suite &&
      entry.outcome === "pass" &&
      entry.metrics &&
      Object.keys(entry.metrics).length > 0,
  );
  const recent = usable.slice(-Math.max(window, BASELINE_RUNS_REQUIRED));

  const baseline = {
    readP95Ms: median(recent.map((e) => e.metrics?.readP95Ms)),
    writeP95Ms: median(recent.map((e) => e.metrics?.writeP95Ms)),
  };
  /** @type {Calibration["baseline"]} */
  const reportedBaseline = {};
  if (baseline.readP95Ms !== undefined)
    reportedBaseline.readP95Ms = baseline.readP95Ms;
  if (baseline.writeP95Ms !== undefined)
    reportedBaseline.writeP95Ms = baseline.writeP95Ms;

  if (usable.length < BASELINE_RUNS_REQUIRED || opts.arm === false) {
    return {
      mode: "baseline",
      runsAvailable: usable.length,
      baseline: reportedBaseline,
      thresholds: {},
    };
  }

  return {
    mode: "armed",
    runsAvailable: usable.length,
    baseline: reportedBaseline,
    thresholds: {
      odb_read_duration: [
        `p(95)<${limit(baseline.readP95Ms, SPEC_LIMITS.readP95Ms)}`,
      ],
      odb_write_duration: [
        `p(95)<${limit(baseline.writeP95Ms, SPEC_LIMITS.writeP95Ms)}`,
      ],
      http_req_failed: [`rate<${SPEC_LIMITS.errorRate}`],
    },
  };
}

/**
 * @param {number|undefined} baselineMs
 * @param {number} specCapMs
 */
function limit(baselineMs, specCapMs) {
  if (baselineMs === undefined) return specCapMs;
  const headroomed = Math.max(baselineMs * HEADROOM, FLOOR_MS);
  return Math.round(Math.min(headroomed, specCapMs));
}

/**
 * @param {(number|undefined)[]} values
 * @returns {number|undefined}
 */
function median(values) {
  const nums = /** @type {number[]} */ (
    values.filter((v) => typeof v === "number" && Number.isFinite(v))
  ).sort((a, b) => a - b);
  if (nums.length === 0) return undefined;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 1
    ? nums[mid]
    : (/** @type {number} */ (nums[mid - 1]) + /** @type {number} */ (nums[mid])) / 2;
}
