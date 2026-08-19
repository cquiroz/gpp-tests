#!/usr/bin/env node
/**
 * Print the k6 thresholds for tonight's run, calibrated from the run-data ledger (spec §6).
 *
 *   GPP_THRESHOLDS="$(node tools/compute-thresholds.js)" k6 run k6/load.js
 *
 * The first three nights print `{}` — threshold-free baseline runs. After that, each metric
 * is armed at the baseline median plus headroom, capped by the spec's absolute limits. Stdout
 * is JSON only, so it can be captured; the human-readable explanation goes to stderr.
 *
 * Flags: --suite=load|regression  --dir=<ledger checkout>  --json (full calibration report)
 */
import { calibrate } from "../lib/thresholds.js";
import { loadLedger } from "./ledger.js";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key, value];
  }),
);

const suite = /** @type {"load"|"regression"} */ (
  args.get("suite") ?? process.env.SUITE ?? "load"
);
const dir = args.get("dir") ?? process.env.RUN_DATA_DIR ?? ".run-data";

const history = loadLedger(dir, { suite });
const calibration = calibrate(history, {
  suite,
  arm: process.env.ARM_THRESHOLDS === "false" ? false : undefined,
});

console.error(
  `ledger ${dir}: ${history.length} ${suite} run(s), ` +
    `${calibration.runsAvailable} usable → thresholds ${calibration.mode}`,
);
if (calibration.mode === "baseline") {
  console.error(
    "baseline-only run: no thresholds armed (spec §6 — the first three nights establish one)",
  );
} else {
  console.error(`baseline: ${JSON.stringify(calibration.baseline)}`);
}

console.log(
  JSON.stringify(args.has("json") ? calibration : calibration.thresholds),
);
