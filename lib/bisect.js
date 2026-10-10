/**
 * The odb performance bisect (handoff-generalize-odb-bisect.md): the verdict of one step and
 * the search over a window of lucuma-odb main merges. Pure, so the search can be tested
 * without an AWS run; tools/bisect-odb.js drives it and loadtest/bisect-odb.sh runs a step.
 *
 * A signal is `<source> <k6 threshold expression>`, and the expression holding means SLOW:
 *
 *   cpu:postgres med>400                    a container's CPU % over the run (docker stats)
 *   odb_step_overhead p(95)>1000            any metric in the run's k6 summary export
 *   odb_step_wait{operation:RecordVisit} p(95)>500
 *
 * @typedef {{kind: "cpu", container: string} | {kind: "k6", metric: string}} SignalSource
 * @typedef {{spec: string, source: SignalSource, expression: string, stat: string, operator: string, limit: number}} Signal
 * @typedef {"SLOW"|"FAST"|"NO-DATA"} Judgement
 * @typedef {{verdict: Judgement, observed?: number, samples?: number, reason?: string}} StepJudgement
 * @typedef {{sha: string, pr?: number, title: string}} Merge
 * @typedef {{verdict: Judgement|"UNBUILT", observed?: number, stamp?: string, seedStamp?: string, reason?: string}} Step
 * @typedef {{merges: Merge[], steps: Record<string, Step>, trustEnds?: boolean, upgradeFrom?: string}} BisectState
 * @typedef {{probe: string} | {done: "culprit", culprits: string[]} | {done: "good-is-slow"|"bad-is-fast"|"end-unusable"} | {done: "inconsistent", slow: string, fast: string}} Next
 */
import { compare, parseThresholdExpression } from "./surge-slos.js";
import { evaluate } from "./verdict.js";

/** Postgres CPU found the 2026-10-07 regression: ~1300 % median slow, ~4 % fast. */
export const DEFAULT_SIGNAL = "cpu:postgres med>400";

/** A k6 metric name with an optional `{tag:value,...}` selector, as lib/surge-slos.js accepts. */
const METRIC_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*(\{[^{}\s]+\})?$/;
const CPU_STAT = /^(avg|min|med|max|p\(\d+(?:\.\d+)?\))$/;

/**
 * @param {string} spec
 * @returns {Signal}
 */
export function parseSignal(spec) {
  const match = /^(\S+)\s+(.+)$/.exec(spec.trim());
  if (!match) throw new Error(`a signal is "<source> <expression>", got ${JSON.stringify(spec)}`);
  const sourceText = /** @type {string} */ (match[1]);
  const expression = /** @type {string} */ (match[2]);
  const { stat, operator, limit } = parseThresholdExpression(expression);

  /** @type {SignalSource} */
  let source;
  if (sourceText.startsWith("cpu:")) {
    const container = sourceText.slice(4);
    if (!/^[a-z][a-z0-9-]*$/.test(container)) throw new Error(`signal ${JSON.stringify(spec)}: no container named`);
    if (!CPU_STAT.test(stat)) throw new Error(`signal ${JSON.stringify(spec)}: CPU takes avg, min, med, max or p(N)`);
    source = { kind: "cpu", container };
  } else if (METRIC_NAME.test(sourceText)) {
    source = { kind: "k6", metric: sourceText };
  } else {
    throw new Error(`signal ${JSON.stringify(spec)}: source must be cpu:<container> or a k6 metric name`);
  }
  return { spec: spec.trim(), source, expression: expression.trim(), stat, operator, limit };
}

/**
 * The wizard's docker stats log: one line per sample, a timestamp, then `;`-separated
 * `<container> <mem> / <limit> <cpu>%` entries. Containers are keyed by their compose
 * service (`gpp-tests-postgres-1` → `postgres`).
 *
 * @param {string} text
 * @returns {Record<string, number[]>}
 */
export function parseContainerCpu(text) {
  /** @type {Record<string, number[]>} */
  const cpu = {};
  for (const line of text.split("\n")) {
    const entries = line.trim().replace(/^\S+\s+/, "");
    for (const entry of entries.split(";")) {
      const fields = entry.trim().split(/\s+/);
      if (fields.length < 5) continue;
      const value = parseFloat(/** @type {string} */ (fields[4]));
      if (!Number.isFinite(value)) continue;
      const name = /** @type {string} */ (fields[0]).replace(/^gpp-tests-/, "").replace(/-\d+$/, "");
      (cpu[name] ??= []).push(value);
    }
  }
  return cpu;
}

