# Bisecting an odb performance regression

When an odb build is slower than an earlier one, `tools/bisect-odb.js` finds the lucuma-odb
merge that did it. It runs on the AWS load target, one step per merge, and halves the window
between a known-good and a known-bad merge until one merge is left. It found the 2026-10-07
regression: #3145 made every observation recompute after an upgrade, and each recompute
paid for smart-GCAL full table scans (`research/odb-ask-smart-gcal-full-scans.md`).

Only someone with the AWS profile can run it, because every step boots the shared pair
(see the `noirlab-aws` skill). An agent session can build the commands and read the results,
but the auto-mode classifier refuses to launch the runs.

## Quick start

```sh
# 1. Look at the window first: no AWS, no cost.
node tools/bisect-odb.js --good=3137 --bad=3152 --dry-run

# 2. Search it from an empty database (about 25 minutes and $0.60 a step).
node tools/bisect-odb.js --good=3137 --bad=3152

# 3. If the bad end reads FAST from empty, the regression needs data: search again with
#    every merge booted on a seeded database (about 95 minutes and $2.10 a step).
node tools/bisect-odb.js --good=3137 --bad=3152 --upgrade-from --trust-ends
```

`--good` and `--bad` take a lucuma-odb PR number (resolved to its merge commit) or a commit
sha on main. Both must have an image, and good must be an ancestor of bad on main.

Before a run, the environment needs `HEROKU_API_KEY`, exported in your shell (it is not in
`.env`). The wizard also needs the `K6_PROMETHEUS_RW_*` values from `.env` (direnv loads them)
and the AWS profile `gpp-tests` with the Session Manager plugin. `aws-run.sh` checks these up
front.

## How a search runs

1. **The window.** GitHub's compare API lists every commit between good and bad, page by page,
   so there is no limit on the window's size. The tool keeps only the first-parent chain:
   lucuma-odb lands each PR as a merge commit, and only main merges have images (CI tags web
   and obscalc with the commit sha in `registry.heroku.com/lucuma-postgres-odb-dev`).
2. **The ends first.** Good is run, then bad, unless `--trust-ends` is passed. This is the
   cheapest way to learn the regression does not reproduce the way you are measuring it,
   which is how the first 10-07 bisect went wrong. Trust the ends only when you already have
   runs that show them, as the reproduction did for 3137 and 3152.
3. **Halving.** Each step runs the merge nearest the middle of the window between the last
   FAST and the first SLOW merge, until no merge is left between them.
