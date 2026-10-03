// Observe execution on its own (ticket 021): N Observe instances executing seeded GMOS
// observations against the ODB, for developing and reading the stall metrics before the
// surge profile (ticket 018) layers them over proposal and subscriber traffic.
//
//   source stack/.env.generated
//   OBSERVE_INSTANCES=2 STEP_SECONDS_MIN=5 STEP_SECONDS_MAX=10 DURATION=3m k6 run k6/execution.js
//
// Each VU is one Observe server instance with the service identity, on a constant-vus
// executor: an instance never ramps, it is either executing or not. Each seeds its own
// observations at start, re-seeding when they run out.
import exec from "k6/execution";
import tempo from "./vendor/http-instrumentation-tempo.js";
import { INSECURE_TLS, TEMPO_ENABLED, TESTID, endpoints } from "./lib/config.js";
import {
  CADENCE,
  ObserveInstance,
  seedExecutableObservations,
  serviceSession,
  siteForVu,
} from "./lib/execution.js";
import { scenarioAsync } from "./lib/scenarios.js";

if (TEMPO_ENABLED) {
  tempo.instrumentHTTP({ propagator: "w3c" });
}

/** Observe instances: 2 in the realistic tier, 4 in the ceiling tier (ticket 020). */
const OBSERVE_INSTANCES = Number(__ENV.OBSERVE_INSTANCES || 2);

/** Observations each instance seeds at a time; one GMOS long-slit yields ~12 steps. */
const OBSERVATIONS_PER_SEED = Number(__ENV.EXECUTION_OBSERVATIONS || 4);

export const options = {
  insecureSkipTLSVerify: INSECURE_TLS,
  scenarios: {
    observe: {
      executor: "constant-vus",
      vus: OBSERVE_INSTANCES,
      duration: __ENV.DURATION || "10m",
      gracefulStop: "60s",
    },
  },
  thresholds: {
    checks: [`rate>${__ENV.MIN_CHECK_RATE || 0.99}`],
    // Provisional stall budget from ticket 020; the surge SLO file (ticket 023) owns the
    // final figures. Here it makes a local run's verdict visible.
    odb_step_overhead: ["p(95)<2000", "p(99)<5000"],
    // Informational: a sub-metric only appears in the summary when a threshold names it, and
    // the breakdown by blocking point is what a run of this script is for.
    ...Object.fromEntries(
      ["RecordVisit", "StepRecorded", "RecordDataset", "Flush", "ExecutionConfig"].map((point) => [
        `odb_step_wait{operation:${point}}`,
        ["p(95)>=0"],
      ]),
    ),
    "odb_write_duration{scenario:execution}": ["p(95)>=0"],
    "odb_read_duration{operation:ExecutionConfig}": ["p(95)>=0"],
  },
};

/** Per-VU state; module scope persists across a VU's iterations. */
let instance = null;

export function setup() {
  console.log(
    `execution run ${TESTID} against ${endpoints.odbGraphqlUrl}: ${OBSERVE_INSTANCES} Observe ` +
      `instance(s), ${CADENCE.min}–${CADENCE.max} s per step`,
  );
}

export default async function () {
  if (!instance) instance = boot();

  if (instance.remaining === 0) {
    const seeded = seed(instance.site);
    if (seeded.length === 0) {
      exec.test.abort(`VU ${exec.vu.idInTest}: could not seed executable observations`);
    }
    instance.queue.push(...seeded);
  }

  await scenarioAsync("execution", async () => (await instance.step()) === "ok");
}

function boot() {
  const session = serviceSession();
  const site = siteForVu(exec.vu.idInTest);
  const observe = new ObserveInstance(session, { site, observationIds: seed(site) });
  if (observe.remaining === 0) {
    exec.test.abort(`VU ${exec.vu.idInTest}: could not seed executable observations`);
  }
  return observe;
}

/** @param {"GN"|"GS"} site */
function seed(site) {
  const label = `gpp-tests ${TESTID} observe${exec.vu.idInTest} ${site}`;
  const ready = seedExecutableObservations(serviceSession(), {
    site,
    count: OBSERVATIONS_PER_SEED,
    label,
  });
  console.log(`VU ${exec.vu.idInTest} (${site}): ${ready.length}/${OBSERVATIONS_PER_SEED} observations executable`);
  return ready;
}
