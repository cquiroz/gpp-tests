/**
 * Reading the run-data ledger (spec §7).
 *
 * Grafana Cloud's free tier keeps metrics for 14 days, so the history that threshold
 * calibration and the long-term trend view depend on is a directory of ~1 KB summaries on
 * the `run-data` branch. This module is the only reader.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * @param {string} dir root of the checked-out ledger (the branch, not the `runs/` dir)
 * @param {{suite?: "regression"|"load"}} [opts]
 * @returns {import('../lib/summary.js').RunSummary[]} oldest run first
 */
export function loadLedger(dir, opts = {}) {
  const summaries = [];
  for (const file of jsonFiles(dir)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // A truncated or hand-edited file must not take the nightly run down with it.
      continue;
    }
    if (!isSummary(parsed)) continue;
    if (opts.suite && parsed.suite !== opts.suite) continue;
    summaries.push(parsed);
  }
  return summaries.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function jsonFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // no ledger yet: the first run has no history
  }

  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      files.push(...jsonFiles(full));
    } else if (entry.name.endsWith(".json") && statSync(full).isFile()) {
      files.push(full);
    }
  }
  return files;
}

/**
 * @param {unknown} value
 * @returns {value is import('../lib/summary.js').RunSummary}
 */
function isSummary(value) {
  const v = /** @type {any} */ (value);
  return (
    !!v &&
    typeof v === "object" &&
    typeof v.testid === "string" &&
    typeof v.suite === "string" &&
    typeof v.startedAt === "string"
  );
}
