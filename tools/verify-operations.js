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
  // obscalc computes the digest asynchronously and takes tens of seconds, so immediately
  // after creating an observation the ODB answers this query with a `sequence_unavailable`
  // error rather than a value. That is the expected state here: this tool checks that the
  // deployed ODB still understands our documents, not that a background worker has caught up.
  // Waiting for READY is the Playwright journey's job (spec §5 scenario 3).
  await check(token, observationCalculated({ observationId }), {
    tolerate: ["sequence_unavailable"],
  });
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
