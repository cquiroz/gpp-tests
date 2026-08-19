import { describe, expect, it } from "vitest";
import {
  BASELINE_RUNS_REQUIRED,
  SPEC_LIMITS,
  calibrate,
} from "./thresholds.js";

/**
 * @param {number} readP95Ms
 * @param {number} writeP95Ms
 * @param {Partial<{suite: "load"|"regression", errorRate: number, outcome: "pass"|"fail"|"flaky"}>} [opts]
 */
const run = (readP95Ms, writeP95Ms, opts = {}) => ({
  suite: opts.suite ?? "load",
  outcome: opts.outcome ?? "pass",
  metrics: { readP95Ms, writeP95Ms, errorRate: opts.errorRate ?? 0.001 },
});

describe("calibrate", () => {
  it("stays unarmed until three baseline nights exist (spec §6)", () => {
    expect(BASELINE_RUNS_REQUIRED).toBe(3);

    for (const history of [[], [run(500, 1000)], [run(500, 1000), run(520, 1050)]]) {
      const result = calibrate(history);
      expect(result.mode).toBe("baseline");
      expect(result.thresholds).toEqual({});
      expect(result.runsAvailable).toBe(history.length);
    }
  });

  it("arms thresholds from the baseline median once three nights are in", () => {
    const result = calibrate([run(800, 2000), run(1000, 2400), run(900, 2200)]);

    expect(result.mode).toBe("armed");
    expect(result.baseline).toEqual({ readP95Ms: 900, writeP95Ms: 2200 });
    // Median × 1.5 headroom: a night 50% slower than the baseline is a regression.
    expect(result.thresholds.odb_read_duration).toEqual(["p(95)<1350"]);
    expect(result.thresholds.odb_write_duration).toEqual(["p(95)<3300"]);
  });

  it("never loosens past the spec's absolute caps", () => {
    expect(SPEC_LIMITS).toEqual({
      readP95Ms: 2000,
      writeP95Ms: 5000,
      errorRate: 0.01,
    });

    const result = calibrate([run(1900, 4800), run(1950, 4900), run(2000, 4950)]);
    expect(result.thresholds.odb_read_duration).toEqual(["p(95)<2000"]);
    expect(result.thresholds.odb_write_duration).toEqual(["p(95)<5000"]);
  });

  it("never tightens below a noise floor", () => {
    const result = calibrate([run(20, 30), run(25, 35), run(30, 40)]);
    expect(result.thresholds.odb_read_duration).toEqual(["p(95)<500"]);
    expect(result.thresholds.odb_write_duration).toEqual(["p(95)<500"]);
  });

  it("always arms the 1% error-rate threshold", () => {
    const result = calibrate([run(800, 2000), run(1000, 2400), run(900, 2200)]);
    expect(result.thresholds.http_req_failed).toEqual(["rate<0.01"]);
  });

  it("calibrates against the most recent nights only", () => {
    const history = [
      run(5000, 9000), // ancient, slow: must not drag the baseline up
      run(5000, 9000),
      run(800, 2000),
      run(1000, 2400),
      run(900, 2200),
    ];
    expect(calibrate(history, { window: 3 }).baseline).toEqual({
      readP95Ms: 900,
      writeP95Ms: 2200,
    });
  });

  it("ignores runs from another suite, failed runs and runs without metrics", () => {
    const history = [
      run(800, 2000),
      run(50, 50, { suite: "regression" }),
      run(9000, 9000, { outcome: "fail" }),
      { suite: "load", outcome: "pass" },
      run(1000, 2400),
      run(900, 2200),
    ];
    const result = calibrate(history);
    expect(result.mode).toBe("armed");
    expect(result.runsAvailable).toBe(3);
    expect(result.baseline).toEqual({ readP95Ms: 900, writeP95Ms: 2200 });
  });

  it("falls back to the spec cap for a metric the baseline never carried", () => {
    const history = [
      { suite: "load", outcome: "pass", metrics: { readP95Ms: 900 } },
      { suite: "load", outcome: "pass", metrics: { readP95Ms: 1000 } },
      { suite: "load", outcome: "pass", metrics: { readP95Ms: 800 } },
    ];
    const result = calibrate(history);
    expect(result.thresholds.odb_read_duration).toEqual(["p(95)<1350"]);
    expect(result.thresholds.odb_write_duration).toEqual(["p(95)<5000"]);
  });

  it("can be forced off for a one-off investigation run", () => {
    const armed = [run(800, 2000), run(1000, 2400), run(900, 2200)];
    expect(calibrate(armed, { arm: false })).toMatchObject({
      mode: "baseline",
      thresholds: {},
    });
  });

  it("rounds to whole milliseconds — k6 thresholds are strings", () => {
    const result = calibrate([run(333.7, 777.3), run(333.7, 777.3), run(333.7, 777.3)]);
    expect(result.thresholds.odb_read_duration?.[0]).toBe("p(95)<501");
    expect(result.thresholds.odb_write_duration?.[0]).toBe("p(95)<1166");
  });
});
