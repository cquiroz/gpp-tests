import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  catalogProblems,
  expectedK6Names,
  stripIdentitySuffix,
} from "./scenario-catalog.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every non-vendored source file under the given repo-relative directories.
 * @param {...string} dirs
 */
function sourceFiles(...dirs) {
  const files = [];
  for (const dir of dirs) {
    for (const entry of readdirSync(join(repoRoot, dir), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile()) continue;
      if (!/\.(js|ts)$/.test(entry.name)) continue;
      const path = join(entry.parentPath, entry.name);
      if (path.includes("/vendor/")) continue;
      files.push(path);
    }
  }
  return files;
}

describe("scenario catalog", () => {
  it("is internally consistent", () => {
    expect(catalogProblems()).toEqual([]);
  });

  it("strips identity suffixes and nothing else", () => {
    expect(stripIdentitySuffix("scenario 2: create a program [pi]")).toBe(
      "scenario 2: create a program",
    );
    expect(stripIdentitySuffix("scenario 1: login as guest")).toBe(
      "scenario 1: login as guest",
    );
  });
});

// The k6 half of the parity invariant (the e2e half is tools/verify-parity.js, which needs
// `playwright test --list` and so lives outside vitest): the scenario names the k6 sources
// use — `scenario("name", ...)` wrappers and `scenario: "name"` metric tags — must equal the
// catalog's k6 set exactly. The names stay literals in k6 because they are Grafana series
// labels that dashboards and the threshold ledger grep for; this test is what keeps them and
// the catalog from drifting apart.
describe("k6 scenario names match the catalog", () => {
  const used = new Set();
  for (const file of sourceFiles("k6")) {
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(/\bscenario\(\s*"([^"]+)"/g)) used.add(m[1]);
    for (const m of source.matchAll(/\bscenario:\s*"([^"]+)"/g)) used.add(m[1]);
  }

  it("k6 uses every catalog scenario, and only catalog scenarios", () => {
    expect([...used].sort()).toEqual([...expectedK6Names()].sort());
  });
});

// The payload layer of parity: both suites must issue the same documents, which means every
// GraphQL document lives in lib/odb-operations.js and nowhere else. A document literal in a
// spec or a k6 script would silently fork what the two suites send.
describe("no GraphQL documents outside lib/odb-operations.js", () => {
  // A template literal opening with an operation keyword, the shape every document in
  // odb-operations.js has.
  const DOCUMENT = /`\s*(query|mutation|subscription)[\s{(]/;

  it("the pattern still recognizes real documents (canary)", () => {
    const operations = readFileSync(join(repoRoot, "lib/odb-operations.js"), "utf8");
    expect(DOCUMENT.test(operations)).toBe(true);
  });

  it("tests/ and k6/ contain none", () => {
    const offenders = sourceFiles("tests", "k6").filter((file) =>
      DOCUMENT.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
