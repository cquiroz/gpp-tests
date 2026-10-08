// The execution VU's body (ticket 021): one Observe server instance for the length of its
// scenario. Shared by the standalone execution profile (`k6/execution.js`) and the surge run
// (`k6/surge.js`, ticket 018), so the surge's execution layer is the profile that was read on
// its own, not a re-implementation.
import exec from "k6/execution";
import { TESTID } from "./config.js";
import {
  ObserveInstance,
  seedExecutableObservations,
  serviceSession,
  siteForVu,
} from "./execution.js";
import { scenarioAsync } from "./scenarios.js";

/** Observations each instance seeds at a time; one GMOS long-slit yields ~12 steps. */
export const OBSERVATIONS_PER_SEED = Number(__ENV.EXECUTION_OBSERVATIONS || 4);

/**
 * Informational thresholds: the step overhead by blocking point. A sub-metric only appears
 * in the summary when a threshold names it, and the breakdown is what reading an execution
 * run is about; `>=0` never fails.
 * @type {Record<string, string[]>}
 */
export const EXECUTION_BREAKDOWN = Object.fromEntries(
  ["RecordVisit", "StepRecorded", "RecordDataset", "Flush", "ExecutionConfig"].map((point) => [
    `odb_step_wait{operation:${point}}`,
    ["p(95)>=0"],
  ]),
);

/**
 * Per-VU state; module scope persists across a VU's iterations.
 * @type {ObserveInstance | null}
 */
let instance = null;

/**
 * One iteration is the whole scenario. The instance holds a websocket for its config reads
 * (ticket 022), and a k6 iteration only ends once the event loop is empty, so an open socket
 * would pin the iteration anyway; looping here makes that explicit and closes the socket at
 * the end. Re-seeds when the instance runs out of executable observations.
 */
export async function executionVu() {
  if (!instance) instance = boot();

  while (exec.scenario.progress < 1) {
    if (instance.remaining === 0) {
      const seeded = seed(instance.site);
      if (seeded.length === 0) {
        exec.test.abort(`VU ${exec.vu.idInTest}: could not seed executable observations`);
      }
      instance.queue.push(...seeded);
    }
    const observe = instance;
    await scenarioAsync("execution", async () => (await observe.step()) === "ok");
  }
  instance.close();
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
