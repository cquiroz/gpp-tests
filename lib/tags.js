/**
 * Cardinality guardrail for k6 metric labels (spec §7, ticket 007).
 *
 * The org's Grafana Cloud stack is on the free tier: 10k active series, shared with real
 * production metrics. Every k6 tag becomes a Prometheus label, so an id or a URL in a tag
 * is not a cosmetic problem — it can exhaust the tenant's series budget. The label set is
 * therefore fixed at four keys, and run identity lives on Grafana annotations instead.
 */
export const ALLOWED_TAG_KEYS = /** @type {const} */ ([
  "suite",
  "scenario",
  "operation",
  "status",
]);

/**
 * @param {Record<string, unknown>} tags
 * @param {{allowTestid?: boolean}} [opts] `allowTestid` opens the escape hatch for a
 *   one-off investigation run (`K6_TAG_TESTID=true`); off by default.
 * @returns {Record<string, string>}
 */
export function metricTags(tags, opts = {}) {
  const allowed = new Set(/** @type {string[]} */ ([...ALLOWED_TAG_KEYS]));
  if (opts.allowTestid) allowed.add("testid");

  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(tags)) {
    if (!allowed.has(key)) {
      throw new Error(
        `Metric label "${key}" is not in the label budget (${[...allowed].join(", ")}). ` +
          `See spec §7: labels are capped to keep Grafana Cloud's free-tier series budget safe.`,
      );
    }
    if (value === undefined || value === null) continue;
    out[key] = String(value);
  }
  return out;
}
