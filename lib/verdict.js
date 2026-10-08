/**
 * The surge verdict (ticket 023): a k6 summary export read against the surge SLO file,
 * one table per class, published with the run.
 *
 * k6 already decides pass/fail at the end of a run, and its exit code is the gate. What it
 * does not give is the reading: which class failed, by how much, and which classes the run
 * never exercised at all. So this evaluates every expression in the file itself, from the
 * same numbers k6 printed, using the same grammar (lib/surge-slos.js) — a breach here is a
 * breach there.
 *
 * Reads the `--summary-export` document (values flat on the metric object, a Rate's rate
 * under `value`) and the nested `values` shape `handleSummary()` receives.
 *
 * @typedef {"pass"|"fail"|"no-data"} RowResult
 * @typedef {"metric absent"|"no samples"|"stat not exported"} NoDataReason
 * @typedef {{name: string, metric: string, expression: string, stat: string, operator: string, limit: number, observed?: number, unit: "ms"|"count"|"rate"|"per-second", result: RowResult, reason?: NoDataReason}} VerdictRow
 * @typedef {"pass"|"fail"|"not-exercised"} ClassOutcome
 * @typedef {{key: string, title: string, provisional?: string, outcome: ClassOutcome, rows: VerdictRow[]}} ClassVerdict
 * @typedef {{outcome: ClassOutcome, classes: ClassVerdict[], breaches: string[]}} SurgeVerdict
 */
import { compare, parseThresholdExpression } from "./surge-slos.js";

/**
 * @param {import('./surge-slos.js').SurgeSlos} slos
 * @param {unknown} k6Summary
 * @param {{classes?: string[]}} [opts] evaluate only these classes (default: every class)
 * @returns {SurgeVerdict}
 */
export function surgeVerdict(slos, k6Summary, opts = {}) {
  const metrics = /** @type {any} */ (k6Summary)?.metrics ?? {};
  const wanted = opts.classes;
  for (const key of wanted ?? []) {
    if (!slos.classes[key]) {
      throw new Error(`surge SLO class "${key}" is not in the file (have: ${Object.keys(slos.classes).join(", ")})`);
    }
  }
  // Always in the file's order, whatever order the filter named them in.
  const keys = Object.keys(slos.classes).filter((key) => !wanted || wanted.includes(key));

  /** @type {ClassVerdict[]} */
  const classes = keys.map((key) => {
    const cls = /** @type {import('./surge-slos.js').SloClass} */ (slos.classes[key]);
    const rows = cls.slos.flatMap((slo) =>
      slo.thresholds.map((expression) => evaluate(slo.name, slo.metric, expression, metrics[slo.metric])),
    );
    /** @type {ClassOutcome} */
    const outcome = rows.some((r) => r.result === "fail")
      ? "fail"
      : rows.every((r) => r.result === "no-data")
        ? "not-exercised"
        : "pass";
    const out = { key, title: cls.title, outcome, rows };
    return cls.provisional ? { ...out, provisional: cls.provisional } : out;
  });

  /** @type {ClassOutcome} */
  const outcome = classes.some((c) => c.outcome === "fail")
    ? "fail"
    : classes.every((c) => c.outcome === "not-exercised")
      ? "not-exercised"
      : "pass";

  // Same `metric: expression` shape as lib/summary.js's breaches, so the Grafana annotation
  // reads the same whichever tool produced it.
  const breaches = classes
    .flatMap((c) => c.rows.filter((r) => r.result === "fail").map((r) => `${r.metric}: ${r.expression}`))
    .sort();

  return { outcome, classes, breaches };
}

/**
 * @param {string} name
 * @param {string} metric
 * @param {string} expression
 * @param {any} body the metric's entry in the summary, if any
 * @returns {VerdictRow}
 */
function evaluate(name, metric, expression, body) {
  const { stat, operator, limit } = parseThresholdExpression(expression);
  const values = body?.values ?? body;
  const unit = unitOf(stat, values);
  const base = { name, metric, expression, stat, operator, limit, unit };
  if (!values) return { ...base, result: "no-data", reason: "metric absent" };
  if (!hasSamples(values)) return { ...base, result: "no-data", reason: "no samples" };
  const observed = statValue(stat, values);
  // The metric has samples but the export lacks this aggregation: k6 writes only its
  // configured `summaryTrendStats`, so a p(99) threshold it evaluated can still be missing
  // from the file. That is a summary to regenerate, not a run without data.
  if (typeof observed !== "number") return { ...base, result: "no-data", reason: "stat not exported" };
  return { ...base, observed, result: compare(observed, operator, limit) ? "pass" : "fail" };
}

