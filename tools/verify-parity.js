#!/usr/bin/env node
/**
 * The e2e half of the scenario-parity check (the k6 half is enforced by
 * `lib/scenario-catalog.test.js`): every Playwright spec title must have an entry in
 * `lib/scenario-catalog.js`, and every title the catalog expects must have a spec.
 *
 * So a new spec cannot land without deciding whether it gets a GraphQL-level counterpart —
 * the catalog entry either points at one (`k6: "name"`) or records why it is one-sided.
 *
 * Discovery is `playwright test --list`, which needs no stack and no browsers; skipped
 * specs (missing fabricated users) still list, so parity is checked on the full suite.
 * Runs as part of `npm run check`.
 *
 * Usage: node tools/verify-parity.js
 */
import { execFileSync } from "node:child_process";
import {
  catalogProblems,
  expectedE2eTitles,
  stripIdentitySuffix,
} from "../lib/scenario-catalog.js";

const problems = catalogProblems().map((p) => `catalog: ${p}`);

/** @returns {{title: string, file: string}[]} */
function listSpecs() {
  const stdout = execFileSync(
    "npx",
    ["playwright", "test", "--list", "--reporter=json"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const report = JSON.parse(stdout);

  /** @type {{title: string, file: string}[]} */
  const specs = [];
  /** @param {{specs?: {title: string, file?: string}[], suites?: any[], file?: string}} suite */
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      specs.push({ title: spec.title, file: spec.file ?? suite.file ?? "?" });
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return specs;
}

const specs = listSpecs();
if (specs.length === 0) {
  problems.push("playwright test --list found no specs — discovery is broken");
}

const expected = new Set(expectedE2eTitles());
const found = new Set();

for (const spec of specs) {
  const title = stripIdentitySuffix(spec.title);
  if (expected.has(title)) {
    found.add(title);
  } else {
    problems.push(
      `${spec.file}: "${spec.title}" has no entry in lib/scenario-catalog.js — ` +
        `add one, with a k6 counterpart or a reason it is e2e-only`,
    );
  }
}

for (const title of expected) {
  if (!found.has(title)) {
    problems.push(
      `catalog expects an e2e spec titled "${title}" but no spec defines it — ` +
        `restore the spec or update the catalog entry`,
    );
  }
}

if (problems.length > 0) {
  console.error(`scenario parity check FAILED (${problems.length}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `scenario parity OK: ${specs.length} e2e specs ↔ ${expected.size} catalog titles`,
);
