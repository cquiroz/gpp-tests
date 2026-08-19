/**
 * Grafana annotation payloads (spec §7).
 *
 * Annotations are where run identity lives: metric labels are capped for cardinality, so
 * "which run was this?" is answered by an organisation annotation at the start, end and any
 * threshold breach of a run. The same annotation window is how a failed scenario is found in
 * Tempo. Payloads target `POST /api/annotations` on the org's Grafana Cloud stack.
 *
 * @typedef {{time: number, timeEnd?: number, tags: string[], text: string}} Annotation
 * @typedef {{testid: string, suite: "regression"|"load", environment: string, runUrl?: string, at: string}} RunRef
 */

/**
 * @param {RunRef} run
 * @returns {Annotation}
 */
export function runStartAnnotation(run) {
  return {
    time: epoch(run.at),
    tags: tagsFor(run, "start"),
    text: line(`${run.suite} run <b>${escapeHtml(run.testid)}</b> started`, run),
  };
}

/**
 * @param {RunRef & {endedAt: string, outcome: "pass"|"fail"|"flaky"}} run
 * @returns {Annotation}
 */
export function runEndAnnotation(run) {
  return {
    time: epoch(run.at),
    timeEnd: epoch(run.endedAt),
    tags: tagsFor(run, run.outcome),
    text: line(
      `${run.suite} run <b>${escapeHtml(run.testid)}</b> finished: ${run.outcome.toUpperCase()}`,
      run,
    ),
  };
}

/**
 * @param {RunRef & {breaches: string[]}} run
 * @returns {Annotation}
 */
export function breachAnnotation(run) {
  const list = run.breaches.map((b) => escapeHtml(b)).join(", ");
  return {
    time: epoch(run.at),
    tags: tagsFor(run, "breach"),
    text: line(
      `threshold breach in <b>${escapeHtml(run.testid)}</b>: ${list}`,
      run,
    ),
  };
}

/**
 * @param {RunRef} run
 * @param {string} kind
 * @returns {string[]}
 */
function tagsFor(run, kind) {
  return ["odbattr", run.suite, run.environment, run.testid, kind];
}

/**
 * @param {string} body
 * @param {RunRef} run
 */
function line(body, run) {
  return run.runUrl ? `${body} — <a href="${run.runUrl}">CI run</a>` : body;
}

/** @param {string} iso */
function epoch(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(`Annotation timestamp must be ISO 8601, got: ${iso}`);
  }
  return ms;
}

/** @param {string} s Annotation text renders as HTML in Grafana tooltips. */
function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
