#!/usr/bin/env node
/**
 * Find the lucuma-odb merge that made the odb slower, one AWS step at a time
 * (handoff-generalize-odb-bisect.md).
 *
 *   node tools/bisect-odb.js --good=3137 --bad=3152                  # PR numbers or commit shas
 *   node tools/bisect-odb.js --good=3137 --bad=3152 --signal="odb_step_overhead p(95)>1000"
 *   node tools/bisect-odb.js --good=3137 --bad=3152 --dry-run        # the window, no AWS
 *   node tools/bisect-odb.js --good=3137 --bad=3152 -- --load        # flags after -- go to aws-run.sh
 *   node tools/bisect-odb.js --resume=out/bisect-odb-<stamp>.json   # carry on after a stop
 *   node tools/bisect-odb.js --judge [--signal=…] [<stamp>]         # read one collected run
 *
 * The window is the first-parent chain of main merges from good to bad, read from GitHub's
 * compare API (paginated, so no 100-run limit). Each step is `loadtest/bisect-odb.sh <sha>`:
 * about 25 minutes and $0.60, from an empty database unless WIPE_DATA=0. The ends run first,
 * because an end that does not reproduce from empty is the first thing to learn (it hid the
 * 2026-10-07 regression); `--trust-ends` skips them. A merge with no image (CI cancelled) or
 * whose run recorded no signal is skipped, and the culprit range widens over it.
 *
 * The signal (lib/bisect.js) is `<source> <expression>`, SLOW when the expression holds:
 * `cpu:postgres med>400` (the default), `cpu:odb avg>200`, or any metric in the k6 summary
 * export such as `odb_step_overhead p(95)>1000`.
 *
 * State is saved to out/bisect-odb-<stamp>.json after every step. When a step fails without
 * collecting a run (no capacity, a broken stack), the search stops there and prints the
 * --resume command; nothing is judged from a run that did not happen.
 *
 * Exit code: 0 when a culprit is named, 1 when the search stopped on a finding about the ends
 * or an inconsistency, 2 on bad input or a failed step.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import {
  DEFAULT_SIGNAL,
  firstParentChain,
  judge,
  nextProbe,
  parseContainerCpu,
  parseSignal,
  prNumber,
  renderBisectTable,
} from "../lib/bisect.js";

const REPO = "gemini-hlsw/lucuma-odb";
/** loadtest/bisect-odb.sh exits with this when the merge has no image in the registry. */
const EXIT_UNBUILT = 3;

const argv = process.argv.slice(2);
const dashDash = argv.indexOf("--");
const own = dashDash === -1 ? argv : argv.slice(0, dashDash);
const awsArgs = dashDash === -1 ? [] : argv.slice(dashDash + 1);
const args = new Map(
  own
    .filter((a) => a.startsWith("--"))
    .map((arg) => {
      const [key, ...rest] = arg.replace(/^--/, "").split("=");
      return [/** @type {string} */ (key), rest.length ? rest.join("=") : "true"];
    }),
);
const positional = own.filter((a) => !a.startsWith("--"));

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(message);
  process.exit(2);
}

/** @param {string} command @param {string[]} commandArgs */
function capture(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) fail(`${command} ${commandArgs.join(" ")} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

/** @param {string} ref a PR number or a commit sha */
function resolveSha(ref) {
  if (!/^\d+$/.test(ref)) return ref;
  const sha = capture("gh", ["pr", "view", ref, "--repo", REPO, "--json", "mergeCommit", "--jq", ".mergeCommit.oid"]);
  if (!sha) fail(`PR #${ref} has no merge commit`);
  return sha;
}

/** @param {string} good @param {string} bad */
function mergeWindow(good, bad) {
  const lines = capture("gh", [
    "api",
    "--paginate",
    `repos/${REPO}/compare/${good}...${bad}?per_page=100`,
    "--jq",
    ".commits[] | {sha, parents: [.parents[].sha], message: .commit.message}",
  ]);
  const commits = lines ? lines.split("\n").map((line) => JSON.parse(line)) : [];
  const merges = firstParentChain(commits, good, bad);
  // The compare list starts after good, so its title needs a lookup of its own.
  const goodEnd = /** @type {import("../lib/bisect.js").Merge} */ (merges[0]);
  goodEnd.title = capture("gh", ["api", `repos/${REPO}/commits/${good}`, "--jq", '.commit.message | split("\\n")[0]']);
  goodEnd.pr = prNumber(goodEnd.title);
  return merges;
}

