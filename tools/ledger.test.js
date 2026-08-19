import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadLedger } from "./ledger.js";

/**
 * @param {string} dir
 * @param {string} path
 * @param {unknown} body
 */
function write(dir, path, body) {
  const full = join(dir, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, typeof body === "string" ? body : JSON.stringify(body));
}

/** @param {Record<string, unknown>} overrides */
const summary = (overrides) => ({
  schemaVersion: 1,
  testid: "load-1",
  suite: "load",
  environment: "loadtest",
  startedAt: "2026-08-01T08:00:00.000Z",
  endedAt: "2026-08-01T08:40:00.000Z",
  outcome: "pass",
  thresholds: { mode: "baseline", breaches: [] },
  ...overrides,
});

describe("loadLedger", () => {
  it("reads every summary under the ledger, oldest first", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    write(dir, "runs/load/2026-08/load-3.json", summary({ testid: "load-3", startedAt: "2026-08-03T08:00:00.000Z" }));
    write(dir, "runs/load/2026-07/load-1.json", summary({ testid: "load-1", startedAt: "2026-07-30T08:00:00.000Z" }));
    write(dir, "runs/load/2026-08/load-2.json", summary({ testid: "load-2", startedAt: "2026-08-02T08:00:00.000Z" }));

    expect(loadLedger(dir).map((r) => r.testid)).toEqual([
      "load-1",
      "load-2",
      "load-3",
    ]);
  });

  it("filters by suite when asked", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    write(dir, "runs/load/2026-08/load-1.json", summary({}));
    write(
      dir,
      "runs/regression/2026-08/regression-1.json",
      summary({ testid: "regression-1", suite: "regression" }),
    );

    expect(loadLedger(dir, { suite: "load" }).map((r) => r.testid)).toEqual([
      "load-1",
    ]);
    expect(loadLedger(dir)).toHaveLength(2);
  });

  it("skips unreadable or non-summary files instead of failing the run", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    write(dir, "runs/load/2026-08/load-1.json", summary({}));
    write(dir, "runs/load/2026-08/broken.json", "{ not json");
    write(dir, "runs/load/2026-08/other.json", { hello: "world" });
    write(dir, "runs/load/2026-08/notes.txt", "ignored");
    write(dir, "README.md", "# ledger");

    expect(loadLedger(dir).map((r) => r.testid)).toEqual(["load-1"]);
  });

  it("returns nothing for a ledger that does not exist yet (first ever run)", () => {
    expect(loadLedger(join(tmpdir(), "definitely-not-here-odbattr"))).toEqual([]);
  });
});