/**
 * A metric that recorded nothing. k6 still lists a thresholded metric it never sampled —
 * a Trend as all zeros, a Rate as 0 passes and 0 fails — and "p95 0 ms, pass" would be a
 * lie. A Counter at 0 is a genuine zero: "lost events: 0" is the number wanted.
 *
 * @param {any} values
 */
function hasSamples(values) {
  if (typeof values.count === "number") return true;
  if (typeof values.passes === "number" || typeof values.fails === "number") {
    return (values.passes ?? 0) + (values.fails ?? 0) > 0;
  }
  return Object.values(values).some((v) => typeof v === "number" && v !== 0);
}

/**
 * @param {string} stat
 * @param {any} values
 * @returns {number|undefined}
 */
function statValue(stat, values) {
  if (stat === "rate") {
    // A Counter's `rate` is per second; a Rate metric's is `value` in the export and
    // `rate` in the handleSummary payload. Both spell it `rate` in a threshold.
    const v = values.rate ?? values.value;
    return typeof v === "number" ? v : undefined;
  }
  const v = values[stat];
  return typeof v === "number" ? v : undefined;
}

/**
 * @param {string} stat
 * @param {any} values
 * @returns {VerdictRow["unit"]}
 */
function unitOf(stat, values) {
  if (stat === "count") return "count";
  if (stat === "rate" || stat === "value") {
    return values && typeof values.count === "number" ? "per-second" : "rate";
  }
  return "ms";
}

/**
 * The verdict as GitHub-flavoured Markdown: a headline, one table per class exercised, the
 * classes the run did not exercise on one line. Written to the job summary in CI and to
 * the terminal by the AWS wizard.
 *
 * @param {SurgeVerdict} verdict
 * @param {{source?: string, sloFile?: string}} [opts]
 * @returns {string}
 */
export function renderVerdictMarkdown(verdict, opts = {}) {
  const lines = [];
  lines.push(`## Surge verdict: ${badge(verdict.outcome)}`);
  lines.push("");
  const origin = [];
  if (opts.source) origin.push(`run: \`${opts.source}\``);
  origin.push(`criteria: \`${opts.sloFile ?? "k6/surge-slos.json"}\` (ticket 023)`);
  lines.push(origin.join(" · "));
  lines.push("");

  for (const cls of verdict.classes) {
    if (cls.outcome === "not-exercised") continue;
    lines.push(`### ${cls.title}: ${badge(cls.outcome)}`);
    lines.push("");
    lines.push("| SLO | Metric | Threshold | Observed | Result |");
    lines.push("|---|---|---|---|---|");
    for (const row of cls.rows) {
      lines.push(
        `| ${row.name} | \`${row.metric}\` | ${threshold(row)} | ${observed(row)} | ${result(row)} |`,
      );
    }
    lines.push("");
    if (cls.provisional) {
      lines.push(`_Provisional: ${cls.provisional}_`);
      lines.push("");
    }
  }

  const skipped = verdict.classes.filter((c) => c.outcome === "not-exercised");
  if (skipped.length > 0) {
    lines.push(`Not exercised in this run: ${skipped.map((c) => c.title).join(", ")}.`);
    lines.push("");
  }
  return lines.join("\n");
}

/** @param {ClassOutcome} outcome */
function badge(outcome) {
  switch (outcome) {
    case "pass":
      return "✅ PASS";
    case "fail":
      return "❌ FAIL";
    default:
      return "⚪ NOT EXERCISED";
  }
}

/** @param {VerdictRow} row */
function result(row) {
  switch (row.result) {
    case "pass":
      return "✅ pass";
    case "fail":
      return "❌ **FAIL**";
    default:
      return `⚪ ${row.reason ?? "no data"}`;
  }
}

/** @param {VerdictRow} row */
function threshold(row) {
  return `${row.stat} ${row.operator === "==" || row.operator === "===" ? "=" : row.operator} ${number(row.limit, row.unit)}`;
}

/** @param {VerdictRow} row */
function observed(row) {
  if (row.observed === undefined) return "—";
  return number(row.observed, row.unit);
}

/**
 * @param {number} n
 * @param {VerdictRow["unit"]} unit
 */
function number(n, unit) {
  switch (unit) {
    case "ms":
      return `${n >= 100 ? Math.round(n) : Math.round(n * 10) / 10} ms`;
    case "rate":
      return `${Math.round(n * 10000) / 100} %`;
    case "per-second":
      return `${Math.round(n * 1000) / 1000}/s`;
    default:
      return String(n);
  }
}
