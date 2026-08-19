#!/usr/bin/env node
/**
 * Print the thresholds a k6 run breached, one per line — or joined with `--join`.
 *
 *   node tools/k6-breaches.js out/k6-summary.json
 *   node tools/k6-breaches.js out/k6-summary.json --join   # "a: x<1; b: y<2"
 *
 * Exists so the workflows do not have to re-implement k6's threshold-reporting quirk (in the
 * summary export, `true` means *failed*) in shell — lib/summary.js stays the one place that
 * knows it. Prints nothing and exits 0 when there is nothing to report.
 */
import { readFileSync } from "node:fs";
import { breachesFromK6Summary } from "../lib/summary.js";

const args = process.argv.slice(2);
const join = args.includes("--join");
const path = args.find((a) => !a.startsWith("--")) ?? "out/k6-summary.json";

let summary;
try {
  summary = JSON.parse(readFileSync(path, "utf8"));
} catch (error) {
  console.error(
    `could not read ${path} (${error instanceof Error ? error.message : error})`,
  );
  process.exit(0);
}

const breaches = breachesFromK6Summary(summary);
if (join) {
  // One line, `; `-separated — the separator tools/grafana-annotate.js splits on.
  if (breaches.length > 0) console.log(breaches.join("; "));
} else {
  for (const breach of breaches) console.log(breach);
}
