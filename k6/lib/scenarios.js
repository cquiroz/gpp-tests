// The v1 scenarios at the GraphQL level (spec §5), shared by both k6 suites.
//
// These are the API-level variants of the same four browser scenarios: login is a token
// fetch, and the rest are the mutations Explore issues, plus the read mix Explore actually
// loads a program with. The regression suite runs each once; the load suite weights them
// 60/40 read/write.
import { check, sleep } from "k6";
import {
  TEST_CALL,
  createObservation,
  createProgram,
  createTarget,
  gmosNorthLongSlit,
  observation as observationQuery,
  observationByReference,
  observationCalculated,
  observationMode,
  observations as observationsQuery,
  programByReference,
  programDetails,
  programs as programsQuery,
  setProgramReference,
  targets as targetsQuery,
  updateObservationSubtitle,
} from "../../lib/odb-operations.js";
import { MODE_TARGETS, OBSERVING_MODES } from "../../lib/observing-modes.js";
import { switchRole, userClaim } from "./auth.js";
import { THINK_TIME_SECONDS } from "./config.js";
import { PENDING, gql } from "./graphql.js";
import { scenarioDuration, scenarioPass, tags } from "./metrics.js";

/** Uniform think time, so VUs do not march in lockstep (spec §6). */
export function think() {
  const { min, max } = THINK_TIME_SECONDS;
  sleep(min + Math.random() * (max - min));
}

/**
 * Run a named scenario, recording pass/fail and duration under that name. This is what
 * gives the regression suite a pass-rate-over-time series in Grafana (spec §7).
 *
 * @template T
 * @param {string} name
 * @param {() => T} body must return a falsy value to signal failure
 * @returns {T | undefined}
 */
export function scenario(name, body) {
  const started = Date.now();
  let result;
  let ok = false;
  try {
    result = body();
    ok = Boolean(result);
  } finally {
    scenarioDuration.add(Date.now() - started, tags({ scenario: name }));
    scenarioPass.add(ok, tags({ scenario: name }));
  }
  return ok ? result : undefined;
}

/**
 * {@link scenario} for an async body: awaits it, so the recorded duration and pass/fail
 * describe the whole step rather than the promise's creation. The execution VU's steps are
 * async because Observe's event sender is (ticket 021).
 *
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} body resolves to a falsy value to signal failure
 * @returns {Promise<T | undefined>}
 */
export async function scenarioAsync(name, body) {
  const started = Date.now();
  let result;
  let ok = false;
  try {
    result = await body();
    ok = Boolean(result);
  } finally {
    scenarioDuration.add(Date.now() - started, tags({ scenario: name }));
    scenarioPass.add(ok, tags({ scenario: name }));
  }
  return ok ? result : undefined;
}

/**
 * Scenario 2: create a program.
 * @param {{token: string}} session
 * @param {{name?: string, measure?: boolean}} [opts]
 * @returns {string | undefined} program id
 */
export function createProgramScenario(session, opts = {}) {
  const data = gql(session, createProgram({ name: opts.name }), {
    scenario: "create-program",
    measure: opts.measure,
  });
  return data && data.createProgram.program.id;
}

/**
 * Scenario 3: create an observation with a hardcoded sidereal target and a minimal GMOS
 * long-slit configuration — the payload that makes ITC and obscalc work.
 *
 * @param {{token: string}} session
 * @param {string} programId
 * @param {{measure?: boolean, subtitle?: string, targetName?: string}} [opts]
 * @returns {{observationId: string, targetId: string} | undefined}
 */
export function createObservationScenario(session, programId, opts = {}) {
  const target = gql(session, createTarget({ programId, name: opts.targetName }), {
    scenario: "create-observation",
    measure: opts.measure,
  });
  if (!target) return undefined;
  const targetId = target.createTarget.target.id;

  const created = gql(
    session,
    createObservation({
      programId,
      targetIds: [targetId],
      subtitle: opts.subtitle || "gpp-tests",
      observingMode: gmosNorthLongSlit(),
    }),
    { scenario: "create-observation", measure: opts.measure },
  );
  if (!created) return undefined;

  return { observationId: created.createObservation.observation.id, targetId };
}

/**
 * Scenario 4: edit the subtitle and read it back. `updateObservations` echoes the updated
 * rows, so the read-back is part of the same call.
 *
 * @param {{token: string}} session
 * @param {string} observationId
 * @param {{measure?: boolean, subtitle?: string}} [opts]
 * @returns {boolean}
 */
export function editSubtitleScenario(session, observationId, opts = {}) {
  const subtitle = opts.subtitle || `gpp-tests edited ${Date.now()}`;
  const data = gql(
    session,
    updateObservationSubtitle({ observationId, subtitle }),
    { scenario: "edit-observation", measure: opts.measure },
  );
  if (!data) return false;
  const updated = data.updateObservations.observations[0];
  return Boolean(updated) && updated.subtitle === subtitle;
}

