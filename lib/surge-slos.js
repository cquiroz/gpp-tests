/**
 * The surge SLO file (ticket 023): one document, `k6/surge-slos.json`, holding the absolute
 * pass criteria for each class of surge traffic as k6 threshold expressions by metric and
 * tag. The k6 scripts arm it (k6/lib/slos.js) and the verdict tool reads it back against a
 * summary export (lib/verdict.js), so the file is the single statement of what "pass"
 * means for a surge run. This module is the shape and the translation; it is pure, because
 * k6 imports it too.
 *
 * @typedef {{name: string, metric: string, thresholds: string[]}} Slo
 * @typedef {{title: string, provisional?: string, slos: Slo[]}} SloClass
 * @typedef {{source?: string, classes: Record<string, SloClass>}} SurgeSlos
 */

/**
 * A k6 threshold expression: an aggregation, a comparison and a number. k6 accepts exactly
 * these aggregations (percentiles with an optional decimal), and the verdict evaluates the
 * same grammar so the two never disagree about what an expression means.
 */
export const THRESHOLD_EXPRESSION =
  /^(p\(\d+(?:\.\d+)?\)|avg|min|med|max|count|rate|value)\s*(<=|>=|<|>|===|==|!=)\s*(-?\d+(?:\.\d+)?)$/;

/** A k6 metric name, optionally with a `{tag:value,...}` sub-metric selector. */
const METRIC_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*(\{[^{}]+\})?$/;

/**
 * Validate a parsed SLO file and return it typed. Throws with the path of the offending
 * entry: an SLO file that half-loads would arm half the criteria and look green.
 *
 * @param {unknown} document parsed JSON
 * @returns {SurgeSlos}
 */
export function parseSurgeSlos(document) {
  const doc = /** @type {any} */ (document);
  if (!doc || typeof doc !== "object" || !doc.classes || typeof doc.classes !== "object") {
    throw new Error("surge SLO file: expected an object with a `classes` map");
  }
  const names = Object.keys(doc.classes);
  if (names.length === 0) throw new Error("surge SLO file: `classes` is empty");

  for (const name of names) {
    const cls = doc.classes[name];
    if (!cls || typeof cls.title !== "string" || !cls.title) {
      throw new Error(`surge SLO file: class "${name}" needs a title`);
    }
    if (cls.provisional !== undefined && typeof cls.provisional !== "string") {
      throw new Error(`surge SLO file: class "${name}": provisional must be a string`);
    }
    if (!Array.isArray(cls.slos) || cls.slos.length === 0) {
      throw new Error(`surge SLO file: class "${name}" needs at least one SLO`);
    }
    cls.slos.forEach((/** @type {any} */ slo, /** @type {number} */ i) => {
      const where = `surge SLO file: class "${name}", SLO ${i + 1}`;
      if (!slo || typeof slo.name !== "string" || !slo.name) throw new Error(`${where}: needs a name`);
      if (typeof slo.metric !== "string" || !METRIC_NAME.test(slo.metric)) {
        throw new Error(`${where} (${slo.name}): metric must be a k6 metric name, got ${JSON.stringify(slo.metric)}`);
      }
      if (!Array.isArray(slo.thresholds) || slo.thresholds.length === 0) {
        throw new Error(`${where} (${slo.name}): needs at least one threshold expression`);
      }
      for (const expression of slo.thresholds) {
        if (typeof expression !== "string" || !THRESHOLD_EXPRESSION.test(expression.trim())) {
          throw new Error(
            `${where} (${slo.name}): ${JSON.stringify(expression)} is not a k6 threshold expression ` +
              "(e.g. p(95)<2000, count==0, rate>0.99)",
          );
        }
      }
    });
  }

  // No metric may be claimed by two classes: k6 keeps one threshold list per metric, so the
  // second class would silently overwrite the first's expressions.
  /** @type {Map<string, string>} */
  const owner = new Map();
  for (const name of names) {
    for (const slo of doc.classes[name].slos) {
      const seen = owner.get(slo.metric);
      if (seen && seen !== name) {
        throw new Error(
          `surge SLO file: metric ${slo.metric} appears in both "${seen}" and "${name}"; one class must own it`,
        );
      }
      owner.set(slo.metric, name);
    }
  }

  return /** @type {SurgeSlos} */ (doc);
}

/**
 * The k6 `options.thresholds` entries for the named classes, verbatim from the file.
 *
 * With `arm: false` every expression becomes the always-true `<stat>>=0` on the same
 * metric: k6 only puts a sub-metric in its summary when a threshold names it, so this is how
 * a script makes a class *readable* by the verdict without letting it fail the run — the
 * trend suite does that for the regular class, whose gate is the ledger.
 *
 * @param {SurgeSlos} slos
 * @param {string[]} classes
 * @param {{arm?: boolean}} [opts]
 * @returns {Record<string, string[]>}
 */
export function thresholdsFor(slos, classes, opts = {}) {
  const arm = opts.arm !== false;
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const name of classes) {
    const cls = slos.classes[name];
    if (!cls) {
      throw new Error(
        `surge SLO class "${name}" is not in the file (have: ${Object.keys(slos.classes).join(", ")})`,
      );
    }
    for (const slo of cls.slos) {
      out[slo.metric] = slo.thresholds.map((expression) => {
        if (arm) return expression;
        const parsed = parseThresholdExpression(expression);
        return `${parsed.stat}>=0`;
      });
    }
  }
  return out;
}

/** What k6 exports for a Trend unless told otherwise. */
export const DEFAULT_TREND_STATS = ["avg", "min", "med", "max", "p(90)", "p(95)"];

/**
 * The `summaryTrendStats` a script must declare for its summary export to carry every
 * aggregation the named classes threshold on. k6 evaluates a `p(99)` threshold regardless,
 * but writes only the configured stats to `--summary-export`, and a verdict read from a
 * summary without the stat could not say whether the limit held.
 *
 * @param {SurgeSlos} slos
 * @param {string[]} classes
 * @returns {string[]}
 */
export function trendStatsFor(slos, classes) {
  const stats = new Set(DEFAULT_TREND_STATS);
  for (const name of classes) {
    const cls = slos.classes[name];
    if (!cls) {
      throw new Error(
        `surge SLO class "${name}" is not in the file (have: ${Object.keys(slos.classes).join(", ")})`,
      );
    }
    for (const slo of cls.slos) {
      for (const expression of slo.thresholds) {
        const { stat } = parseThresholdExpression(expression);
        if (stat !== "count" && stat !== "rate" && stat !== "value") stats.add(stat);
      }
    }
  }
  return [...stats];
}

/**
 * @param {string} expression
 * @returns {{stat: string, operator: string, limit: number}}
 */
export function parseThresholdExpression(expression) {
  const match = THRESHOLD_EXPRESSION.exec(expression.trim());
  if (!match) throw new Error(`not a k6 threshold expression: ${JSON.stringify(expression)}`);
  return { stat: /** @type {string} */ (match[1]), operator: /** @type {string} */ (match[2]), limit: Number(match[3]) };
}

/**
 * Apply a k6 comparison. `===` is accepted because k6 accepts it; it means `==`.
 *
 * @param {number} observed
 * @param {string} operator
 * @param {number} limit
 */
export function compare(observed, operator, limit) {
  switch (operator) {
    case "<":
      return observed < limit;
    case "<=":
      return observed <= limit;
    case ">":
      return observed > limit;
    case ">=":
      return observed >= limit;
    case "==":
    case "===":
      return observed === limit;
    case "!=":
      return observed !== limit;
    default:
      throw new Error(`unknown threshold operator ${operator}`);
  }
}
