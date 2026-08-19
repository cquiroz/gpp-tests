import { describe, expect, it } from "vitest";
import { ALLOWED_TAG_KEYS, metricTags } from "./tags.js";

// Spec §7 / ticket 007: metric labels are capped at operation, scenario, suite and status.
// The free Grafana Cloud tier allows 10k active series; a URL or an id in a label blows
// that budget, and a blown budget silently drops the org's *production* metrics too.
describe("metricTags", () => {
  it("passes the four allowed labels through", () => {
    expect(
      metricTags({
        suite: "load",
        scenario: "create-observation",
        operation: "CreateObservation",
        status: "ok",
      }),
    ).toEqual({
      suite: "load",
      scenario: "create-observation",
      operation: "CreateObservation",
      status: "ok",
    });
  });

  it("keeps the allow-list to exactly the four documented keys", () => {
    expect([...ALLOWED_TAG_KEYS].sort()).toEqual([
      "operation",
      "scenario",
      "status",
      "suite",
    ]);
  });

  it("throws on an unbudgeted label instead of quietly shipping it", () => {
    expect(() => metricTags({ suite: "load", url: "/odb" })).toThrow(/url/);
    expect(() => metricTags({ programId: "p-100" })).toThrow(
      /not in the label budget/,
    );
  });

  it("rejects testid unless the escape hatch is explicitly opened", () => {
    // Run identity lives on Grafana annotations, not on every series.
    expect(() => metricTags({ suite: "load", testid: "load-1" })).toThrow(
      /testid/,
    );
    expect(
      metricTags({ suite: "load", testid: "load-1" }, { allowTestid: true }),
    ).toEqual({ suite: "load", testid: "load-1" });
  });

  it("drops undefined values so k6 does not emit empty labels", () => {
    expect(metricTags({ suite: "load", status: undefined })).toEqual({
      suite: "load",
    });
  });

  it("stringifies values (k6 requires string tag values)", () => {
    expect(metricTags({ status: 200 })).toEqual({ status: "200" });
  });
});
