#!/usr/bin/env node
/**
 * Replay every ODB operation against a live stack, as a guest — and, when the stack's service
 * JWT is in the environment, the service-role execution operations too (ticket 021).
 *
 * `lib/odb-operations.test.js` already validates every document and payload against the
 * vendored schema snapshot, so this catches the other half: the deployed ODB having moved on
 * from that snapshot, or an operation guests are no longer allowed to perform. It runs in a
 * couple of seconds after boot and pins a whole class of failures to "the API changed"
 * rather than letting them surface as a mysterious red journey twenty minutes later.
 *
 * Usage: node tools/verify-operations.js
 * Endpoints come from the environment (see lib/endpoints.js).
 */
import { stackEndpoints } from "../lib/endpoints.js";
import { MODE_TARGETS } from "../lib/observing-modes.js";
import {
  addDatasetEvent,
  addSequenceEvent,
  addStepEvent,
  createObservation,
  createProgram,
  createTarget,
  executionConfig,
  gmosNorthLongSlit,
  programAttachments,
  observation,
  observationCalculated,
  observations,
  programDetails,
  programs,
  recordDataset,
  recordVisit,
  setObservingMode,
  targets,
  updateObservationSubtitle,
  updateTargetToTestTarget,
} from "../lib/odb-operations.js";

const endpoints = stackEndpoints(process.env);

/** @type {{name: string, ok: boolean, detail?: string}[]} */
const results = [];

/**
 * @param {string} token
 * @param {import('../lib/odb-operations.js').Operation} operation
 */
