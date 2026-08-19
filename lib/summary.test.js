import { describe, expect, it } from "vitest";
import {
  breachesFromK6Summary,
  buildRunSummary,
  metricsFromK6Summary,
  scenariosFromPlaywrightReport,
  summaryPath,
} from "./summary.js";

const playwrightReport = {
  suites: [
    {
      title: "journey.spec.ts",
      specs: [],
      suites: [
        {
          title: "GPP v1 journey",
          specs: [
            {
              title: "guest journey: login → create program → observation → edit",
              tests: [
                {
                  status: "expected",
                  results: [
                    { status: "failed", duration: 4000 },
                    { status: "passed", duration: 6000 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe("scenariosFromPlaywrightReport", () => {
  it("reports a retried pass as flaky, not as green", () => {
    const scenarios = scenariosFromPlaywrightReport(playwrightReport);
    expect(scenarios).toEqual([
      {
        name: "guest journey: login → create program → observation → edit",
        status: "flaky",
        durationSeconds: 10,
      },
    ]);
  });

  it("reports a first-try pass as passed and a never-passing test as failed", () => {
    const report = {
      suites: [
        {
          specs: [
            { title: "a", tests: [{ results: [{ status: "passed", duration: 1500 }] }] },
            {
              title: "b",
              tests: [
                {
                  results: [
                    { status: "failed", duration: 1000 },
                    { status: "failed", duration: 1000 },
                  ],
                },
              ],
            },
            { title: "c", tests: [{ status: "skipped", results: [] }] },
          ],
        },
      ],
    };
    expect(scenariosFromPlaywrightReport(report).map((s) => s.status)).toEqual([
      "passed",
      "failed",
      "skipped",
    ]);
  });

  it("survives a truncated or missing report", () => {
    expect(scenariosFromPlaywrightReport(undefined)).toEqual([]);
    expect(scenariosFromPlaywrightReport({})).toEqual([]);
  });
});

/**
 * Shaped exactly like a real `k6 run --summary-export` document (verified against k6
 * v2.2.0): metric values sit flat on the metric, a Rate's rate is `value`, and a threshold
 * entry is a bare boolean where **true means the threshold failed**.
 */
const k6Summary = {
  root_group: {},
  metrics: {
    http_req_duration: { avg: 300, "p(95)": 1234.567 },
    http_req_failed: {
      fails: 100,
      passes: 1,
      value: 0.004,
      thresholds: { "rate<0.01": false },
    },
    odb_read_duration: {
      "p(95)": 900.4,
      thresholds: { "p(95)<2000": false },
    },
    odb_write_duration: {
      "p(95)": 5100.9,
      thresholds: { "p(95)<5000": true },
    },
    iterations: { count: 4200, rate: 1.75 },
    http_reqs: { count: 18000, rate: 7.5 },
  },
};

describe("metricsFromK6Summary", () => {
  it("keeps the few numbers the ledger and calibration need", () => {
    expect(metricsFromK6Summary(k6Summary)).toEqual({
      readP95Ms: 900.4,
      writeP95Ms: 5100.9,
      p95Ms: 1234.567,
      errorRate: 0.004,
      iterations: 4200,
      httpReqs: 18000,
    });
  });

  it("also reads the nested shape handleSummary() would hand it", () => {
    expect(
      metricsFromK6Summary({
        metrics: {
          odb_read_duration: { values: { "p(95)": 12 } },
          http_req_failed: { values: { rate: 0.5 } },
        },
      }),
    ).toEqual({ readP95Ms: 12, errorRate: 0.5 });
  });

  it("omits metrics a suite did not emit rather than writing nulls", () => {
    expect(metricsFromK6Summary({ metrics: { iterations: { count: 3 } } })).toEqual({
      iterations: 3,
    });
    expect(metricsFromK6Summary(undefined)).toEqual({});
  });
});

describe("breachesFromK6Summary", () => {
  it("lists the failed thresholds — true means breached in k6's export", () => {
    expect(breachesFromK6Summary(k6Summary)).toEqual([
      "odb_write_duration: p(95)<5000",
    ]);
  });

  it("does not mistake a satisfied threshold for a breach", () => {
    expect(
      breachesFromK6Summary({
        metrics: { checks: { thresholds: { "rate==1.0": false } } },
      }),
    ).toEqual([]);
  });

  it("understands the {ok} object shape as well", () => {
    expect(
      breachesFromK6Summary({
        metrics: {
          a: { thresholds: { "rate<0.01": { ok: false } } },
          b: { thresholds: { "rate<0.01": { ok: true } } },
        },
      }),
    ).toEqual(["a: rate<0.01"]);
  });

  it("returns nothing for a baseline run with no thresholds armed", () => {
    expect(breachesFromK6Summary({ metrics: { iterations: { count: 1 } } })).toEqual([]);
  });
});

describe("buildRunSummary", () => {
  const base = {
    testid: "load-1234",
    suite: /** @type {const} */ ("load"),
    environment: "loadtest",
    startedAt: "2026-08-20T08:00:00.000Z",
    endedAt: "2026-08-20T08:41:30.000Z",
  };

  it("computes duration and a passing outcome", () => {
    const s = buildRunSummary(base);
    expect(s.durationSeconds).toBe(2490);
    expect(s.outcome).toBe("pass");
    expect(s.thresholds).toEqual({ mode: "baseline", breaches: [] });
    expect(s.schemaVersion).toBe(1);
  });

  it("fails the run when a threshold was breached", () => {
    const s = buildRunSummary({
      ...base,
      thresholdMode: "armed",
      breaches: ["odb_write_duration: p(95)<5000"],
    });
    expect(s.outcome).toBe("fail");
  });

  it("fails on a failed scenario and is flaky on a retried one", () => {
    expect(
      buildRunSummary({
        ...base,
        scenarios: [{ name: "a", status: "failed", durationSeconds: 1 }],
      }).outcome,
    ).toBe("fail");
    expect(
      buildRunSummary({
        ...base,
        scenarios: [{ name: "a", status: "flaky", durationSeconds: 1 }],
      }).outcome,
    ).toBe("flaky");
  });

  it("fails the run when a suite runner itself failed", () => {
    // A crashed k6 or Playwright process produces no results file at all. Without this the
    // run would be recorded `pass` on the strength of having found no failures — and a
    // truncated load run's artificially low p95 would then poison the calibration baseline.
    const s = buildRunSummary({ ...base, failures: ["k6"] });
    expect(s.outcome).toBe("fail");
    expect(s.failures).toEqual(["k6"]);
  });

  it("ignores an empty failure list", () => {
    const s = buildRunSummary({ ...base, failures: [] });
    expect(s.outcome).toBe("pass");
    expect(s).not.toHaveProperty("failures");
  });

  it("records the image SHAs so a red run attributes to commits", () => {
    const s = buildRunSummary({
      ...base,
      images: { odb: "sha256:abc", sso: "sha256:def" },
    });
    expect(s.images).toEqual({ odb: "sha256:abc", sso: "sha256:def" });
  });

  it("stays inside the ~1 KB budget for a full regression run", () => {
    const s = buildRunSummary({
      ...base,
      suite: "regression",
      environment: "ephemeral",
      images: {
        odb: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        sso: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
        itc: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
        obscalc: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
      },
      scenarios: [
        { name: "login as guest", status: "passed", durationSeconds: 12.5 },
        { name: "create a program", status: "passed", durationSeconds: 3.2 },
        { name: "create an observation", status: "passed", durationSeconds: 21.7 },
        { name: "edit and read back", status: "passed", durationSeconds: 8.1 },
      ],
      metrics: metricsFromK6Summary(k6Summary),
      runUrl: "https://github.com/noirlab/odbattr/actions/runs/1234",
    });
    expect(JSON.stringify(s).length).toBeLessThan(2048);
  });

  it("omits empty sections so the record stays readable", () => {
    const s = buildRunSummary(base);
    expect(s).not.toHaveProperty("images");
    expect(s).not.toHaveProperty("scenarios");
    expect(s).not.toHaveProperty("metrics");
    expect(s).not.toHaveProperty("runUrl");
  });
});

describe("summaryPath", () => {
  it("partitions the ledger by suite and month", () => {
    const s = buildRunSummary({
      testid: "load-1234",
      suite: "load",
      environment: "loadtest",
      startedAt: "2026-08-20T08:00:00.000Z",
      endedAt: "2026-08-20T08:41:30.000Z",
    });
    expect(summaryPath(s)).toBe("runs/load/2026-08/load-1234.json");
  });

  it("refuses a summary without a usable timestamp", () => {
    expect(() =>
      summaryPath(
        /** @type {any} */ ({ suite: "load", testid: "x", startedAt: "yesterday" }),
      ),
    ).toThrow(/ISO 8601/);
  });
});