/**
 * The newest execution run collected since `since` (ms), paired by its stamp: the k6
 * summary and the docker stats log the wizard saved under the same name.
 *
 * @param {number} [since]
 * @param {string} [stamp] a specific run instead of the newest
 */
function collectedRun(since = 0, stamp) {
  const summaries = readdirSync("out")
    .map((name) => /^k6-aws-execution-(\d{8}T\d{6}Z)\.json$/.exec(name))
    .filter((m) => m !== null)
    .map((m) => ({ stamp: /** @type {string} */ (m[1]), path: `out/${m[0]}` }))
    .filter((r) => (stamp ? r.stamp === stamp : statSync(r.path).mtimeMs >= since))
    .sort((a, b) => b.stamp.localeCompare(a.stamp));
  const run = summaries[0];
  if (!run) return undefined;
  const statsPath = `out/odb-stats-aws-${run.stamp}.log`;
  return {
    stamp: run.stamp,
    summaryPath: run.path,
    statsPath,
    summary: JSON.parse(readFileSync(run.path, "utf8")),
    stats: existsSync(statsPath) ? readFileSync(statsPath, "utf8") : "",
  };
}

/**
 * One line with the signal's verdict, then the context a reader wants beside it whatever the
 * signal: the three CPU medians and the execution numbers.
 *
 * @param {import("../lib/bisect.js").Signal} signal
 * @param {NonNullable<ReturnType<typeof collectedRun>>} run
 */
function describeRun(signal, run) {
  const judgement = judge(signal, run);
  const cpu = parseContainerCpu(run.stats);
  /** @param {string} name */
  const med = (name) => {
    const s = [...(cpu[name] ?? [])].sort((a, b) => a - b);
    return s.length ? `${Math.round(/** @type {number} */ (s[Math.floor(s.length / 2)]))}%` : "—";
  };
  const m = run.summary.metrics ?? {};
  /** @param {string} k */
  const p95 = (k) => (typeof m[k]?.["p(95)"] === "number" ? `${m[k]["p(95)"].toFixed(0)} ms` : "—");
  const observed = judgement.observed === undefined ? judgement.reason : Math.round(judgement.observed * 10) / 10;
  return {
    judgement,
    text: [
      `${judgement.verdict}  ${signal.spec} → ${observed}`,
      `  cpu medians: postgres ${med("postgres")} · odb ${med("odb")} · obscalc ${med("obscalc")} (${cpu.postgres?.length ?? 0} samples)` +
        ` · step overhead p95 ${p95("odb_step_overhead")} · RecordVisit p95 ${p95("odb_step_wait{operation:RecordVisit}")}` +
        ` · steps ${m.gpp_execution_steps?.count ?? "—"}`,
      `  ${run.statsPath}`,
      `  ${run.summaryPath}`,
    ].join("\n"),
  };
}

const signalSpec = args.get("signal") ?? process.env.BISECT_SIGNAL ?? DEFAULT_SIGNAL;