async function run(token, operation) {
  const response = await fetch(endpoints.odbGraphqlUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      operationName: operation.operationName,
      query: operation.query,
      variables: operation.variables,
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  const payload = JSON.parse(text);
  if (payload.errors?.length) {
    throw new Error(JSON.stringify(payload.errors).slice(0, 800));
  }
  return payload.data;
}

/**
 * @param {string} token
 * @param {import('../lib/odb-operations.js').Operation} operation
 * @param {{tolerate?: string[]}} [opts] `odb_error` tags that mean "the document is fine, the
 *   data just is not there yet" — not a contract failure.
 */
async function check(token, operation, opts = {}) {
  try {
    const data = await run(token, operation);
    results.push({ name: operation.operationName, ok: true });
    return data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const tolerated = (opts.tolerate ?? []).find((tag) => message.includes(tag));
    if (tolerated) {
      results.push({
        name: operation.operationName,
        ok: true,
        detail: `accepted: ${tolerated} (the query is valid; the value is still being calculated)`,
      });
      return undefined;
    }
    results.push({ name: operation.operationName, ok: false, detail: message });
    return undefined;
  }
}

async function authAsGuest() {
  const response = await fetch(endpoints.ssoGuestUrl, { method: "POST" });
  if (!response.ok) {
    throw new Error(
      `guest login failed at ${endpoints.ssoGuestUrl}: HTTP ${response.status}`,
    );
  }
  return (await response.text()).trim().replace(/^"|"$/g, "");
}

const token = await authAsGuest();
console.error(`authenticated as a guest against ${endpoints.ssoUrl}`);

// Writes first, so the reads below have real ids to work with.
const program = await check(token, createProgram({ name: "gpp-tests verify" }));
const programId = program?.createProgram.program.id;
if (!programId) {
  console.error("cannot continue without a program");
  report();
}

// Empty for a fresh program; the point is that the selection still parses (ticket 028).
await check(token, programAttachments({ programId }));

const target = await check(token, createTarget({ programId }));
const targetId = target?.createTarget.target.id;

const created = await check(
  token,
  createObservation({
    programId,
    targetIds: targetId ? [targetId] : undefined,
    subtitle: "gpp-tests verify",
    observingMode: gmosNorthLongSlit(),
  }),
);
const observationId = created?.createObservation.observation.id;

if (targetId) await check(token, updateTargetToTestTarget({ targetId }));
if (observationId) {
  await check(
    token,
    setObservingMode({ observationId, observingMode: gmosNorthLongSlit() }),
  );
  await check(
    token,
    updateObservationSubtitle({ observationId, subtitle: "gpp-tests verified" }),
  );
}

await check(token, programs({}));
await check(token, programDetails({ programId }));
await check(token, observations({ programId }));
await check(token, targets({ programId }));
if (observationId) {
  await check(token, observation({ observationId }));
  // obscalc computes the digest asynchronously and takes tens of seconds, so immediately
  // after creating an observation the ODB answers this query with a `sequence_unavailable`
  // error rather than a value. That is the expected state here: this tool checks that the
  // deployed ODB still understands our documents, not that a background worker has caught up.
  // Waiting for READY is the Playwright journey's job (spec §5 scenario 3).
  await check(token, observationCalculated({ observationId }), {
    tolerate: ["sequence_unavailable"],
  });
}

// The execution operations are service-role only. The seed is quick, but the sequence behind
// the execution config takes the ODB seconds to generate, so the step and dataset events are
// exercised only when it is ready within a short wait; the documents themselves are
// schema-checked in lib/odb-operations.test.js either way.
if (process.env.ODB_SERVICE_JWT) {
  await verifyExecutionOperations(process.env.ODB_SERVICE_JWT);
} else {
  console.error("ODB_SERVICE_JWT is not set: skipping the service-role execution operations");
}

report();

/** @param {string} serviceToken */
async function verifyExecutionOperations(serviceToken) {
  console.error("replaying the execution operations as the service user");
  const key = () => crypto.randomUUID();
  const at = () => new Date().toISOString();

  const program = await check(serviceToken, createProgram({ name: "gpp-tests verify execution" }));
  const programId = program?.createProgram.program.id;
  if (!programId) return;
  const target = await check(
    serviceToken,
    createTarget({ programId, target: MODE_TARGETS.optical }),
  );
  if (!target) return;
  const created = await check(
    serviceToken,
    createObservation({
      programId,
      targetIds: [target.createTarget.target.id],
      subtitle: "gpp-tests verify execution",
      observingMode: gmosNorthLongSlit(),
    }),
  );
  const observationId = created?.createObservation.observation.id;
  if (!observationId) return;

  const visit = await check(
    serviceToken,
    recordVisit({ observationId, idempotencyKey: key(), clientTime: at() }),
  );
  const visitId = visit?.recordVisit.visit.id;
  if (!visitId) return;
  await check(
    serviceToken,
    addSequenceEvent({ visitId, command: "START", idempotencyKey: key(), clientTime: at() }),
  );

  // One result for the config read, however many polls it took.
  let config;
  let lastError = "";
  const deadline = Date.now() + 30_000;
  while (!config && Date.now() < deadline) {
    try {
      const data = await run(serviceToken, executionConfig({ observationId, futureLimit: 0 }));
      config = data?.executionConfig ?? undefined;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (!lastError.includes("sequence_unavailable")) break;
    }
    if (!config) await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  if (!config && !lastError.includes("sequence_unavailable")) {
    results.push({ name: "ExecutionConfig", ok: false, detail: lastError });
    return;
  }
  results.push({
    name: "ExecutionConfig",
    ok: true,
    detail: config ? undefined : "accepted: sequence_unavailable for 30 s (the query is valid)",
  });
  const step = config?.gmosNorth?.acquisition?.nextAtom?.steps?.[0];
  if (!step) {
    results.push({
      name: "AddStepEvent, RecordDataset, AddDatasetEvent",
      ok: true,
      detail:
        "skipped: no step to record against yet (documents schema-checked in lib/odb-operations.test.js)",
    });
    return;
  }

  await check(
    serviceToken,
    addStepEvent({ visitId, stepId: step.id, stepStage: "START_STEP", idempotencyKey: key(), clientTime: at() }),
  );
  const day = at().slice(0, 10).replaceAll("-", "");
  const dataset = await check(
    serviceToken,
    recordDataset({
      visitId,
      stepId: step.id,
      filename: `N${day}S${String(Date.now() % 100_000_000).padStart(4, "0")}.fits`,
      idempotencyKey: key(),
    }),
  );
  const datasetId = dataset?.recordDataset.dataset.id;
  if (datasetId) {
    await check(
      serviceToken,
      addDatasetEvent({ datasetId, datasetStage: "START_EXPOSE", idempotencyKey: key(), clientTime: at() }),
    );
  }
  // Leave the observation in a clean state: the step aborted, the sequence stopped.
  await check(
    serviceToken,
    addStepEvent({ visitId, stepId: step.id, stepStage: "ABORT", idempotencyKey: key(), clientTime: at() }),
  );
  await check(
    serviceToken,
    addSequenceEvent({ visitId, command: "STOP", idempotencyKey: key(), clientTime: at() }),
  );
}

function report() {
  const failed = results.filter((r) => !r.ok);
  for (const result of results) {
    console.log(`${result.ok ? "ok  " : "FAIL"} ${result.name}`);
    if (result.detail) console.log(`     ${result.detail}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} operations ok`);
  if (failed.length > 0) {
    console.log(
      "\nThe deployed ODB disagrees with lib/odb-operations.js. Refresh the vendored\n" +
        "schema (schema/README.md), fix the operations, and re-run `npm test`.",
    );
  }
  process.exit(failed.length === 0 ? 0 : 1);
}
