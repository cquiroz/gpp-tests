/**
 * The durable per-run record (spec §7): Grafana Cloud's free tier keeps metrics for 14
 * days, so the history that dashboards and threshold calibration rely on is a ~1 KB JSON
 * document per run, committed to the `run-data` branch.
 *
 * @typedef {"passed"|"failed"|"flaky"|"skipped"} ScenarioStatus
 * @typedef {{name: string, status: ScenarioStatus, durationSeconds: number}} ScenarioResult
 * @typedef {{readP95Ms?: number, writeP95Ms?: number, p95Ms?: number, errorRate?: number, iterations?: number, httpReqs?: number}} RunMetrics
 * @typedef {Object} RunSummary
 * @property {number} schemaVersion
 * @property {string} testid
 * @property {"regression"|"load"} suite
 * @property {string} environment
 * @property {string} startedAt
 * @property {string} endedAt
 * @property {number} durationSeconds
 * @property {"pass"|"fail"|"flaky"} outcome
 * @property {Record<string, string>} [images]
 * @property {ScenarioResult[]} [scenarios]
 * @property {RunMetrics} [metrics]
 * @property {{mode: "baseline"|"armed", breaches: string[]}} thresholds
 * @property {string[]} [failures] suite runners that failed outright, e.g. a crashed k6
 * @property {string} [runUrl]
 */

export const SUMMARY_SCHEMA_VERSION = 1;

/**
 * Turn Playwright's JSON reporter output into scenario rows. A test that only passed on
 * retry is recorded as `flaky`, never as a silent pass (spec §8).
 *
 * @param {unknown} report parsed `out/playwright-results.json`
 * @returns {ScenarioResult[]}
 */
export function scenariosFromPlaywrightReport(report) {
  /** @type {ScenarioResult[]} */
  const out = [];
  /** @param {any} suite */
  const walk = (suite) => {
    for (const spec of suite?.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const results = test.results ?? [];
        const durationSeconds = round(
          results.reduce(
            (/** @type {number} */ acc, /** @type {any} */ r) =>
              acc + (r.duration ?? 0),
            0,
          ) / 1000,
        );
        out.push({
          name: spec.title,
          status: playwrightStatus(test, results),
          durationSeconds,
        });
      }
    }
    for (const child of suite?.suites ?? []) walk(child);
  };
  for (const suite of /** @type {any} */ (report)?.suites ?? []) walk(suite);
  return out;
}

/**
 * @param {any} test
 * @param {any[]} results
 * @returns {ScenarioStatus}
 */
function playwrightStatus(test, results) {
  if (test.status === "skipped") return "skipped";
  const passed = results.some((r) => r.status === "passed");
  if (!passed) return "failed";
  return results.length > 1 ? "flaky" : "passed";
}

/**
 * Pull the handful of numbers worth keeping from k6's end-of-test summary.
 *
 * Reads the `--summary-export` document (verified against k6 v2.2.0), where each metric's
 * values sit flat on the metric object and a Rate's rate is `value`. The nested `values`
 * shape that `handleSummary()` receives is accepted too. k6's newer
 * `--new-machine-readable-summary` format is a different document entirely (metrics as an
 * array) and is deliberately not supported — the workflows do not use it.
 *
 * @param {unknown} k6Summary parsed `k6 --summary-export` payload
 * @returns {RunMetrics}
 */
export function metricsFromK6Summary(k6Summary) {
  const metrics = /** @type {any} */ (k6Summary)?.metrics ?? {};
  /** @param {string} name @param {...string} stats first stat present wins */
  const value = (name, ...stats) => {
    const body = metrics[name];
    if (!body) return undefined;
    const values = body.values ?? body;
    for (const stat of stats) {
      const v = values[stat];
      if (typeof v === "number") return round(v);
    }
    return undefined;
  };

  /** @type {RunMetrics} */
  const out = {
    readP95Ms: value("odb_read_duration", "p(95)"),
    writeP95Ms: value("odb_write_duration", "p(95)"),
    p95Ms: value("http_req_duration", "p(95)"),
    // `value` in the export, `rate` in the handleSummary payload.
    errorRate: value("http_req_failed", "value", "rate"),
    iterations: value("iterations", "count"),
    httpReqs: value("http_reqs", "count"),
  };
  for (const key of Object.keys(out)) {
    if (out[/** @type {keyof RunMetrics} */ (key)] === undefined)
      delete out[/** @type {keyof RunMetrics} */ (key)];
  }
  return out;
}