/**
 * The median is the upper middle sample, as the first bisect-odb.sh read it, so verdicts
 * before and after this module compare.
 *
 * @param {number[]} samples
 * @param {string} stat
 */
function sampleStat(samples, stat) {
  const sorted = [...samples].sort((a, b) => a - b);
  switch (stat) {
    case "avg":
      return sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
    case "min":
      return /** @type {number} */ (sorted[0]);
    case "max":
      return /** @type {number} */ (sorted[sorted.length - 1]);
    case "med":
      return /** @type {number} */ (sorted[Math.floor(sorted.length / 2)]);
    default: {
      const p = Number(/^p\((.+)\)$/.exec(stat)?.[1]);
      return /** @type {number} */ (sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]);
    }
  }
}

/**
 * @param {Signal} signal
 * @param {{stats: string, summary: any}} run the docker stats log text and the parsed k6 summary export
 * @returns {StepJudgement}
 */
export function judge(signal, run) {
  if (signal.source.kind === "cpu") {
    const samples = parseContainerCpu(run.stats)[signal.source.container] ?? [];
    if (samples.length === 0) return { verdict: "NO-DATA", reason: `no samples for container ${signal.source.container}` };
    const observed = sampleStat(samples, signal.stat);
    return { verdict: compare(observed, signal.operator, signal.limit) ? "SLOW" : "FAST", observed, samples: samples.length };
  }
  const metric = signal.source.metric;
  const row = evaluate(signal.spec, metric, signal.expression, run.summary?.metrics?.[metric]);
  if (row.result === "no-data") return { verdict: "NO-DATA", reason: row.reason };
  // The expression describes SLOW, so a "pass" of the threshold is the regression.
  return { verdict: row.result === "pass" ? "SLOW" : "FAST", observed: row.observed };
}

/** @param {string} message */
export function prNumber(message) {
  const match = /^Merge pull request #(\d+)/.exec(message);
  return match ? Number(match[1]) : undefined;
}

/**
 * The merges on main from good to bad, oldest first, both ends included: the first-parent
 * chain, because a lucuma-odb PR lands as a merge commit and only main merges have images.
 *
 * @param {{sha: string, parents: string[], message: string}[]} commits every commit in good..bad (the compare API's list)
 * @param {string} good
 * @param {string} bad
 * @returns {Merge[]}
 */
export function firstParentChain(commits, good, bad) {
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  // The list reaches good through some parent, yet the first-parent walk left it: good was
  // merged in from a branch, so there is no main merge window between the two.
  const listReachesGood = commits.some((commit) => commit.sha === good || commit.parents.includes(good));
  /** @type {Merge[]} */
  const chain = [];
  let sha = bad;
  while (sha !== good) {
    const commit = bySha.get(sha);
    if (!commit) {
      throw new Error(
        listReachesGood
          ? `${good} is not a first-parent ancestor of ${bad} (the walk left the list at ${sha})`
          : `commit ${sha} is missing from the list (the walk from ${bad} did not reach ${good})`,
      );
    }
    const title = commit.message.split("\n")[0] ?? "";
    chain.push({ sha, pr: prNumber(title), title });
    const parent = commit.parents[0];
    if (!parent) throw new Error(`${good} is not a first-parent ancestor of ${bad}`);
    sha = parent;
  }
  chain.push({ sha: good, pr: undefined, title: "" });
  return chain.reverse();
}

/**
 * The next merge to run, or why the search is over. Ends are run first unless trusted, since
 * a FAST good end from an empty database is what hid the 2026-10-07 regression. Merges whose
 * step had no image or no data are skipped and widen the culprit range, as `git bisect skip`.
 *
 * @param {BisectState} state
 * @returns {Next}
 */