/**
 * The reads Explore actually issues when a user opens a program (spec §5): the programs
 * list, program details, and the paginated observations and targets drains.
 *
 * @param {{token: string}} session
 * @param {{programId: string, observationId?: string, measure?: boolean}} args
 * @returns {boolean}
 */
export function readMixScenario(session, { programId, observationId, measure }) {
  const results = [
    gql(session, programsQuery({}), { scenario: "read-mix", measure }),
    gql(session, programDetails({ programId }), { scenario: "read-mix", measure }),
    gql(session, observationsQuery({ programId }), { scenario: "read-mix", measure }),
    gql(session, targetsQuery({ programId }), { scenario: "read-mix", measure }),
  ];
  if (observationId) {
    results.push(
      gql(session, observationQuery({ observationId }), {
        scenario: "read-mix",
        measure,
      }),
    );
  }
  return results.every(Boolean);
}

/**
 * The calculated-results read: the query Explore polls while obscalc catches up.
 *
 * `sequence_unavailable` is tolerated because it is the *normal* answer for a freshly created
 * observation — obscalc computes the digest asynchronously, and until it finishes the ODB
 * replies with that error rather than a null field. Treating it as a failure would make the
 * k6 regression suite red on every run, and would push the load suite below its check-rate
 * floor for no reason. Asserting the values actually arrive is the Playwright journey's job
 * (spec §5 scenario 3), which polls for up to five minutes.
 *
 * An `itc_error` is *not* tolerated: that means the configuration cannot be computed at all.
 *
 * @param {{token: string}} session
 * @param {string} observationId
 * @param {{measure?: boolean}} [opts]
 */
export function calculatedResultsScenario(session, observationId, opts = {}) {
  const data = gql(session, observationCalculated({ observationId }), {
    scenario: "calculated-results",
    measure: opts.measure,
    tolerate: ["sequence_unavailable"],
  });
  return Boolean(data);
}

/** How long one mode may take to show a sequence and a time estimate (ticket 030). */
const MODE_TIMEOUT_MS = Number(__ENV.MODE_TIMEOUT_SECONDS || 60) * 1000;
/** Modes in flight at once: obscalc sits near its memory limit (ticket 030). */
const MODE_PARALLELISM = Number(__ENV.MODE_PARALLELISM || 3);
const MODE_POLL_SECONDS = 3;

/**
 * An observation in every observing mode (`lib/observing-modes.js`), as a regular PI.
 *
 * Each mode is created with its fixture's mode and requirements and passes when the ODB has a
 * time estimate and a science sequence for it — not necessarily `READY` — within
 * {@link MODE_TIMEOUT_MS}; `sequence_unavailable` means keep polling, any other error fails
 * the mode at once. Visitor and exchange modes have nothing to calculate and pass on
 * create + read-back of the mode type. At most {@link MODE_PARALLELISM} modes are in flight.
 *
 * One check per mode, named after its key: the label budget (`lib/tags.js`) has no room for
 * a `mode` tag, and a check name is already how a failing operation is told apart.
 *
 * @param {{token: string}} session a TEST_PI session
 * @param {string} programId
 * @returns {boolean} every mode passed (expected failures count as passing while they fail)
 */
export function observingModesScenario(session, programId) {
  const opts = { scenario: "observing-modes" };
  /** @type {Record<string, boolean>} */
  const outcome = {};

  for (let i = 0; i < OBSERVING_MODES.length; i += MODE_PARALLELISM) {
    const batch = OBSERVING_MODES.slice(i, i + MODE_PARALLELISM);
    /** @type {{mode: typeof OBSERVING_MODES[number], observationId: string}[]} */
    const pending = [];

    for (const mode of batch) {
      const tolerate = mode.expectedFailure ? [mode.expectedFailure.tolerate ?? ""] : undefined;
      let targetIds = [];
      if (mode.target) {
        const target = gql(
          session,
          createTarget({ programId, target: MODE_TARGETS[mode.target] }),
          opts,
        );
        if (!target) {
          outcome[mode.key] = false;
          continue;
        }
        targetIds = [target.createTarget.target.id];
      }
      const created = gql(
        session,
        createObservation({
          programId,
          targetIds,
          subtitle: `observing mode: ${mode.key}`,
          observingMode: mode.observingMode,
          scienceRequirements: mode.scienceRequirements,
        }),
        { ...opts, tolerate },
      );
      const observationId = created && created.createObservation?.observation.id;
      if (!observationId) {
        outcome[mode.key] = false;
        continue;
      }
      if (mode.check === "created") {
        const read = gql(session, observationMode({ observationId }), opts);
        outcome[mode.key] = Boolean(read) && read.observation.observingMode?.mode === mode.modeType;
      } else {
        pending.push({ mode, observationId });
      }
    }

    const deadline = Date.now() + MODE_TIMEOUT_MS;
    while (pending.length > 0 && Date.now() < deadline) {
      for (const entry of [...pending]) {
        const { mode } = entry;
        const tolerate = ["sequence_unavailable"];
        if (mode.expectedFailure?.tolerate) tolerate.push(mode.expectedFailure.tolerate);
        const data = gql(session, observationCalculated({ observationId: entry.observationId }), {
          ...opts,
          tolerate,
        });
        const value = data && data !== PENDING ? data.observation.execution.digest?.value : null;
        if (!data || (value && value.estimate && value.science?.atomCount > 0)) {
          // Settled: a hard error (not tolerated) fails now; a sequence plus estimate passes.
          outcome[mode.key] = Boolean(data);
          pending.splice(pending.indexOf(entry), 1);
        }
      }
      if (pending.length > 0) sleep(MODE_POLL_SECONDS);
    }
    for (const { mode } of pending) {
      console.warn(`observing mode ${mode.key}: no sequence and estimate within ${MODE_TIMEOUT_MS / 1000}s`);
      outcome[mode.key] = false;
    }
  }

  let all = true;
  for (const mode of OBSERVING_MODES) {
    const passed = mode.expectedFailure ? !outcome[mode.key] : Boolean(outcome[mode.key]);
    const label = mode.expectedFailure
      ? `observing mode ${mode.key} still fails as expected (${mode.expectedFailure.link})`
      : mode.check === "created"
        ? `observing mode ${mode.key} is created and reads back`
        : `observing mode ${mode.key} has a sequence and time estimate`;
    check(null, { [label]: () => passed });
    all = all && passed;
  }
  return all;
}

