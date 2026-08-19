/**
 * Run identity (spec §7): one string ties a CI run to its Grafana annotations, its Tempo
 * window and its entry in the `run-data` ledger.
 */

export const SUITES = /** @type {const} */ (["regression", "load"]);

/**
 * The `environment` attribute test traffic carries, so test spans are separable from
 * production traffic in the shared Grafana Cloud stack.
 * @type {Record<"regression"|"load", string>}
 */
export const ENVIRONMENT_OF = {
  regression: "ephemeral",
  load: "loadtest",
};

/**
 * @param {{suite: "regression"|"load", runId?: string}} args
 * @returns {string} e.g. `regression-5678`
 */
export function testId({ suite, runId }) {
  if (!/** @type {readonly string[]} */ (SUITES).includes(suite)) {
    throw new Error(
      `Unknown suite "${suite}" — expected one of ${SUITES.join(", ")}`,
    );
  }
  const id = (runId ?? "").trim();
  if (!id) return `${suite}-local`;
  const safe = id
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${suite}-${safe || "local"}`;
}
