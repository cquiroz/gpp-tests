import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIGNAL,
  firstParentChain,
  judge,
  nextProbe,
  parseContainerCpu,
  parseSignal,
  prNumber,
  renderBisectTable,
  stepCommands,
  upgradeConflicts,
} from "./bisect.js";

const statsLog = [
  "2026-10-09T21:40:36Z gpp-tests-obscalc-1 3.107GiB / 5.119GiB 12.5%;gpp-tests-odb-1 4.245GiB / 25.6GiB 80%;gpp-tests-postgres-1 465.9MiB / 3.84GiB 1200%;",
  "2026-10-09T21:41:08Z gpp-tests-obscalc-1 3.129GiB / 5.119GiB 10%;gpp-tests-odb-1 4.616GiB / 25.6GiB 60%;gpp-tests-postgres-1 470MiB / 3.84GiB 1300%;",
  "2026-10-09T21:41:40Z gpp-tests-obscalc-1 3.2GiB / 5.119GiB 14%;gpp-tests-odb-1 4.7GiB / 25.6GiB 70%;gpp-tests-postgres-1 471MiB / 3.84GiB 1400%;",
].join("\n");

const summary = {
  metrics: {
    odb_step_overhead: { avg: 900, min: 100, med: 700, max: 4000, "p(90)": 1500, "p(95)": 1800 },
    "odb_step_wait{operation:RecordVisit}": { avg: 10, min: 1, med: 8, max: 90, "p(90)": 30, "p(95)": 40 },
    gpp_execution_steps: { count: 1234, rate: 4.1 },
  },
};

describe("parseSignal", () => {
  it("reads a container CPU signal", () => {
    expect(parseSignal("cpu:postgres med>400")).toEqual({
      spec: "cpu:postgres med>400",
      source: { kind: "cpu", container: "postgres" },
      expression: "med>400",
      stat: "med",
      operator: ">",
      limit: 400,
    });
  });

  it("reads a k6 metric signal, sub-metric selector and spaced expression included", () => {
    const s = parseSignal("odb_step_wait{operation:RecordVisit} p(95) > 1000");
    expect(s.source).toEqual({ kind: "k6", metric: "odb_step_wait{operation:RecordVisit}" });
    expect(s.expression).toBe("p(95) > 1000");
    expect([s.stat, s.operator, s.limit]).toEqual(["p(95)", ">", 1000]);
  });

  it("defaults to the signal that found the 2026-10-07 regression", () => {
    expect(parseSignal(DEFAULT_SIGNAL).source).toEqual({ kind: "cpu", container: "postgres" });
  });

  it.each(["postgres>400", "cpu:postgres", "cpu: med>400", "odb_step_overhead p95>1000", "cpu:postgres rate>1"])(
    "rejects %j",
    (spec) => expect(() => parseSignal(spec)).toThrow(),
  );
});

describe("parseContainerCpu", () => {
  it("groups CPU samples by short container name", () => {
    expect(parseContainerCpu(statsLog)).toEqual({
      obscalc: [12.5, 10, 14],
      odb: [80, 60, 70],
      postgres: [1200, 1300, 1400],
    });
  });

  it("skips blank lines and malformed entries", () => {
    expect(parseContainerCpu("\n2026-10-09T21:40:36Z gpp-tests-odb-1 garbage;\n")).toEqual({});
  });
});

describe("judge", () => {
  it("is SLOW when a CPU signal's expression holds", () => {
    const j = judge(parseSignal("cpu:postgres med>400"), { stats: statsLog, summary });
    expect(j).toMatchObject({ verdict: "SLOW", observed: 1300, samples: 3 });
  });

  it("is FAST when it does not", () => {
    expect(judge(parseSignal("cpu:odb max>100"), { stats: statsLog, summary }).verdict).toBe("FAST");
  });

  it("reads percentiles and averages of CPU samples", () => {
    expect(judge(parseSignal("cpu:postgres avg>0"), { stats: statsLog, summary }).observed).toBe(1300);
    expect(judge(parseSignal("cpu:postgres p(95)>0"), { stats: statsLog, summary }).observed).toBe(1400);
  });

  it("judges a k6 metric through the verdict evaluator", () => {
    expect(judge(parseSignal("odb_step_overhead p(95)>1000"), { stats: statsLog, summary })).toMatchObject({
      verdict: "SLOW",
      observed: 1800,
    });
    expect(judge(parseSignal("odb_step_overhead p(95)>2000"), { stats: statsLog, summary }).verdict).toBe("FAST");
  });

  it("says NO-DATA rather than FAST when the signal recorded nothing", () => {
    expect(judge(parseSignal("cpu:hasura med>1"), { stats: statsLog, summary })).toMatchObject({
      verdict: "NO-DATA",
      reason: "no samples for container hasura",
    });
    expect(judge(parseSignal("odb_ws_lost_events count>0"), { stats: statsLog, summary })).toMatchObject({
      verdict: "NO-DATA",
      reason: "metric absent",
    });
  });
});

