#!/usr/bin/env node
/**
 * Render the surge verdict for a k6 run (ticket 023).
 *
 *   node tools/surge-verdict.js out/k6-summary.json                 # Markdown on stdout
 *   node tools/surge-verdict.js out/k6-summary.json --classes=errors,execution
 *   node tools/surge-verdict.js out/k6-summary.json --out=out/surge-verdict.md
 *   node tools/surge-verdict.js out/k6-summary.json --breaches      # "a: p(95)<2000; b: count==0"
 *   node tools/surge-verdict.js out/k6-summary.json --json
 *
 * Reads the k6 `--summary-export` document against `k6/surge-slos.json` (or `--slos=`) and
 * prints one table per class. In a workflow it also appends the same Markdown to the job
 * summary (`$GITHUB_STEP_SUMMARY`), so the verdict is on the run's page without the log.
 *
 * `--breaches` prints only the failed expressions, `; `-separated — the shape
 * tools/grafana-annotate.js takes with `--breach=`. Nothing is printed when nothing failed.
 *
 * Exit code: 0 pass, 1 fail, 2 when the run exercised none of the classes asked for (the
 * wrong file, most likely) or the input could not be read. `--no-fail` makes it 0 always,
 * for a wizard that reports and carries on.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { parseSurgeSlos } from "../lib/surge-slos.js";
import { renderVerdictMarkdown, surgeVerdict } from "../lib/verdict.js";

const args = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((arg) => {
      const [key, value = "true"] = arg.replace(/^--/, "").split("=");
      return [key, value];
    }),
);
const summaryPath = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "out/k6-summary.json";
const sloPath = args.get("slos") ?? new URL("../k6/surge-slos.json", import.meta.url).pathname;
const noFail = args.has("no-fail");

/** @param {string} path @param {string} what */
function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`could not read ${what} ${path} (${error instanceof Error ? error.message : error})`);
    process.exit(noFail ? 0 : 2);
  }
}

const slos = parseSurgeSlos(readJson(sloPath, "the surge SLO file"));
const summary = readJson(summaryPath, "the k6 summary");
const classes = args.get("classes")?.split(",").map((c) => c.trim()).filter(Boolean);

const verdict = surgeVerdict(slos, summary, classes ? { classes } : {});

if (args.has("breaches")) {
  if (verdict.breaches.length > 0) console.log(verdict.breaches.join("; "));
  process.exit(0);
}

if (args.has("json")) {
  console.log(JSON.stringify(verdict, null, 2));
} else {
  const markdown = renderVerdictMarkdown(verdict, {
    source: summaryPath,
    sloFile: args.get("slos") ?? "k6/surge-slos.json",
  });
  console.log(markdown);
  const out = args.get("out");
  if (out) writeFileSync(out, `${markdown}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }
}

if (noFail) process.exit(0);
process.exit(verdict.outcome === "pass" ? 0 : verdict.outcome === "fail" ? 1 : 2);
