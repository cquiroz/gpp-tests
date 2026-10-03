// The execution VU: one Observe server instance's ODB traffic (ticket 021, CONTEXT.md
// "Execution VU" and "Step ODB overhead").
//
// Call order and transport are those of gemini-hlsw/lucuma-apps main (2026-10-02),
// `observe/server/src/main/scala/observe/server/odb/OdbCommandsImpl.scala` and
// `OdbEventSender.scala`: every event mutation is handed to a background sender and the
// sequence does not pay for its round trip. The sequence blocks on the ODB at exactly five
// points, and their sum is the step ODB overhead:
//
//   RecordVisit      once per visit, before anything can be recorded
//   StepRecorded     the first step event's acknowledgement, before the dataset is recorded
//                    (the ODB refuses `recordDataset` for a step it has no record of)
//   RecordDataset    synchronous: its id is needed for the dataset events
//   Flush            at END_STEP, every outstanding event acknowledged before the next step
//   ExecutionConfig  the next step read back from the ODB after each step
//
// Mutations go over HTTP, one POST each. Observe reads the execution config over its own
// graphql-transport-ws socket, and so does each instance here (`k6/lib/graphql-ws.js`, ticket
// 022); `EXECUTION_CONFIG_TRANSPORT=http` is the fallback, measured the same way.
//
// Cadence is a parameter, not the step's real exposure (a GMOS science step is 15 minutes):
// STEP_SECONDS_MIN/MAX bound a uniform step period, realistic 60–120 s, compressed 5–10 s.
import exec from "k6/execution";
import { fail, sleep as blockVu } from "k6";
import {
  DATASET_STAGES,
  addDatasetEvent,
  addSequenceEvent,
  addStepEvent,
  createObservation,
  createProgram,
  createTarget,
  executionConfig,
  recordDataset,
  recordVisit,
} from "../../lib/odb-operations.js";
import { MODE_TARGETS, OBSERVING_MODES } from "../../lib/observing-modes.js";
import { PENDING, gql, gqlAsync } from "./graphql.js";
import { GraphqlWsClient } from "./graphql-ws.js";
import { stepOverhead, stepWait, stepsExecuted, tags } from "./metrics.js";

/**
 * The one scenario label every execution sample carries. A literal, like every k6 scenario
 * name: lib/scenario-catalog.test.js greps for it.
 */
const EXECUTION = { scenario: "execution" };
export const EXECUTION_SCENARIO = EXECUTION.scenario;

/** Step period bounds, seconds. */
export const CADENCE = {
  min: Number(__ENV.STEP_SECONDS_MIN || 60),
  max: Number(__ENV.STEP_SECONDS_MAX || 120),
};

/** Share of the step period spent configuring (no ODB traffic); the rest is the exposure. */
const CONFIGURE_SHARE = 0.2;

/** Where the execution-config read goes: Observe's socket, or HTTP as a fallback. */
const CONFIG_TRANSPORT = __ENV.EXECUTION_CONFIG_TRANSPORT === "http" ? "http" : "ws";

/** Observe's ODB client timeout, and one idempotent retry after it (ticket 020). */
const REQUEST_TIMEOUT = __ENV.EXECUTION_TIMEOUT || "20s";
const RETRIES = 1;

/** How long a freshly seeded observation may take to produce an execution config. */
const SEED_TIMEOUT_MS = Number(__ENV.EXECUTION_SEED_TIMEOUT_SECONDS || 180) * 1000;
const SEED_POLL_SECONDS = 3;

/**
 * One instrument per site, the way the ceiling tier runs two Observe instances per telescope:
 * odd VUs are Gemini North, even VUs Gemini South.
 *
 * @param {number} vuId
 * @returns {"GN" | "GS"}
 */
export function siteForVu(vuId) {
  return vuId % 2 === 1 ? "GN" : "GS";
}

const SITE = {
  GN: { letter: "N", branch: "gmosNorth", mode: "gmos-north-long-slit" },
  GS: { letter: "S", branch: "gmosSouth", mode: "gmos-south-long-slit" },
};