describe("prNumber", () => {
  it("reads the PR from a merge commit's title", () => {
    expect(prNumber("Merge pull request #3145 from gemini-hlsw/calibration-estimate")).toBe(3145);
    expect(prNumber("flake.lock: Update")).toBeUndefined();
  });
});

/** @param {string} sha @param {string[]} parents @param {string} [message] */
const c = (sha, parents, message = `commit ${sha}`) => ({ sha, parents, message });

describe("firstParentChain", () => {
  // good ─ m1 ─ m2 ─ bad on main; b1, b2 are branch commits merged by m1 and m2.
  const commits = [
    c("b1", ["good"]),
    c("m1", ["good", "b1"], "Merge pull request #11 from x/a"),
    c("b2", ["good"]),
    c("m2", ["m1", "b2"], "Merge pull request #12 from x/b"),
    c("bad", ["m2"], "Merge pull request #13 from x/c"),
  ];

  it("walks first parents from bad back to good, oldest first, ends included", () => {
    expect(firstParentChain(commits, "good", "bad").map((m) => m.sha)).toEqual(["good", "m1", "m2", "bad"]);
  });

  it("keeps the PR number of each merge", () => {
    expect(firstParentChain(commits, "good", "bad").map((m) => m.pr)).toEqual([undefined, 11, 12, 13]);
  });

  it("throws when good is not a first-parent ancestor of bad", () => {
    expect(() => firstParentChain(commits, "b1", "bad")).toThrow(/first-parent/);
  });

  it("throws when the commit list stops before reaching good", () => {
    expect(() => firstParentChain(commits.slice(3), "good", "bad")).toThrow(/m1/);
  });
});

/** @param {string[]} shas */
const merges = (shas) => shas.map((sha) => ({ sha, title: sha }));

/** The fixtures spell verdicts as plain strings; the state's type is checked in lib/bisect.js. */
const probe = (/** @type {any} */ state) => nextProbe(state);

describe("nextProbe", () => {
  const window = merges(["g", "a", "b", "c", "d", "e", "bad"]);

  it("checks the ends first unless told to trust them", () => {
    expect(probe({ merges: window, steps: {} })).toEqual({ probe: "g" });
    expect(probe({ merges: window, steps: { g: { verdict: "FAST" } } })).toEqual({ probe: "bad" });
  });

  it("halves the window between the last FAST and the first SLOW", () => {
    const steps = { g: { verdict: "FAST" }, bad: { verdict: "SLOW" } };
    expect(probe({ merges: window, steps })).toEqual({ probe: "c" });
    expect(probe({ merges: window, steps: { ...steps, c: { verdict: "SLOW" } } })).toEqual({ probe: "a" });
    expect(probe({ merges: window, steps: { ...steps, c: { verdict: "FAST" } } })).toEqual({ probe: "d" });
  });

  it("assumes the ends when trusted", () => {
    expect(probe({ merges: window, steps: {}, trustEnds: true })).toEqual({ probe: "c" });
  });

  it("names the culprit when the window closes", () => {
    const steps = { g: { verdict: "FAST" }, bad: { verdict: "SLOW" }, c: { verdict: "FAST" }, d: { verdict: "SLOW" } };
    expect(probe({ merges: window, steps })).toEqual({ done: "culprit", culprits: ["d"] });
  });

  it("skips merges without an image and widens the culprit range over them", () => {
    const steps = {
      g: { verdict: "FAST" },
      bad: { verdict: "SLOW" },
      c: { verdict: "FAST" },
      d: { verdict: "UNBUILT" },
    };
    expect(probe({ merges: window, steps })).toEqual({ probe: "e" });
    expect(probe({ merges: window, steps: { ...steps, e: { verdict: "SLOW" } } })).toEqual({
      done: "culprit",
      culprits: ["d", "e"],
    });
  });

  it("stops when an end disagrees with its label", () => {
    expect(probe({ merges: window, steps: { g: { verdict: "SLOW" } } })).toEqual({ done: "good-is-slow" });
    expect(probe({ merges: window, steps: { g: { verdict: "FAST" }, bad: { verdict: "FAST" } } })).toEqual({
      done: "bad-is-fast",
    });
  });

  it("stops when an end has no image or no data", () => {
    expect(probe({ merges: window, steps: { g: { verdict: "UNBUILT" } } })).toEqual({ done: "end-unusable" });
    expect(probe({ merges: window, steps: { g: { verdict: "FAST" }, bad: { verdict: "NO-DATA" } } })).toEqual({
      done: "end-unusable",
    });
  });

  it("treats a NO-DATA step like an unbuilt one", () => {
    const steps = { g: { verdict: "FAST" }, bad: { verdict: "SLOW" }, c: { verdict: "NO-DATA" } };
    expect(probe({ merges: window, steps })).toEqual({ probe: "b" });
  });

  it("flags a SLOW before a FAST", () => {
    const steps = { g: { verdict: "FAST" }, bad: { verdict: "SLOW" }, b: { verdict: "SLOW" }, d: { verdict: "FAST" } };
    expect(probe({ merges: window, steps })).toEqual({ done: "inconsistent", slow: "b", fast: "d" });
  });
});

