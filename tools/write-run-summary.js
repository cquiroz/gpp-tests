#!/usr/bin/env node
/**
 * Build this run's ~1 KB summary and write it into the run-data ledger (spec §7).
 *
 *   node tools/write-run-summary.js \
 *     --suite=regression --started-at=… [--ended-at=…] \
 *     [--playwright=out/playwright-results.json] [--k6=out/k6-summary.json] \
 *     [--images=out/images.json] [--threshold-mode=armed] [--failed=k6,journey] \
 *     [--dir=.run-data]
 *
 * Prints the path it wrote (relative to the ledger root) on stdout, and the summary itself on
 * stderr, so a workflow can commit the one and read the other. Exits 1 when the run failed,
 * so the same command can be the CI gate for a threshold breach.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  breachesFromK6Summary,
  buildRunSummary,
  metricsFromK6Summary,
  scenariosFromPlaywrightReport,
  summaryPath,
} from "../lib/summary.js";
import { ENVIRONMENT_OF, testId } from "../lib/run-identity.js";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key, value];
  }),
);

/** @param {string} path */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(
      `note: could not read ${path} (${error instanceof Error ? error.message : error})`,
    );
    return undefined;
  }
}

const suite = /** @type {"regression"|"load"} */ (
  args.get("suite") ?? process.env.SUITE ?? "regression"
);
const startedAt = args.get("started-at") ?? process.env.RUN_STARTED_AT;
if (!startedAt) {
  console.error("--started-at=<ISO 8601> is required (the run's start time)");
  process.exit(2);
}
const endedAt = args.get("ended-at") ?? new Date().toISOString();

/** @param {string} key */
const readArgJson = (key) => {
  const path = args.get(key);
  return path ? readJson(path) : undefined;
};

const playwright = readArgJson("playwright");
const k6 = readArgJson("k6");
const images = readArgJson("images");

const summary = buildRunSummary({
  testid: testId({ suite, runId: process.env.GITHUB_RUN_ID }),
  suite,
  environment: process.env.OTEL_ENVIRONMENT ?? ENVIRONMENT_OF[suite],
  startedAt,
  endedAt,
  images: images ? flattenImages(images) : undefined,
  scenarios: playwright ? scenariosFromPlaywrightReport(playwright) : undefined,
  metrics: k6 ? metricsFromK6Summary(k6) : undefined,
  thresholdMode: args.get("threshold-mode") === "armed" ? "armed" : "baseline",
  breaches: k6 ? breachesFromK6Summary(k6) : [],
  // Suites whose runner failed outright, passed in from the workflow's step outcomes. A
  // crashed suite leaves no results file, so nothing else here would notice.
  failures: (args.get("failed") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  runUrl:
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined,
});

const relativePath = summaryPath(summary);
const dir = args.get("dir") ?? process.env.RUN_DATA_DIR ?? ".run-data";
const target = join(dir, relativePath);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

console.error(JSON.stringify(summary, null, 2));
console.log(relativePath);

if (summary.outcome === "fail") {
  const reason =
    summary.thresholds.breaches.join("; ") ||
    (summary.failures?.length
      ? `suite runner failed: ${summary.failures.join(", ")}`
      : "a scenario failed");
  console.error(`\nrun FAILED: ${reason}`);
  process.exit(1);
}

/**
 * `stack/scripts/record-images.sh` records `{service: {image, digest}}`; the ledger only
 * needs the digest, which is what attributes a red run to the day's merges.
 * @param {Record<string, {digest?: string} | string>} images
 */
function flattenImages(images) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [service, value] of Object.entries(images)) {
    const digest = typeof value === "string" ? value : value?.digest;
    if (digest) out[service] = digest;
  }
  return out;
}