/**
 * Every k6 threshold that failed, as `metric: expression` strings.
 *
 * @param {unknown} k6Summary
 * @returns {string[]}
 */
export function breachesFromK6Summary(k6Summary) {
  const metrics = /** @type {any} */ (k6Summary)?.metrics ?? {};
  /** @type {string[]} */
  const breaches = [];
  for (const [metric, body] of Object.entries(metrics)) {
    const thresholds = /** @type {any} */ (body)?.thresholds ?? {};
    for (const [expression, result] of Object.entries(thresholds)) {
      // In the summary export a threshold entry is a bare boolean and **true means the
      // threshold failed** (verified against k6 v2.2.0, which also exits 99). The
      // handleSummary payload instead carries {ok: boolean}, where ok means satisfied.
      const failed =
        typeof result === "boolean"
          ? result
          : typeof (/** @type {any} */ (result)?.ok) === "boolean"
            ? !(/** @type {any} */ (result).ok)
            : false;
      if (failed) breaches.push(`${metric}: ${expression}`);
    }
  }
  return breaches.sort();
}

/**
 * @param {Object} args
 * @param {string} args.testid
 * @param {"regression"|"load"} args.suite
 * @param {string} args.environment
 * @param {string} args.startedAt ISO 8601
 * @param {string} args.endedAt ISO 8601
 * @param {Record<string, string>} [args.images]
 * @param {ScenarioResult[]} [args.scenarios]
 * @param {RunMetrics} [args.metrics]
 * @param {"baseline"|"armed"} [args.thresholdMode]
 * @param {string[]} [args.breaches]
 * @param {string[]} [args.failures] suite runners that failed outright (e.g. `["k6"]`)
 * @param {string} [args.runUrl]
 * @returns {RunSummary}
 */
export function buildRunSummary({
  testid,
  suite,
  environment,
  startedAt,
  endedAt,
  images,
  scenarios,
  metrics,
  thresholdMode = "baseline",
  breaches = [],
  failures = [],
  runUrl,
}) {
  const scenarioList = scenarios ?? [];
  const failed =
    failures.length > 0 ||
    breaches.length > 0 ||
    scenarioList.some((s) => s.status === "failed");
  const flaky = scenarioList.some((s) => s.status === "flaky");

  /** @type {RunSummary} */
  const summary = {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    testid,
    suite,
    environment,
    startedAt,
    endedAt,
    durationSeconds: round(
      (Date.parse(endedAt) - Date.parse(startedAt)) / 1000,
    ),
    outcome: failed ? "fail" : flaky ? "flaky" : "pass",
    thresholds: { mode: thresholdMode, breaches },
  };
  if (failures.length > 0) summary.failures = failures;
  if (images && Object.keys(images).length > 0) summary.images = images;
  if (scenarioList.length > 0) summary.scenarios = scenarioList;
  if (metrics && Object.keys(metrics).length > 0) summary.metrics = metrics;
  if (runUrl) summary.runUrl = runUrl;
  return summary;
}

/**
 * Where the record lands on the `run-data` branch: partitioned by suite and month so a
 * year of nightly runs stays browsable and `git log` on one file shows one run.
 *
 * @param {RunSummary} summary
 * @returns {string}
 */
export function summaryPath(summary) {
  const month = summary.startedAt.slice(0, 7); // YYYY-MM
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error(`startedAt must be an ISO 8601 timestamp: ${summary.startedAt}`);
  }
  return `runs/${summary.suite}/${month}/${summary.testid}.json`;
}

/** @param {number} n */
function round(n) {
  return Math.round(n * 1000) / 1000;
}