export function nextProbe({ merges, steps, trustEnds = false }) {
  const first = /** @type {Merge} */ (merges[0]).sha;
  const last = /** @type {Merge} */ (merges[merges.length - 1]).sha;
  for (const [end, wrong, done] of /** @type {const} */ ([[first, "SLOW", "good-is-slow"], [last, "FAST", "bad-is-fast"]])) {
    const step = steps[end];
    if (!step) {
      if (!trustEnds) return { probe: end };
      continue;
    }
    if (step.verdict === "UNBUILT" || step.verdict === "NO-DATA") return { done: "end-unusable" };
    if (step.verdict === wrong) return { done };
  }

  /** @param {number} i */
  const verdictAt = (i) => {
    if (i === 0) return "FAST";
    if (i === merges.length - 1) return "SLOW";
    return steps[/** @type {Merge} */ (merges[i]).sha]?.verdict;
  };
  let lastFast = 0;
  for (let i = 0; i < merges.length; i++) if (verdictAt(i) === "FAST") lastFast = i;
  let firstSlow = merges.length - 1;
  for (let i = merges.length - 1; i >= 0; i--) if (verdictAt(i) === "SLOW") firstSlow = i;
  if (firstSlow < lastFast) {
    return {
      done: "inconsistent",
      slow: /** @type {Merge} */ (merges[firstSlow]).sha,
      fast: /** @type {Merge} */ (merges[lastFast]).sha,
    };
  }

  const open = [];
  for (let i = lastFast + 1; i < firstSlow; i++) if (verdictAt(i) === undefined) open.push(i);
  if (open.length === 0) {
    return { done: "culprit", culprits: merges.slice(lastFast + 1, firstSlow + 1).map((m) => m.sha) };
  }
  // The open merge nearest the middle of the window, so skipped merges do not skew the halving.
  const middle = (lastFast + firstSlow) / 2;
  const probe = open.reduce((best, i) => (Math.abs(i - middle) < Math.abs(best - middle) ? i : best));
  return { probe: /** @type {Merge} */ (merges[probe]).sha };
}

/**
 * @param {BisectState & {signal: string}} state
 * @returns {string}
 */
export function renderBisectTable({ merges, steps, signal, upgradeFrom }) {
  const seeded = upgradeFrom !== undefined;
  const rows = merges.map((m) => {
    const step = steps[m.sha];
    const observed = step?.observed === undefined ? "" : String(Math.round(step.observed));
    const seed = seeded ? ` ${step?.seedStamp ?? ""} |` : "";
    return `| ${m.sha.slice(0, 8)} | ${m.pr ? `#${m.pr}` : ""} | ${step?.verdict ?? "—"} | ${observed} | ${step?.stamp ?? ""} |${seed}`;
  });
  return [
    `Signal: \`${signal}\` (SLOW when it holds)` +
      (seeded ? `; each merge booted on data seeded by ${upgradeFrom.slice(0, 8)}` : "; each run from an empty database"),
    "",
    `| merge | PR | verdict | observed | run |${seeded ? " seed |" : ""}`,
    `|---|---|---|---|---|${seeded ? "---|" : ""}`,
    ...rows,
  ].join("\n");
}

/**
 * The loadtest/bisect-odb.sh calls one search step makes. Plain, a step is one run on an empty
 * database. With `upgradeFrom`, a regression that needs data: check the candidate has images
 * (a seed is too dear to waste on an unbuilt merge), seed ~20k observations on the upgrade-from
 * merge, then boot the candidate on that data with WIPE_DATA=0 and judge that run.
 *
 * @param {{sha: string, upgradeFrom?: string, awsArgs: string[]}} step
 * @returns {{role: "check"|"seed"|"step", args: string[], env: Record<string, string>}[]}
 */
export function stepCommands({ sha, upgradeFrom, awsArgs }) {
  if (!upgradeFrom) return [{ role: "step", args: [sha, ...awsArgs], env: {} }];
  return [
    { role: "check", args: ["--check", sha], env: {} },
    { role: "seed", args: ["--seed", upgradeFrom, ...awsArgs], env: {} },
    { role: "step", args: [sha, ...awsArgs], env: { WIPE_DATA: "0" } },
  ];
}

/** aws-run.sh flags that would void an upgrade step: the seed adds --load itself. */
const UPGRADE_FORBIDDEN_FLAGS = {
  "--load": "the seed already runs the load profile; the upgrade step must not add data",
  "--terminate": "a terminated pair loses the seeded data before the upgrade step",
  "--regression-only": "the upgrade step needs its execution stage",
  "--no-execution": "the upgrade step needs its execution stage",
};

/**
 * Why `--upgrade-from` cannot run with these aws-run.sh flags and this environment, if it
 * cannot.
 *
 * @param {string[]} awsArgs
 * @param {Record<string, string|undefined>} env
 * @returns {string[]}
 */
export function upgradeConflicts(awsArgs, env) {
  const problems = Object.entries(UPGRADE_FORBIDDEN_FLAGS)
    .filter(([flag]) => awsArgs.includes(flag))
    .map(([flag, why]) => `${flag}: ${why}`);
  if (/^(1|y|true|yes)$/.test(env.NEW_PAIR ?? "")) {
    problems.push("NEW_PAIR=1: its pair is terminated at the end of the seed, and the data with it");
  }
  if (env.WIPE_DATA !== undefined) problems.push("WIPE_DATA: the search sets it per run (1 to seed, 0 to upgrade)");
  return problems;
}
