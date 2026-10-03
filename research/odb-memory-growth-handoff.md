# Handoff: the odb's memory grows under execution traffic (local stack)

**Written:** 2026-10-03, from the session that built ticket 021. **Status: resolved the same
day — JVM sizing, not a leak** (see "Resolution" below; the sections after it are the trail).

## Resolution (2026-10-03, evening)

The odb image's launcher (`/opt/docker/bin/lucuma-odb-service`, lines 360–435) sizes the heap
from the container's cgroup limit and pins it: `-XX:MaxRAM=<limit> -Xms<heap> -Xmx<heap>` with
`heap = limit − min(1024 MB, 26 % of limit + 80 MB)`. Read from the running container:

| Container limit | Heap (-Xms = -Xmx) | Left for everything else |
|---|---|---|
| 2 GiB (local default) | 1,436 MB | ~610 MB |
| 25.6 GiB (AWS, 40 % of 64 GiB) | ~24.6 GiB | 1 GiB |

A JDK sidecar attached to the local odb (`jcmd 1 GC.heap_info`) confirmed it: G1, heap
reserved = committed = 1,470 MB with 107 MB in use. Resident memory is the heap pages the JVM
has touched so far plus ~250 MB native, and with the heap committed at its maximum from the
start nothing is ever given back, so RSS only climbs — in steps, as eden moves into untouched
regions — until the whole heap has been walked. That is the staircase, idle or not; execution
traffic only walks it faster (4.6 → 15.5 GiB in 20 minutes on AWS, in two surges with a
plateau while young collections reused touched regions).

Consequences:

- **Not an odb leak.** No ask to the odb team about memory growth.
- **Local OOM kills were real but a sizing artefact:** 1,436 MB heap + metaspace + threads +
  the metrics agent + emulation overhead > 2 GiB. Fix: `ODB_JAVA_OPTS='-Xms768m -Xmx768m'`
  (the launcher honours an explicit `-Xmx` in `JAVA_OPTS`), or a bigger `ODB_MEM_LIMIT`.
- **On the load target the risk is inverted:** a 24.6 GiB heap leaves native memory 1 GiB;
  a 75-minute surge run would walk the heap to its maximum and then live on that margin. The
  wizard now caps the heap at 60 % of the odb's container (`ODB_JAVA_OPTS`, stage 4).