describe("renderBisectTable", () => {
  it("lists every merge with its PR, verdict and observed value", () => {
    const table = renderBisectTable({
      merges: [
        { sha: "aaaaaaaa1111", pr: 3137, title: "Merge pull request #3137 from x/a" },
        { sha: "bbbbbbbb2222", pr: 3138, title: "Merge pull request #3138 from x/b" },
        { sha: "cccccccc3333", title: "flake.lock: Update" },
      ],
      steps: {
        aaaaaaaa1111: { verdict: "FAST", observed: 4, stamp: "20261009T200906Z" },
        cccccccc3333: { verdict: "SLOW", observed: 1308, stamp: "20261009T214603Z" },
      },
      signal: "cpu:postgres med>400",
    });
    expect(table).toContain("| aaaaaaaa | #3137 | FAST | 4 | 20261009T200906Z |");
    expect(table).toContain("| bbbbbbbb | #3138 | — |  |  |");
    expect(table).toContain("| cccccccc |  | SLOW | 1308 | 20261009T214603Z |");
    expect(table).toContain("cpu:postgres med>400");
  });

  it("adds the seed run when each merge was booted on seeded data", () => {
    const table = renderBisectTable({
      merges: [{ sha: "aaaaaaaa1111", pr: 3137, title: "" }],
      steps: { aaaaaaaa1111: { verdict: "FAST", observed: 4, stamp: "20261010T120000Z", seedStamp: "20261010T110000Z" } },
      signal: "cpu:postgres med>400",
      upgradeFrom: "aaaaaaaa1111",
    });
    expect(table).toContain("| merge | PR | verdict | observed | run | seed |");
    expect(table).toContain("| aaaaaaaa | #3137 | FAST | 4 | 20261010T120000Z | 20261010T110000Z |");
    expect(table).toContain("seeded by aaaaaaaa");
  });
});

describe("stepCommands", () => {
  it("is one run from an empty database by default", () => {
    expect(stepCommands({ sha: "c", awsArgs: ["--minutes", "10"] })).toEqual([
      { role: "step", args: ["c", "--minutes", "10"], env: {} },
    ]);
  });

  it("checks, seeds on the upgrade-from merge, then boots the candidate on the data", () => {
    expect(stepCommands({ sha: "c", upgradeFrom: "g", awsArgs: ["--minutes", "10"] })).toEqual([
      { role: "check", args: ["--check", "c"], env: {} },
      { role: "seed", args: ["--seed", "g", "--minutes", "10"], env: {} },
      { role: "step", args: ["c", "--minutes", "10"], env: { WIPE_DATA: "0" } },
    ]);
  });
});

describe("upgradeConflicts", () => {
  it("accepts ordinary flags and environment", () => {
    expect(upgradeConflicts(["--minutes", "10", "--realistic"], { TARGET_TYPE: "m6i.4xlarge" })).toEqual([]);
  });

  it("refuses what would add data, lose it, or skip the measured stage", () => {
    const problems = upgradeConflicts(["--load", "--terminate", "--no-execution"], { NEW_PAIR: "1", WIPE_DATA: "0" });
    expect(problems.map((p) => p.split(":")[0])).toEqual(["--load", "--terminate", "--no-execution", "NEW_PAIR=1", "WIPE_DATA"]);
  });
});
