import { describe, expect, it } from "vitest";
import { ENVIRONMENT_OF, SUITES, testId } from "./run-identity.js";

// Spec §7: testid = <suite>-<github_run_id>, e.g. load-1234 / regression-5678.
describe("testId", () => {
  it("joins the suite and the GitHub run id", () => {
    expect(testId({ suite: "load", runId: "1234" })).toBe("load-1234");
    expect(testId({ suite: "regression", runId: "5678" })).toBe(
      "regression-5678",
    );
  });

  it("falls back to a local marker outside CI", () => {
    expect(testId({ suite: "regression" })).toBe("regression-local");
    expect(testId({ suite: "regression", runId: "" })).toBe(
      "regression-local",
    );
  });

  it("rejects an unknown suite (it is a metric label and a directory name)", () => {
    // @ts-expect-error deliberately wrong
    expect(() => testId({ suite: "smoke" })).toThrow(/suite/);
    expect(SUITES).toEqual(["regression", "load"]);
  });

  it("sanitises the run id to label-safe characters", () => {
    expect(testId({ suite: "load", runId: "12/34 attempt:2" })).toBe(
      "load-12-34-attempt-2",
    );
  });
});

describe("ENVIRONMENT_OF", () => {
  it("maps each suite to the environment attribute its traffic carries", () => {
    // Spec §7: test traffic is distinguished in Grafana by `environment`.
    expect(ENVIRONMENT_OF.regression).toBe("ephemeral");
    expect(ENVIRONMENT_OF.load).toBe("loadtest");
  });
});