/** The service identity Observe's server uses; the stack mints it at boot. */
export function serviceSession() {
  const token = __ENV.ODB_SERVICE_JWT;
  if (!token) {
    fail(
      "ODB_SERVICE_JWT is not set: the execution VU impersonates Observe's service identity. " +
        "Locally, `source stack/.env.generated`.",
    );
  }
  return { token };
}

/**
 * Seed executable observations as the service role: one program holding `count` GMOS
 * long-slit observations at the given site, each polled until the ODB serves an execution
 * config for it. Seeding is unmeasured — it is setup, not Observe traffic.
 *
 * @param {{token: string}} session
 * @param {{site: "GN"|"GS", count: number, label: string}} args
 * @returns {string[]} the observation ids that are ready to execute
 */
export function seedExecutableObservations(session, { site, count, label }) {
  const opts = { ...EXECUTION, measure: false };
  const fixture = OBSERVING_MODES.find((m) => m.key === SITE[site].mode);
  if (!fixture) fail(`no observing-mode fixture for ${SITE[site].mode}`);

  const program = gql(session, createProgram({ name: label }), opts);
  const programId = program && program.createProgram.program.id;
  if (!programId) return [];

  /** @type {string[]} */
  const pending = [];
  for (let i = 0; i < count; i += 1) {
    const target = gql(
      session,
      createTarget({ programId, target: MODE_TARGETS[fixture.target || "optical"] }),
      opts,
    );
    if (!target) continue;
    const created = gql(
      session,
      createObservation({
        programId,
        targetIds: [target.createTarget.target.id],
        subtitle: `${label} o${i}`,
        observingMode: fixture.observingMode,
        scienceRequirements: fixture.scienceRequirements,
      }),
      opts,
    );
    if (created) pending.push(created.createObservation.observation.id);
  }

  // The first config read of a fresh observation makes the ODB call the ITC and generate the
  // sequence (~6 s locally); until then it answers `sequence_unavailable`.
  /** @type {string[]} */
  const ready = [];
  const deadline = Date.now() + SEED_TIMEOUT_MS;
  while (pending.length > 0 && Date.now() < deadline) {
    for (const observationId of [...pending]) {
      const data = gql(session, executionConfig({ observationId, futureLimit: 0 }), {
        ...opts,
        tolerate: ["sequence_unavailable"],
      });
      if (!data) {
        pending.splice(pending.indexOf(observationId), 1);
      } else if (data !== PENDING && data.executionConfig) {
        ready.push(observationId);
        pending.splice(pending.indexOf(observationId), 1);
      }
    }
    // k6's blocking sleep is safe here: seeding runs with no sends in flight.
    if (pending.length > 0) blockVu(SEED_POLL_SECONDS);
  }
  for (const observationId of pending) {
    console.warn(`${observationId}: no execution config within ${SEED_TIMEOUT_MS / 1000}s`);
  }
  return ready;
}

/**
 * One Observe server instance: a queue of executable observations, the visit and step state
 * of the one it is executing, and the background sends it has not yet heard back from.
 */
export class ObserveInstance {
  /**
   * @param {{token: string}} session
   * @param {{site: "GN"|"GS", observationIds: string[], cadence?: {min: number, max: number}}} args
   */
  constructor(session, { site, observationIds, cadence = CADENCE }) {
    this.session = session;
    this.site = site;
    this.queue = [...observationIds];
    this.cadence = cadence;
    /** @type {null | {observationId: string, visitId: string | null, config: any, acquisitionStepsLeft: number, stepsDone: number}} */
    this.current = null;
    /** @type {Promise<any>[]} outstanding background sends for the current observation */
    this.outstanding = [];
    this.stepsExecuted = 0;
    /** Observe's read socket: one per instance, the odb serializes operations on it. */
    this.socket = new GraphqlWsClient(session, { ...EXECUTION, reconnect: true });
  }

  /** Observations still to execute, including the current one. */
  get remaining() {
    return this.queue.length + (this.current ? 1 : 0);
  }