4. **Skips.** A merge with no image (its CI run was cancelled, as for #3148), or whose run
   recorded no signal, is marked `UNBUILT` or `NO-DATA` and skipped, as `git bisect skip`
   does. If a skipped merge sits next to the culprit, the answer is a range of merges.

A step is one `loadtest/bisect-odb.sh <sha>` call. It pins all four images to that merge: odb
and obscalc to the commit itself, ITC and SSO to the newest of their builds at or before it,
since they come from the same repository and must match. It then boots the stack on the pair
and runs five minutes (`BISECT_MINUTES`) of the execution profile at the compressed cadence.
Last, it stops the pair. The smoke and regression stages may fail without failing the step,
because some merges in a window are broken in unrelated ways.

## Signals: what SLOW means

A signal is `<source> <expression>`. A run is **SLOW when the expression holds**.

| Signal | Reads |
|---|---|
| `cpu:postgres med>400` (default) | median Postgres CPU % over the execution run, from the wizard's docker stats samples (about every 30 s). Fast builds sit near 4 %, the 10-07 regression near 1300 %. |
| `cpu:odb avg>200`, `cpu:obscalc max>800` | any container of the stack (`odb`, `obscalc`, `itc`, `sso`, `hasura`, `postgres`, …) with `avg`, `min`, `med`, `max` or `p(N)` |
| `odb_step_overhead p(95)>1000` | any metric in the run's k6 summary export, with the same expression grammar as k6 thresholds and `k6/surge-slos.json` |
| `odb_step_wait{operation:RecordVisit} p(95)>500` | a tagged sub-metric. It is in the export only if a threshold in the script names it. |

Pass it with `--signal="…"` or `BISECT_SIGNAL`. Postgres CPU was the cleanest signal last time,
because step overhead depends on cadence and network jitter. Pick a threshold far from both
ends: read the ends' values in the dry run's first steps, or from earlier runs with
`--judge`.

A signal that recorded nothing (for example, a k6 metric missing from the export) is NO-DATA,
never FAST.

## Data-dependent regressions: `--upgrade-from`

Some regressions only show on a database that already has data. The 10-07 one appeared only
when a build that changed the generator-parameters hash met observations stored by an older
build. Every build was FAST from empty, including the known-slow #3152.

With `--upgrade-from`, each step is three calls:

```sh
loadtest/bisect-odb.sh --check <candidate>       # images exist? (a seed is too costly to waste)
loadtest/bisect-odb.sh --seed  <upgrade-from>    # wipe, then regression + the 40-min 200-VU load profile: ~20k observations
WIPE_DATA=0 loadtest/bisect-odb.sh <candidate>   # boot the candidate on that data and judge it
```

The seed merge defaults to the good end. `--upgrade-from=<PR|sha>` names another merge, which
must be at or before the good end. Migrations only go forward: an odb older than the
schema already in the database answers HTTP 500. That is why every candidate gets a fresh
seed rather than one shared database. The good end gets the same treatment (seed, then a
re-boot of the same build on its data), which makes it the control.

The search refuses flags that would void a step:

- `--load` is refused: the seed already loads, and the measured step must not add data.
- `--terminate` is refused: the pair, and the data with it, must survive from the seed to the step.
- `--no-execution` and `--regression-only` are refused: the step's execution stage is the measurement.
- `NEW_PAIR=1` is refused: that pair is terminated after the seed.
- `WIPE_DATA` is refused: the search sets it for each call.

The cost is high: about 95 minutes and $2.10 a step, so an 11-merge window takes 4 steps
with trusted ends (about 6 h, $8.40) or 6 without (about 9.5 h, $12.60). The dry run prints the
estimate for the window you give it. A database snapshot restored before each step would cut
a step to about 25 minutes. That option is open (`handoff-generalize-odb-bisect.md`, action 3).

The same three calls work by hand for a single question, as the reproduction did:

```sh
loadtest/bisect-odb.sh --seed 3137
WIPE_DATA=0 loadtest/bisect-odb.sh 3152
```

## Options

| Option | Effect |
|---|---|
| `--good=<PR\|sha>`, `--bad=<PR\|sha>` | the window's ends (required for a new search) |
| `--signal="<source> <expression>"` | what SLOW means; default `cpu:postgres med>400` (also `BISECT_SIGNAL`) |
| `--trust-ends` | do not run the ends; assume good is FAST and bad is SLOW |
| `--upgrade-from[=<PR\|sha>]` | boot every merge on data seeded by this merge (default: the good end) |
| `--dry-run` | print the window, the estimate and the first step's commands, run nothing |
| `--resume=out/bisect-odb-<stamp>.json` | continue a stopped search (signal, ends and mode come from the file) |
| `-- <aws-run.sh flags>` | passed to every run, e.g. `-- --minutes 10` or `-- --realistic` |
| `--judge [<stamp>]` | judge one collected run (the newest by default) by `--signal`; no search |

Environment passed through to the wizard: `BISECT_MINUTES` (execution minutes, default 5),
`TARGET_TYPE`/`GEN_TYPE`, `START_RETRY_MINUTES`, and `NEW_PAIR=1` for plain searches only.
Instance capacity in us-west-2a comes and goes. The wizard retries for 10 minutes, then the step
stops the search (see below).

## Results, stops and resuming

The search writes after every step:

- `out/bisect-odb-<stamp>.json` holds the state: the window, each step's verdict, observed
  value and run stamp, and the seed's stamp in upgrade mode.
- `out/bisect-odb-<stamp>.md` holds the same as a table, to paste into a note.

Each judged run's raw files stay in `out/`: `k6-aws-execution-<run>.json`,
`odb-stats-aws-<run>.log`, `pg-activity-execution-aws-<run>.txt` (the Postgres snapshot, with
obscalc's backlog by state) and the odb and obscalc logs. To re-read one:

```sh
node tools/bisect-odb.js --judge 20261009T214603Z
node tools/bisect-odb.js --judge --signal="odb_step_overhead p(95)>1000" 20261009T214603Z
loadtest/bisect-odb.sh --read            # the newest run, default signal
```

How a search ends, with its exit code:

| End | Exit | Meaning and next move |
|---|---|---|
| `culprit:` | 0 | one merge, or a range where skipped merges sit next to it. Read its diff. |
| good end is SLOW | 1 | the regression is older than good, or the threshold is too low |
| bad end is FAST | 1 | from empty: try `--upgrade-from`. Otherwise check the threshold or the bad end. |
| an end had no image or no signal | 1 | choose a neighbouring merge as the end |
| inconsistent | 1 | a SLOW merge before a FAST one: noise near the threshold, or two changes. Re-run those two merges with `loadtest/bisect-odb.sh`, or move the threshold. |
| stopped, `--resume=` printed | 2 | a run collected nothing (capacity, a broken boot, an expired `HEROKU_API_KEY`). Fix it and resume; nothing was judged from it. |

## Traps

- **Never edit the wizard while a step is running** (`pgrep -fl aws-first-run`). The search
  shells out to it for hours.
- **Postgres statistics are cumulative** until the database is wiped. A plain step wipes; an
  upgrade step reads statistics that include the seed's load. Compare the snapshot against
  the seed's, not against zero.
- **The laptop is not an oracle.** The local stack never reproduced the 10-07 saturation.
  Use it for the unit tests (`npx vitest run lib/bisect.test.js`) only.

## Where the code is

- `lib/bisect.js` (+ `lib/bisect.test.js`): the pure parts. These are the signal grammar,
  the CPU log parser, the verdict, the first-parent chain, `nextProbe` (the halving), the
  commands for a step, the upgrade-mode refusals and the table.
- `tools/bisect-odb.js`: the driver. It covers GitHub lookups, the loop, state and resume.
- `loadtest/bisect-odb.sh`: one step, `--seed`, `--check` and `--read`, on top of
  `loadtest/aws-run.sh` and the wizard `loadtest/aws-first-run.sh`.