/**
 * The GraphQL twin of tests/e2e/deep-links.spec.ts: staff give a program a reference, and
 * the two lookups Explore's resolvers perform (`program(programReference:)`,
 * `observation(observationReference:)`) find the program and its first observation by label.
 * The lookups run as the owner, the way Explore would issue them for the PI browsing.
 *
 * @param {{token: string}} staff
 * @param {{token: string}} owner
 * @param {{programId: string, observationId: string}} ids
 * @returns {boolean}
 */
export function resolveReferenceScenario(staff, owner, { programId, observationId }) {
  const opts = { scenario: "resolve-reference" };
  const minted = gql(staff, setProgramReference({ programId, semester: TEST_CALL.semester }), opts);
  const programRef = minted && minted.setProgramReference.reference?.label;
  // An engineering reference: minted on the spot, where a science one waits for an accepted
  // proposal (see setProgramReference in lib/odb-operations.js).
  if (!check(programRef, { "a program reference was minted": (r) => /^G-\d{4}[AB]-ENG-/.test(r || "") })) {
    return false;
  }

  const byProgram = gql(owner, programByReference({ programReference: programRef }), opts);
  const byObservation = gql(
    owner,
    observationByReference({ observationReference: `${programRef}-0001` }),
    opts,
  );
  return check(
    { byProgram, byObservation },
    {
      "the program reference resolves to the program": (r) =>
        Boolean(r.byProgram) && r.byProgram.program?.id === programId,
      "the observation reference resolves to the observation": (r) =>
        Boolean(r.byObservation) &&
        r.byObservation.observation?.id === observationId &&
        r.byObservation.observation?.program.id === programId,
    },
  );
}

/**
 * The GraphQL twin of tests/e2e/role-switch.spec.ts: the two-role persona starts as a PI and
 * cannot see a program another PI owns; after SSO's `set-role` its JWT carries the staff
 * role and the same program reads back. Returns the staff session, so a caller could carry
 * on as staff; the persona's stored session stays on the pi role (set-role starts a new one).
 *
 * @param {{token: string, jar: any}} dual the persona, logged in on its pi role
 * @param {string} staffRoleId the role to switch to
 * @param {string} foreignProgramId a program the persona does not own
 * @returns {boolean}
 */
export function roleSwitchScenario(dual, staffRoleId, foreignProgramId) {
  const opts = { scenario: "role-switch" };
  const before = userClaim(dual.token);
  const asPi = gql(dual, programDetails({ programId: foreignProgramId }), opts);
  const staff = switchRole(dual, staffRoleId, "role-switch");
  const after = staff && userClaim(staff.token);
  const asStaff = staff && gql(staff, programDetails({ programId: foreignProgramId }), opts);
  return check(
    { before, asPi, after, asStaff },
    {
      "starts on the pi role, with the staff role among the others": (r) =>
        r.before.role.type === "pi" &&
        (r.before.otherRoles || []).some((role) => role.id === staffRoleId),
      "as a PI, another PI's program is out of sight": (r) => Boolean(r.asPi) && r.asPi.program === null,
      "set-role answers with a JWT on the staff role": (r) =>
        Boolean(r.after) && r.after.role.type === "staff" && r.after.role.id === staffRoleId && r.after.id === r.before.id,
      "as staff, that same program reads back": (r) =>
        Boolean(r.asStaff) && r.asStaff.program?.id === foreignProgramId,
    },
  );
}
