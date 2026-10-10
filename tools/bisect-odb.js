#!/usr/bin/env node
/**
 * Find the lucuma-odb merge that made the odb slower, one AWS step at a time.
 * The guide is loadtest/BISECT.md.
 *
 *   node tools/bisect-odb.js --good=3137 --bad=3152 --dry-run        # the window and cost, no AWS
 *   node tools/bisect-odb.js --good=3137 --bad=3152                  # PR numbers or commit shas
 *   node tools/bisect-odb.js --good=3137 --bad=3152 --upgrade-from   # each merge on seeded data
 *   node tools/bisect-odb.js --good=3137 --bad=3152 --signal="odb_step_overhead p(95)>1000"
 *   node tools/bisect-odb.js --good=3137 --bad=3152 -- --minutes 10  # flags after -- go to aws-run.sh
 *   node tools/bisect-odb.js --resume=out/bisect-odb-<stamp>.json   # carry on after a stop
 *   node tools/bisect-odb.js --judge [--signal=…] [<stamp>]         # judge one collected run
 *
 * The window is the first-parent chain of main merges from good to bad (GitHub's compare API,
 * paginated). The ends run first unless --trust-ends, then the window halves. A merge with no
 * image or no signal is skipped, and the culprit range widens over it.
 *
 * A step is loadtest/bisect-odb.sh <sha>: one run from an empty database, about 25 minutes and
 * $0.60. With --upgrade-from[=<PR|sha>] (default: the good end), each step checks the
 * merge's images, seeds ~20k observations on the upgrade-from merge (bisect-odb.sh --seed),
 * then boots the merge on that data with WIPE_DATA=0 and judges it: about 95 minutes and
 * $2.10, for regressions that need data, as the 2026-10-07 one did.
 *
 * The signal (lib/bisect.js) is `<source> <expression>`, SLOW when the expression holds:
 * `cpu:postgres med>400` (the default, also BISECT_SIGNAL), `cpu:<container> avg|min|med|max|p(N)…`,
 * or any metric in the k6 summary export, such as `odb_step_overhead p(95)>1000`.
 *
 * State and a Markdown table go to out/bisect-odb-<stamp>.{json,md} after every step. A step
 * that collects no run (no capacity, a broken boot, an expired HEROKU_API_KEY) stops the
 * search with the --resume command; nothing is judged from it.
 *
 * Exit code: 0 when a culprit is named; 1 when the search stopped on a finding (good end SLOW,
 * bad end FAST, an end unusable, an inconsistency); 2 on bad input or a failed step.
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
  stepCommands,
  upgradeConflicts,
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
 * The stamp of the load summary a seed collected since `since` (ms): out/k6-aws-<stamp>.json.
 *
 * @param {number} since
 */
function seededRun(since) {
  return readdirSync("out")
    .map((name) => /^k6-aws-(\d{8}T\d{6}Z)\.json$/.exec(name))
    .filter((m) => m !== null && statSync(`out/${m[0]}`).mtimeMs >= since)
    .map((m) => /** @type {string} */ (/** @type {RegExpExecArray} */ (m)[1]))
    .sort()
    .pop();
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

/** @type {{signal: string, good: string, bad: string, trustEnds: boolean, upgradeFrom?: string, awsArgs: string[], merges: import("../lib/bisect.js").Merge[], steps: Record<string, import("../lib/bisect.js").Step>}} */
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
    const source = readFileSync(new URL(import.meta.url), "utf8");
    console.log(source.slice(source.indexOf("/**") + 4, source.indexOf(" */")).replace(/^ \* ?/gm, ""));
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
  /** @type {string|undefined} */
  let upgradeFrom;
  if (args.has("upgrade-from")) {
    const conflicts = upgradeConflicts(awsArgs, process.env);
    if (conflicts.length > 0) fail(`--upgrade-from cannot run with:\n  ${conflicts.join("\n  ")}`);
    const seedRef = /** @type {string} */ (args.get("upgrade-from"));
    upgradeFrom = seedRef === "true" ? good : resolveSha(seedRef);
    // Migrations only go forward: every merge in the window must be at or after the seed.
    const status = capture("gh", ["api", `repos/${REPO}/compare/${upgradeFrom}...${good}`, "--jq", ".status"]);
    if (status !== "ahead" && status !== "identical") {
      fail(`--upgrade-from ${seedRef} must be at or before the good end (compare says ${status})`);
    }
  }
  state = {
    signal: signalSpec,
    good,
    bad,
    trustEnds: args.has("trust-ends"),
    ...(upgradeFrom ? { upgradeFrom } : {}),
    awsArgs,
    merges,
    steps: {},
  };
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  statePath = `out/bisect-odb-${stamp}.json`;
}