- **Worth telling the odb team, as information rather than a bug:** the launcher's formula
  (a port of Heroku's dyno heuristics) caps "system RAM" at 1 GiB, which fits dynos and not a
  25 GiB container. Production's dynos are small, so nothing is wrong there today.

The sections below are the investigation as it was handed off, kept for the record.

## What was seen

All on the local ephemeral stack (`stack/docker-compose.yml`, compose project `gpp-tests`)
on an M-series Mac: Docker Desktop VM with 8 GiB and 10 CPUs, `aarch64`, running the lucuma
`-dev` images, which are `linux/amd64`, under emulation. The odb container's limit is the
default `ODB_MEM_LIMIT=2g`. The seven containers' limits add up to about 7.5 GiB, so the VM
itself is near full.

| When (local time, 2026-10-03) | What ran | odb memory | Outcome |
|---|---|---|---|
| 00:00 | Stack booted fresh | — | healthy |
| 00:08 | Execution run 1: 2 Observe instances, 3–5 s per step, 75 s, 23 steps | not sampled | 359/359 checks, 0 errors |
| 00:11 | Execution run 2: same shape, 60 s | not sampled | 9 failures at the end: HTTP 502 |
| 00:12 | — | at the 2 GiB limit | **OOM-killed** (`exit 137`, `OOMKilled=true`) |
| 00:13 | odb restarted alone | 1.14 GiB 50 s after start | healthy |
| 00:17–00:19:43 | Execution run 3: same shape, 180 s, 39 steps, 47 execution-config reads | **1.16 → 2.00 GiB in ~110 s**, then pinned at the limit | 617/626 checks; **OOM-killed** at the end |
| 00:21 | odb restarted alone | 1.12 GiB after start | healthy |
| 00:25 | Regression suite once (92 checks, incl. one executed step) | not sampled | green |
| 13:02 | Idle since 00:25 | **1.58 GiB** | still healthy |

Samples from run 3, every ~9 s (`docker stats`, odb container):

```
00:17:07 1.162GiB   00:17:26 1.536GiB   00:17:44 1.671GiB   00:18:04 1.838GiB
00:18:24 1.936GiB   00:18:44 1.976GiB   00:18:54 2GiB (pinned until the kill)
```

CPU on the odb container during the run alternated between ~1 % and 90–195 %. The odb's log
carried only Cats Effect's "Your app's responsiveness … CPU is probably starving" warnings,
no errors, no exceptions. Postgres sat at ~170 MiB, obscalc at ~700–940 MiB of 1 GiB.

The traffic that produced it, per Observe instance per step (3–5 s): 6 step events,
1 `recordDataset`, 6 dataset events, 1 `addSequenceEvent`, 1 `executionConfig` read with
`futureLimit: 100` selecting the full step fields of both sequences. Two instances, so about
7 requests/s overall. For comparison, the August 200-VU guest profile on AWS (reads and
writes of programs and observations, no execution) did not kill an odb with 25 GiB.

## Seen on AWS too, idle (2026-10-03, native amd64)

The first AUTO run of the wizard sampled the odb on the `m7i.4xlarge` target every 30 s
(`out/odb-stats-aws-20261003T144017Z.log`). The execution stage itself failed to start (a
quoting error, fixed), so the odb saw only the smoke run and the regression suite at the
start, then nothing. Its resident memory still climbed, in steps:

```
14:15:59  4.674 GiB   (limit 25.6 GiB; just after the regression suite)
14:18:07  4.835       14:24:32  4.975       14:28:49  5.116
14:33:05  5.256       14:39:30  5.397 GiB   (+0.72 GiB in 24 idle minutes)
```

Reproduced in the second AUTO run the same day: the sampler ran 18:40–19:04 UTC and the odb
went 4.637 → 5.339 GiB, the same 140 MB steps at the same six-minute spacing, with Postgres
(413 MiB), ITC (3.57 GiB) and obscalc (3.06 GiB) flat throughout. That window was idle too:
the sampler's ssh session held the wizard, so k6 started only when the sampler ended (fixed
with `setsid -f`), and the execution run itself (318 steps, 19:04–19:24) has no samples.

About 140 MB every six minutes, flat in between, at under 1 % CPU. That is not emulation
and not execution traffic. The staircase with nothing running points first at hypothesis 1
(the JVM expanding its heap toward a large maximum before collecting) and at whatever the
odb does on a timer; it does not distinguish a leak from lazy heap growth. `GC.heap_info`
before and after a forced GC on the AWS odb is the one measurement that would.

## What is not known

- **Whether it is the odb or the emulation.** amd64-under-arm64 inflates process memory,
  and the JVM's view of "available memory" under emulation is not trusted. The AWS stage 8
  run (native `m7i.4xlarge`, odb limit 40 % of 64 GiB) samples the odb every 30 s into
  `out/odb-stats-aws-<stamp>.log`; that file is the first thing to read.
- **How the JVM is sized.** `research/aws-load-target-options.md` recorded ~512 MB heap
  (`MaxRAMPercentage=25%`) for the odb image in August. If the current image lets the heap
  take most of the container, growth to the limit is the JVM filling its heap by design, and
  the kill is heap + metaspace + native exceeding the cgroup, not a leak. Verify on the
  running image (below) before reasoning about leaks.
- **Whether idle growth is real.** 1.12 → 1.58 GiB over 13 idle hours with one regression
  run in between is either the heap expanding lazily or something accumulating. One idle
  night with samples every 5 minutes answers it.
- **Whether execution-specific.** The same 3-minute shape with `k6/load.js` guest traffic
  (shrunk profile, README "Running the load suite") against a fresh odb would show whether
  execution events and config reads are special, or any sustained traffic does it.

## Hypotheses, in the order to test them

1. **JVM sizing, not a leak.** Heap allowed to grow near the container limit; emulation adds
   native overhead; the cgroup kills at 2 GiB. Prediction: with `ODB_MEM_LIMIT=4g` the same
   run plateaus below the limit and the odb survives.
