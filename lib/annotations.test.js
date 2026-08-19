import { describe, expect, it } from "vitest";
import {
  breachAnnotation,
  runEndAnnotation,
  runStartAnnotation,
} from "./annotations.js";

const run = {
  testid: "load-1234",
  suite: /** @type {const} */ ("load"),
  environment: "loadtest",
  runUrl: "https://github.com/noirlab/odbattr/actions/runs/1234",
};

describe("runStartAnnotation", () => {
  it("carries the run identity in tags — the labels metrics are not allowed to have", () => {
    const a = runStartAnnotation({ ...run, at: "2026-08-20T08:00:00.000Z" });

    expect(a.time).toBe(Date.parse("2026-08-20T08:00:00.000Z"));
    expect(a.timeEnd).toBeUndefined();
    expect(a.tags).toEqual(["odbattr", "load", "loadtest", "load-1234", "start"]);
    expect(a.text).toContain("load-1234");
    expect(a.text).toContain(run.runUrl);
  });

  it("does not require a run URL", () => {
    const a = runStartAnnotation({
      testid: "regression-1",
      suite: "regression",
      environment: "ephemeral",
      at: "2026-08-20T07:00:00.000Z",
    });
    expect(a.text).not.toContain("undefined");
  });
});

describe("runEndAnnotation", () => {
  it("is a region spanning the run, tagged with the outcome", () => {
    const a = runEndAnnotation({
      ...run,
      at: "2026-08-20T08:00:00.000Z",
      endedAt: "2026-08-20T08:41:30.000Z",
      outcome: "fail",
    });

    expect(a.time).toBe(Date.parse("2026-08-20T08:00:00.000Z"));
    expect(a.timeEnd).toBe(Date.parse("2026-08-20T08:41:30.000Z"));
    expect(a.tags).toContain("fail");
    expect(a.text).toMatch(/fail/i);
  });
});

describe("breachAnnotation", () => {
  it("names the breached threshold at the moment of the breach", () => {
    const a = breachAnnotation({
      ...run,
      at: "2026-08-20T08:30:00.000Z",
      breaches: ["odb_write_duration: p(95)<5000", "http_req_failed: rate<0.01"],
    });

    expect(a.tags).toContain("breach");
    expect(a.text).toContain("odb_write_duration: p(95)&lt;5000");
    expect(a.text).toContain("http_req_failed: rate&lt;0.01");
  });
});

describe("all annotations", () => {
  it("reject a timestamp Grafana could not place", () => {
    expect(() =>
      runStartAnnotation({ ...run, at: "last tuesday" }),
    ).toThrow(/timestamp/);
  });
});