  /**
   * Execute one step, Observe's way, and record its ODB overhead.
   *
   * @returns {Promise<"ok" | "failed" | "exhausted">} `exhausted` when every seeded
   *   observation has run out of steps; the caller seeds more or stops.
   */
  async step() {
    const waits = new Waits();

    const loaded = await this.ensureLoaded(waits);
    if (!loaded) return "exhausted";
    const { current } = this;

    const step = this.nextStep();
    if (!step) {
      // Science sequence complete: Observe makes no call for that, it just stops.
      this.current = null;
      return this.step();
    }

    // First Start after a load: open the visit (blocking), then START (background).
    if (!current.visitId) {
      const visit = await this.blocking("RecordVisit", waits, (key) =>
        recordVisit({ observationId: current.observationId, idempotencyKey: key, clientTime: now() }),
      );
      if (!visit) {
        this.current = null;
        return "failed";
      }
      current.visitId = visit.recordVisit.visit.id;
      this.submit((key) => addSequenceEvent({ visitId: current.visitId, command: "START", idempotencyKey: key, clientTime: now() }));
    } else {
      // NewStepLoaded: the CONTINUE Observe's notifyODB sends when the next step is in place.
      this.submit((key) => addSequenceEvent({ visitId: current.visitId, command: "CONTINUE", idempotencyKey: key, clientTime: now() }));
    }

    const period = (this.cadence.min + Math.random() * (this.cadence.max - this.cadence.min)) * 1000;
    const visitId = /** @type {string} */ (current.visitId);
    const stepEvent = (stage) => (key) =>
      addStepEvent({ visitId, stepId: step.id, stepStage: stage, idempotencyKey: key, clientTime: now() });

    // The step's first event creates its record in the ODB; nothing waits for it yet.
    const stepRecorded = this.submit(stepEvent("START_STEP"));
    this.submit(stepEvent("START_CONFIGURE"));
    await sleep(period * CONFIGURE_SHARE);
    this.submit(stepEvent("END_CONFIGURE"));
    this.submit(stepEvent("START_OBSERVE"));

    // The dataset: wait for the step to exist, record it (synchronous), start exposing.
    const recorded = await waits.measure("StepRecorded", () => stepRecorded);
    let datasetId = null;
    if (recorded) {
      const dataset = await this.blocking("RecordDataset", waits, (key) =>
        recordDataset({ visitId, stepId: step.id, filename: this.nextFilename(), idempotencyKey: key }),
      );
      datasetId = dataset ? dataset.recordDataset.dataset.id : null;
    }
    const datasetEvent = (stage) => (key) =>
      addDatasetEvent({ datasetId, datasetStage: stage, idempotencyKey: key, clientTime: now() });
    if (datasetId) this.submit(datasetEvent(DATASET_STAGES[0]));

    await sleep(period * (1 - CONFIGURE_SHARE));

    // Exposure over: the five remaining dataset stages go out back-to-back, then the step ends.
    if (datasetId) {
      for (const stage of DATASET_STAGES.slice(1)) this.submit(datasetEvent(stage));
    }
    this.submit(stepEvent("END_OBSERVE"));
    this.submit(stepEvent("END_STEP"));
    const flushed = await waits.measure("Flush", () => this.flush());

    // Read the next step back. The engine stalls on this.
    const config = await this.readConfig(current.observationId, waits);
    current.config = config ? config.executionConfig : null;
    current.stepsDone += 1;
    if (current.acquisitionStepsLeft > 0) current.acquisitionStepsLeft -= 1;
    if (current.acquisitionStepsLeft === 0 && step.observeClass === "ACQUISITION") {
      // Acquisition done: Observe pauses for the operator here, who then continues into science.
      this.submit((key) => addSequenceEvent({ visitId, command: "PAUSE", idempotencyKey: key, clientTime: now() }));
    }

    const ok = Boolean(recorded && datasetId && flushed && config);
    stepOverhead.add(waits.total, tags({ ...EXECUTION, status: ok ? "ok" : "error" }));
    stepsExecuted.add(1, tags({ ...EXECUTION, status: ok ? "ok" : "error" }));
    this.stepsExecuted += 1;
    if (!config) this.current = null;
    return ok ? "ok" : "failed";
  }