2. **Per-call accumulation on the execution path.** Each `executionConfig` read regenerates
   both sequences and consults the ITC; the odb caches ITC results and generated sequences
   per observation. Prediction: growth tracks the number of config reads (47 in run 3), not
   wall time, and `GC.heap_info` after a forced GC still shows a high live set.
3. **Emulation artefact only.** Prediction: the AWS sampler shows a flat line at the same
   traffic shape. Then this file closes with that line and nothing else is needed.

## How to reproduce and what to collect

Bring the stack up (images are already local; the Heroku key is not needed):

```bash
cd ~/code/noirlab/odbattr
SKIP_PULL=1 SKIP_HOSTS=1 direnv exec . stack/scripts/bootstrap.sh
source stack/.env.generated          # ODB_SERVICE_JWT, CA cert
```

Sample the odb every 10 s into a file, in a second terminal:

```bash
while true; do
  echo "$(date +%T) $(docker stats --no-stream --format '{{.MemUsage}} cpu={{.CPUPerc}}' gpp-tests-odb-1)"
  sleep 10
done | tee out/odb-mem-local.log
```

Run the traffic that produced the growth (3 minutes, 2 instances, compressed cadence):

```bash
OBSERVE_INSTANCES=2 STEP_SECONDS_MIN=3 STEP_SECONDS_MAX=5 DURATION=180s \
  EXECUTION_OBSERVATIONS=2 K6_TEMPO=false npm run k6:execution
```

Look inside the JVM before, during and after (the image ships a JDK; `jcmd` targets pid 1):

```bash
docker exec gpp-tests-odb-1 jcmd 1 VM.flags | tr ' ' '\n' | grep -i 'MaxHeap\|MaxRAM\|UseContainer'
docker exec gpp-tests-odb-1 jcmd 1 GC.heap_info
docker exec gpp-tests-odb-1 jcmd 1 GC.run && docker exec gpp-tests-odb-1 jcmd 1 GC.heap_info
docker inspect gpp-tests-odb-1 --format '{{json .Config.Env}}' | tr ',' '\n' | grep -i 'java\|jdk\|opts'
```

If `jcmd` is missing from the image, `docker exec gpp-tests-odb-1 cat /proc/1/status | grep -i vm` gives
RSS without the JVM's view. Native Memory Tracking needs `-XX:NativeMemoryTracking=summary`
at start, settable through `JAVA_TOOL_OPTIONS` in the compose odb environment for one
experiment.

Then the two comparison runs: the same traffic with `ODB_MEM_LIMIT=4g` (export before
bootstrap; needs `stack/scripts/down.sh` first), and the shrunk `k6/load.js` profile for
3 minutes against a fresh odb.

Afterwards, the odb's state and whether the kernel killed it:

```bash
docker inspect gpp-tests-odb-1 --format 'status={{.State.Status}} oom={{.State.OOMKilled}} restarts={{.RestartCount}}'
docker compose --project-name gpp-tests --file stack/docker-compose.yml logs --since 10m odb | grep -iv responsiveness
```

## What to write down when done

- The AWS sampler's first/last/max odb memory for the execution run, and the run's shape.
- The JVM flags in effect (`MaxHeapSize`, `MaxRAMPercentage`) and the live heap after a
  forced GC following the run.
- Which hypothesis survived, in one line, in the ticket 021 resolution and the map's watch
  item (`wayfinder/map-gpp-tests.md`, "odb memory under execution traffic").
- If it is the odb: a short ask file in `research/` for the odb team, like
  `odb-ask-operation-name-on-spans.md`, with the reproduction above.

## Pointers

- Ticket: `wayfinder/tickets/021-observe-execution-vus-and-seed.md`, "Watch item".
- Code producing the traffic: `k6/lib/execution.js` (`ObserveInstance.step`), `k6/execution.js`.
- Stack sizing: `stack/docker-compose.yml` (`mem_limit` per service), AWS sizing in
  `loadtest/aws-first-run.sh` (`pct 40` for the odb).
- Previous memory notes: `research/aws-load-target-options.md` §3 (the first AWS attempt died
  on CI-sized limits; heap figure), and the 2026-09 Postgres OOM that raised `PG_MEM_LIMIT`
  to 2 GiB.
