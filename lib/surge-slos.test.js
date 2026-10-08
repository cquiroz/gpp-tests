import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compare,
  parseSurgeSlos,
  parseThresholdExpression,
  thresholdsFor,
  trendStatsFor,
} from "./surge-slos.js";

const file = JSON.parse(
  readFileSync(new URL("../k6/surge-slos.json", import.meta.url), "utf8"),
);

const minimal = {
  classes: {
    a: { title: "A", slos: [{ name: "x", metric: "m_x", thresholds: ["p(95)<10", "count==0"] }] },
    b: { title: "B", provisional: "why", slos: [{ name: "y", metric: "m_y{scenario:s}", thresholds: ["rate>0.99"] }] },
  },
};

describe("the committed surge SLO file", () => {
  it("parses, with the five classes ticket 020 named", () => {
    const slos = parseSurgeSlos(file);
    expect(Object.keys(slos.classes)).toEqual([
      "execution",
      "proposals",
      "regular",
      "subscriptions",
      "errors",
    ]);
  });

  it("carries ticket 020's execution budget verbatim", () => {
    const t = thresholdsFor(parseSurgeSlos(file), ["execution"]);
    expect(t.odb_step_overhead).toEqual(["p(95)<2000", "p(99)<5000"]);
    expect(t["odb_write_duration{scenario:execution}"]).toEqual(["p(95)<500", "p(99)<2000"]);
    expect(t["odb_read_duration{operation:ExecutionConfig}"]).toEqual(["p(95)<3000"]);
    expect(t["odb_graphql_errors{scenario:execution,status:0}"]).toEqual(["count==0"]);
  });

  it("marks every class provisional, with a reason", () => {
    for (const cls of Object.values(parseSurgeSlos(file).classes)) {
      expect(cls.provisional).toMatch(/\S/);
    }
  });
});

describe("parseSurgeSlos", () => {
  it("accepts a minimal file", () => {
    expect(parseSurgeSlos(minimal).classes.a?.slos[0]?.metric).toBe("m_x");
  });

  it("rejects an expression k6 would not accept", () => {
    const bad = structuredClone(minimal);
    bad.classes.a.slos = [{ name: "x", metric: "m_x", thresholds: ["p95 < 10"] }];
    expect(() => parseSurgeSlos(bad)).toThrow(/not a k6 threshold expression/);
  });

  it("rejects a class without SLOs, and an SLO without a metric", () => {
    const empty = structuredClone(minimal);
    empty.classes.a.slos = [];
    expect(() => parseSurgeSlos(empty)).toThrow(/at least one SLO/);
    const noMetric = structuredClone(minimal);
    // @ts-expect-error deliberately malformed
    noMetric.classes.a.slos = [{ name: "x", metric: 7, thresholds: ["p(95)<10"] }];
    expect(() => parseSurgeSlos(noMetric)).toThrow(/metric must be a k6 metric name/);
  });

  it("refuses a metric claimed by two classes — k6 keeps one threshold list per metric", () => {
    const twice = structuredClone(minimal);
    twice.classes.b.slos = [{ name: "y", metric: "m_x", thresholds: ["rate>0.99"] }];
    expect(() => parseSurgeSlos(twice)).toThrow(/one class must own it/);
  });
});

describe("thresholdsFor", () => {
  it("returns the named classes' expressions verbatim, keyed by metric", () => {
    expect(thresholdsFor(parseSurgeSlos(minimal), ["a", "b"])).toEqual({
      m_x: ["p(95)<10", "count==0"],
      "m_y{scenario:s}": ["rate>0.99"],
    });
  });

  it("names the metrics without a limit when not armed, so the summary still carries them", () => {
    expect(thresholdsFor(parseSurgeSlos(minimal), ["a"], { arm: false })).toEqual({
      m_x: ["p(95)>=0", "count>=0"],
    });
  });

  it("fails on an unknown class rather than arming nothing", () => {
    expect(() => thresholdsFor(parseSurgeSlos(minimal), ["c"])).toThrow(/not in the file/);
  });
});

describe("trendStatsFor", () => {
  it("adds the percentiles the classes threshold on to k6's defaults, once each", () => {
    expect(trendStatsFor(parseSurgeSlos(file), ["execution", "errors"])).toEqual([
      "avg", "min", "med", "max", "p(90)", "p(95)", "p(99)",
    ]);
    expect(trendStatsFor(parseSurgeSlos(minimal), ["b"])).toEqual(["avg", "min", "med", "max", "p(90)", "p(95)"]);
  });
});

describe("threshold expressions", () => {
  it("parse the stat, operator and limit", () => {
    expect(parseThresholdExpression("p(99.9) <= 5000")).toEqual({ stat: "p(99.9)", operator: "<=", limit: 5000 });
    expect(parseThresholdExpression("count==0")).toEqual({ stat: "count", operator: "==", limit: 0 });
  });

  it("compare the way k6 does", () => {
    expect(compare(1999, "<", 2000)).toBe(true);
    expect(compare(2000, "<", 2000)).toBe(false);
    expect(compare(0, "==", 0)).toBe(true);
    expect(compare(0.995, ">", 0.99)).toBe(true);
    expect(compare(1, "===", 1)).toBe(true);
    expect(compare(1, "!=", 1)).toBe(false);
  });
});
