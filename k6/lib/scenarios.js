// The v1 scenarios at the GraphQL level (spec §5), shared by both k6 suites.
//
// These are the API-level variants of the same four browser scenarios: login is a token
// fetch, and the rest are the mutations Explore issues, plus the read mix Explore actually
// loads a program with. The regression suite runs each once; the load suite weights them
// 60/40 read/write.
import { sleep } from "k6";
import {
  createObservation,
  createProgram,
  createTarget,
  gmosNorthLongSlit,
  observation as observationQuery,
  observationCalculated,
  observations as observationsQuery,
  programDetails,
  programs as programsQuery,
  targets as targetsQuery,
  updateObservationSubtitle,
} from "../../lib/odb-operations.js";
import { THINK_TIME_SECONDS } from "./config.js";
import { gql } from "./graphql.js";
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
      subtitle: opts.subtitle || "odbattr",
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
  const subtitle = opts.subtitle || `odbattr edited ${Date.now()}`;
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
