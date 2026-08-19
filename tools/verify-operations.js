#!/usr/bin/env node
/**
 * Replay every ODB operation against a live stack, as a guest.
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
import {
  createObservation,
  createProgram,
  createTarget,
  gmosNorthLongSlit,
  observation,
  observationCalculated,
  observations,
  programDetails,
  programs,
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
 */
async function check(token, operation) {
  try {
    const data = await run(token, operation);
    results.push({ name: operation.operationName, ok: true });
    return data;
  } catch (error) {
    results.push({
      name: operation.operationName,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
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
const program = await check(token, createProgram({ name: "odbattr verify" }));
const programId = program?.createProgram.program.id;
if (!programId) {
  console.error("cannot continue without a program");
  report();
}

const target = await check(token, createTarget({ programId }));
const targetId = target?.createTarget.target.id;

const created = await check(
  token,
  createObservation({
    programId,
    targetIds: targetId ? [targetId] : undefined,
    subtitle: "odbattr verify",
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
    updateObservationSubtitle({ observationId, subtitle: "odbattr verified" }),
  );
}

await check(token, programs({}));
await check(token, programDetails({ programId }));
await check(token, observations({ programId }));
await check(token, targets({ programId }));
if (observationId) {
  await check(token, observation({ observationId }));
  // Only checks that the query is answerable — the values are still being calculated.
  await check(token, observationCalculated({ observationId }));
}

report();

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