  /**
   * Make sure an observation is loaded: pop the next one and read its config (Observe's
   * `ObsQuery` on load), dropping observations that have nothing to execute.
   *
   * @param {Waits} waits
   */
  async ensureLoaded(waits) {
    while (!this.current) {
      const observationId = this.queue.shift();
      if (!observationId) return false;
      const data = await this.readConfig(observationId, waits);
      const config = data ? data.executionConfig : null;
      if (!config) continue;
      const sequences = config[SITE[this.site].branch];
      const acquisition = sequences && sequences.acquisition;
      this.current = {
        observationId,
        visitId: null,
        config,
        // Observe runs the acquisition atom it was handed, then hands over to the operator.
        acquisitionStepsLeft: acquisition && acquisition.nextAtom ? acquisition.nextAtom.steps.length : 0,
        stepsDone: 0,
      };
      this.outstanding = [];
    }
    return true;
  }

  /**
   * The execution-config read, over the instance's socket like Observe's (or HTTP), timed as
   * the ExecutionConfig blocking point either way.
   *
   * @param {string} observationId
   * @param {Waits} waits
   */
  readConfig(observationId, waits) {
    const operation = executionConfig({ observationId });
    if (CONFIG_TRANSPORT === "ws") {
      return waits.measure("ExecutionConfig", () => this.socket.query(operation));
    }
    return this.blocking("ExecutionConfig", waits, () => operation);
  }

  /** Close the instance's socket; a VU that is done with it. */
  close() {
    this.socket.close();
  }

  /** The step Observe would run next: the acquisition atom's head while acquiring, else science. */
  nextStep() {
    const { current } = this;
    if (!current || !current.config) return null;
    const sequences = current.config[SITE[this.site].branch];
    if (!sequences) return null;
    const head = (seq) => (seq && seq.nextAtom && seq.nextAtom.steps[0]) || null;
    if (current.acquisitionStepsLeft > 0) {
      const step = head(sequences.acquisition);
      if (step) return step;
      current.acquisitionStepsLeft = 0;
    }
    return head(sequences.science);
  }

  /**
   * Hand a mutation to the background sender. Resolves to the payload or undefined, never
   * rejects, so a failed event surfaces at the flush like Observe's does.
   *
   * @param {(idempotencyKey: string) => import('../../lib/odb-operations.js').Operation} build
   */
  submit(build) {
    const key = crypto.randomUUID();
    const promise = gqlAsync(this.session, build(key), {
      ...EXECUTION,
      headers: { "Idempotency-Key": key },
      timeout: REQUEST_TIMEOUT,
      retries: RETRIES,
    });
    this.outstanding.push(promise);
    return promise;
  }

  /**
   * A call the sequence waits for, timed as a blocking point.
   *
   * @param {string} point
   * @param {Waits} waits
   * @param {(idempotencyKey: string) => import('../../lib/odb-operations.js').Operation} build
   */
  blocking(point, waits, build) {
    const key = crypto.randomUUID();
    return waits.measure(point, () =>
      gqlAsync(this.session, build(key), {
        ...EXECUTION,
        headers: { "Idempotency-Key": key },
        timeout: REQUEST_TIMEOUT,
        retries: RETRIES,
      }),
    );
  }

  /** Await every outstanding send; true when all of them were acknowledged. */
  async flush() {
    const results = await Promise.all(this.outstanding);
    this.outstanding = [];
    return results.every(Boolean);
  }

  /** `N20261003S0042.fits`-style, unique across VUs and runs on the same day. */
  nextFilename() {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    // Any index of four or more digits is legal (lucuma-core Dataset.Filename). Milliseconds
    // plus the VU's last digit keep concurrent instances apart without a coordinator.
    const index = (Date.now() % 100_000_000) * 10 + (exec.vu.idInTest % 10);
    return `${SITE[this.site].letter}${day}S${String(index).padStart(4, "0")}.fits`;
  }
}

/** The blocking points of one step, each timed and recorded as it happens. */
class Waits {
  constructor() {
    this.total = 0;
  }

  /**
   * @template T
   * @param {string} point
   * @param {() => Promise<T>} wait
   * @returns {Promise<T>}
   */
  async measure(point, wait) {
    const started = Date.now();
    try {
      return await wait();
    } finally {
      const elapsed = Date.now() - started;
      this.total += elapsed;
      stepWait.add(elapsed, tags({ ...EXECUTION, operation: point }));
    }
  }
}

function now() {
  return new Date().toISOString();
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

