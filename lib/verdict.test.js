import { describe, expect, it } from "vitest";
import { parseSurgeSlos } from "./surge-slos.js";
import { renderVerdictMarkdown, surgeVerdict } from "./verdict.js";

const slos = parseSurgeSlos({
  classes: {
    execution: {
      title: "Execution",
      provisional: "until Observe developers see numbers",
      slos: [
        { name: "step overhead", metric: "odb_step_overhead", thresholds: ["p(95)<2000", "p(99)<5000"] },
        { name: "timeouts", metric: "odb_graphql_errors{scenario:execution,status:0}", thresholds: ["count==0"] },
      ],
    },
    subscriptions: {
      title: "Subscriptions",
      slos: [{ name: "lost events", metric: "odb_ws_lost_events", thresholds: ["count==0"] }],
    },
    errors: {
      title: "Errors",
      slos: [{ name: "checks", metric: "checks", thresholds: ["rate>0.99"] }],
    },
  },
});

/** The `--summary-export` shape: values flat on the metric, a Rate's rate under `value`. */
const exportSummary = {
  metrics: {
    odb_step_overhead: { avg: 355, min: 115, med: 283, max: 2522, "p(90)": 529, "p(95)": 1259.8, "p(99)": 1930 },
    "odb_graphql_errors{scenario:execution,status:0}": { count: 0, rate: 0 },
    checks: { passes: 4819, fails: 0, value: 1 },
  },
};

describe("surgeVerdict", () => {
  it("passes a run inside every limit and lists the classes it did not exercise", () => {
    const v = surgeVerdict(slos, exportSummary);
    expect(v.outcome).toBe("pass");
    expect(v.breaches).toEqual([]);
    expect(v.classes.map((c) => [c.key, c.outcome])).toEqual([
      ["execution", "pass"],
      ["subscriptions", "not-exercised"],
      ["errors", "pass"],
    ]);
    const overhead = v.classes[0]?.rows[0];
    expect(overhead).toMatchObject({ stat: "p(95)", observed: 1259.8, unit: "ms", result: "pass" });
  });

  it("fails the class and the run on a breach, in the annotation's `metric: expression` shape", () => {
    const slow = structuredClone(exportSummary);
    slow.metrics.odb_step_overhead["p(95)"] = 2400;
    slow.metrics.checks = { passes: 90, fails: 10, value: 0.9 };
    const v = surgeVerdict(slos, slow);
    expect(v.outcome).toBe("fail");
    expect(v.breaches).toEqual(["checks: rate>0.99", "odb_step_overhead: p(95)<2000"]);
    expect(v.classes.find((c) => c.key === "errors")?.rows[0]).toMatchObject({ observed: 0.9, unit: "rate", result: "fail" });
  });

  it("calls an all-zero trend no data instead of a pass — k6 exports an unsampled metric that way", () => {
    const unsampled = structuredClone(exportSummary);
    unsampled.metrics.odb_step_overhead = { avg: 0, min: 0, med: 0, max: 0, "p(90)": 0, "p(95)": 0, "p(99)": 0 };
    const v = surgeVerdict(slos, unsampled);
    expect(v.classes[0]?.rows[0]).toMatchObject({ result: "no-data", reason: "no samples" });
    // The timeouts counter still has a genuine zero, so the class counts as exercised.
    expect(v.classes[0]?.outcome).toBe("pass");
  });

  it("says when the export lacks the stat a threshold needs, rather than calling it no data", () => {
    const v = surgeVerdict(slos, {
      metrics: { odb_step_overhead: { avg: 300, "p(95)": 1200 } },
    });
    const [p95, p99] = v.classes[0]?.rows ?? [];
    expect(p95).toMatchObject({ result: "pass" });
    expect(p99).toMatchObject({ result: "no-data", reason: "stat not exported" });
    expect(renderVerdictMarkdown(v)).toContain("| ⚪ stat not exported |");
    expect(v.classes.find((c) => c.key === "subscriptions")?.rows[0]).toMatchObject({ reason: "metric absent" });
  });

  it("treats a Rate with no checks as no data, and a Counter at zero as a real zero", () => {
    const v = surgeVerdict(slos, {
      metrics: { checks: { passes: 0, fails: 0, value: 0 }, odb_ws_lost_events: { count: 0, rate: 0 } },
    });
    expect(v.classes.find((c) => c.key === "errors")?.outcome).toBe("not-exercised");
    expect(v.classes.find((c) => c.key === "subscriptions")?.rows[0]).toMatchObject({ observed: 0, result: "pass" });
  });

  it("reads the handleSummary shape too (nested values, a Rate's rate under `rate`)", () => {
    const v = surgeVerdict(slos, {
      metrics: {
        odb_step_overhead: { values: { "p(95)": 100, "p(99)": 200, avg: 90 } },
        checks: { values: { passes: 10, fails: 0, rate: 1 } },
      },
    });
    expect(v.outcome).toBe("pass");
    expect(v.classes.find((c) => c.key === "errors")?.rows[0]?.observed).toBe(1);
  });

  it("reports NOT EXERCISED when the summary has none of the asked classes", () => {
    const v = surgeVerdict(slos, { metrics: {} }, { classes: ["subscriptions"] });
    expect(v.outcome).toBe("not-exercised");
    expect(v.classes).toHaveLength(1);
  });

  it("rejects an unknown class filter", () => {
    expect(() => surgeVerdict(slos, exportSummary, { classes: ["proposals"] })).toThrow(/not in the file/);
  });
});

describe("renderVerdictMarkdown", () => {
  it("writes one table per exercised class and one line for the rest", () => {
    const md = renderVerdictMarkdown(surgeVerdict(slos, exportSummary), { source: "out/x.json" });
    expect(md).toContain("## Surge verdict: ✅ PASS");
    expect(md).toContain("run: `out/x.json`");
    expect(md).toContain("### Execution: ✅ PASS");
    expect(md).toContain("| step overhead | `odb_step_overhead` | p(95) < 2000 ms | 1260 ms | ✅ pass |");
    expect(md).toContain("| timeouts | `odb_graphql_errors{scenario:execution,status:0}` | count = 0 | 0 | ✅ pass |");
    expect(md).toContain("| checks | `checks` | rate > 99 % | 100 % | ✅ pass |");
    expect(md).toContain("_Provisional: until Observe developers see numbers_");
    expect(md).toContain("Not exercised in this run: Subscriptions.");
    expect(md).not.toContain("### Subscriptions");
  });

  it("marks a breach in bold and the headline FAIL", () => {
    const slow = structuredClone(exportSummary);
    slow.metrics.odb_step_overhead["p(99)"] = 6100;
    const md = renderVerdictMarkdown(surgeVerdict(slos, slow));
    expect(md).toContain("## Surge verdict: ❌ FAIL");
    expect(md).toContain("| p(99) < 5000 ms | 6100 ms | ❌ **FAIL** |");
  });
});