if (args.has("judge")) {
  let signal;
  try {
    signal = parseSignal(signalSpec);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const run = collectedRun(0, positional[0]);
  if (!run) fail(positional[0] ? `no execution run ${positional[0]} in out/` : "no execution run collected yet");
  const { judgement, text } = describeRun(/** @type {any} */ (signal), /** @type {any} */ (run));
  console.log(text);
  process.exit(judgement.verdict === "NO-DATA" ? 2 : 0);
}

/** @type {{signal: string, good: string, bad: string, trustEnds: boolean, awsArgs: string[], merges: import("../lib/bisect.js").Merge[], steps: Record<string, import("../lib/bisect.js").Step>}} */
let state;
let statePath;
if (args.has("resume")) {
  statePath = /** @type {string} */ (args.get("resume"));
  state = JSON.parse(readFileSync(statePath, "utf8"));
  if (args.has("signal")) fail("--signal cannot change on --resume: the steps so far were judged by the saved one");
} else {
  const goodRef = args.get("good");
  const badRef = args.get("bad");
  if (!goodRef || !badRef) {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(2, 29).join("\n").replace(/^ \* ?/gm, ""));
    process.exit(2);
  }
  try {
    parseSignal(signalSpec);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const good = resolveSha(goodRef);
  const bad = resolveSha(badRef);
  let merges;
  try {
    merges = mergeWindow(good, bad);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  state = { signal: signalSpec, good, bad, trustEnds: args.has("trust-ends"), awsArgs, merges, steps: {} };
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  statePath = `out/bisect-odb-${stamp}.json`;
}

const signal = parseSignal(state.signal);
const save = () => {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  writeFileSync(statePath.replace(/\.json$/, ".md"), `${renderBisectTable(state)}\n`);
};

const inner = state.merges.length - 2;
const ends = state.trustEnds ? 0 : 2;
console.log(
  `window: ${state.merges.length} merges (${inner} between the ends), about ${Math.ceil(Math.log2(inner + 1)) + ends} steps · signal ${state.signal}`,
);
for (const m of state.merges) console.log(`  ${m.sha.slice(0, 8)} ${m.pr ? `#${m.pr}` : "     "} ${m.title}`);

if (args.has("dry-run")) {
  console.log(`\nfirst step: loadtest/bisect-odb.sh ${"probe" in nextProbe(state) ? /** @type {any} */ (nextProbe(state)).probe : "—"} ${state.awsArgs.join(" ")}`);
  process.exit(0);
}
save();
console.log(`state: ${statePath}\n`);

for (;;) {
  const next = nextProbe(state);
  if ("done" in next) {
    save();
    console.log(`\n${renderBisectTable(state)}\n`);
    const short = (/** @type {string} */ sha) => {
      const m = state.merges.find((x) => x.sha === sha);
      return `${sha.slice(0, 8)}${m?.pr ? ` (#${m.pr})` : ""} ${m?.title ?? ""}`;
    };
    switch (next.done) {
      case "culprit":
        console.log(next.culprits.length === 1 ? "culprit:" : "culprit is one of (merges between were skipped):");
        for (const sha of next.culprits) console.log(`  ${short(sha)}`);
        process.exit(0);
      case "good-is-slow":
        console.log("the good end is SLOW on this signal: the regression is older, or needs no data here");
        break;
      case "bad-is-fast":
        console.log(
          "the bad end is FAST on this signal: from an empty database the regression may need data " +
            "(see research/odb-ask-smart-gcal-full-scans.md), or the threshold is wrong",
        );
        break;
      case "end-unusable":
        console.log("an end had no image or recorded no signal; pick another end");
        break;
      case "inconsistent":
        console.log(`inconsistent: ${short(next.slow)} is SLOW but the later ${short(next.fast)} is FAST (noise, or two changes)`);
        break;
    }
    process.exit(1);
  }

  const sha = next.probe;
  const merge = state.merges.find((m) => m.sha === sha);
  console.log(`\n=== step: ${sha.slice(0, 8)}${merge?.pr ? ` #${merge.pr}` : ""} ${merge?.title ?? ""}`);
  const started = Date.now();
  const step = spawnSync("loadtest/bisect-odb.sh", [sha, ...state.awsArgs], {
    stdio: "inherit",
    env: { ...process.env, BISECT_SIGNAL: state.signal },
  });
  if (step.status === EXIT_UNBUILT) {
    state.steps[sha] = { verdict: "UNBUILT" };
    save();
    continue;
  }
  const run = collectedRun(started);
  if (!run) {
    save();
    console.error(
      `\nthe step for ${sha.slice(0, 8)} collected no execution run (exit ${step.status}); nothing judged.\n` +
        `fix the cause, then: node tools/bisect-odb.js --resume=${statePath}`,
    );
    process.exit(2);
  }
  const { judgement } = describeRun(signal, run);
  state.steps[sha] = {
    verdict: judgement.verdict,
    stamp: run.stamp,
    ...(judgement.observed === undefined ? {} : { observed: judgement.observed }),
    ...(judgement.reason ? { reason: judgement.reason } : {}),
  };
  save();
}