const signal = parseSignal(state.signal);
const save = () => {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  writeFileSync(statePath.replace(/\.json$/, ".md"), `${renderBisectTable(state)}\n`);
};

const inner = state.merges.length - 2;
const steps = Math.ceil(Math.log2(inner + 1)) + (state.trustEnds ? 0 : 2);
const [stepMinutes, stepDollars] = state.upgradeFrom ? [95, 2.1] : [25, 0.6];
console.log(
  `window: ${state.merges.length} merges (${inner} between the ends) · signal ${state.signal}` +
    (state.upgradeFrom ? ` · upgrade from ${state.upgradeFrom.slice(0, 8)}` : " · from an empty database"),
);
console.log(
  `about ${steps} steps × ${stepMinutes} min ≈ ${((steps * stepMinutes) / 60).toFixed(1)} h, $${(steps * stepDollars).toFixed(2)}`,
);
for (const m of state.merges) console.log(`  ${m.sha.slice(0, 8)} ${m.pr ? `#${m.pr}` : "     "} ${m.title}`);

if (args.has("dry-run")) {
  const next = nextProbe(state);
  if ("probe" in next) {
    console.log("\nfirst step:");
    for (const command of stepCommands({ sha: next.probe, upgradeFrom: state.upgradeFrom, awsArgs: state.awsArgs })) {
      const env = Object.entries(command.env).map(([k, v]) => `${k}=${v} `).join("");
      console.log(`  ${env}loadtest/bisect-odb.sh ${command.args.join(" ")}`);
    }
  }
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
  const stop = (/** @type {string} */ why) => {
    save();
    console.error(`\n${why}; nothing judged.\nfix the cause, then: node tools/bisect-odb.js --resume=${statePath}`);
    process.exit(2);
  };
  /** @type {string|undefined} */
  let seedStamp;
  /** @type {ReturnType<typeof collectedRun>} */
  let run;
  let unbuilt = false;
  for (const command of stepCommands({ sha, upgradeFrom: state.upgradeFrom, awsArgs: state.awsArgs })) {
    const started = Date.now();
    const result = spawnSync("loadtest/bisect-odb.sh", command.args, {
      stdio: "inherit",
      env: { ...process.env, ...command.env, BISECT_SIGNAL: state.signal },
    });
    if (command.role === "seed") {
      if (result.status === EXIT_UNBUILT) fail(`the upgrade-from merge ${state.upgradeFrom} has no image`);
      seedStamp = seededRun(started);
      if (result.status !== 0 || !seedStamp) stop(`the seed for ${sha.slice(0, 8)} did not finish (exit ${result.status})`);
      continue;
    }
    if (result.status === EXIT_UNBUILT) {
      unbuilt = true;
      break;
    }
    if (command.role === "check") {
      if (result.status !== 0) stop(`checking the images of ${sha.slice(0, 8)} failed (exit ${result.status})`);
      continue;
    }
    run = collectedRun(started);
    if (!run) stop(`the step for ${sha.slice(0, 8)} collected no execution run (exit ${result.status})`);
  }
  if (unbuilt || !run) {
    state.steps[sha] = { verdict: "UNBUILT" };
    save();
    continue;
  }
  const { judgement } = describeRun(signal, run);
  state.steps[sha] = {
    verdict: judgement.verdict,
    stamp: run.stamp,
    ...(seedStamp ? { seedStamp } : {}),
    ...(judgement.observed === undefined ? {} : { observed: judgement.observed }),
    ...(judgement.reason ? { reason: judgement.reason } : {}),
  };
  save();
}
