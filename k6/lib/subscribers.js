// The subscriber VUs (ticket 022, CONTEXT.md "Subscriber VU"): one held graphql-transport-ws
// socket per VU, carrying the subscriptions a real client holds, and three measurements:
//
//   round trip  — a small mutation goes out over HTTP; the time from its acknowledgement to
//                 the matching event arriving on this VU's own subscription (odb_ws_round_trip)
//   ping        — our ping to the server's pong, the socket's responsiveness (odb_ws_ping)
//   health      — reconnects, unanswered pings, events that never arrived
//
// Two shapes. The **Explore tab**: a PI with one program open, the eight subscriptions
// Explore's program cache holds, measured on `observationEdit`. The **Observe browser**: a
// staff member with one observation loaded, `observationEdit`, `datasetEdit` and the step
// events, measured on `observationEdit`. Identities are per VU and never shared.
//
// A session connects, subscribes, edits on a cadence, holds, then leaves — cleanly, or by
// dropping the socket the way a closed laptop does. Cross-VU fan-out (another VU's edit seen
// here) is out of scope: it needs a correlation channel k6 does not have.
import exec from "k6/execution";
import { fail } from "k6";
import {
  createObservation,
  createProgram,
  createTarget,
  datasetEdits,
  gmosNorthLongSlit,
  observationEdits,
  obscalcUpdates,
  programConfigurationRequestsDelta,
  programEditAttachments,
  programEditDetails,
  programEditInfo,
  programGroupsDelta,
  programObservationsDelta,
  programTargetsDelta,
  stepEventsAdded,
  updateObservationSubtitle,
} from "../../lib/odb-operations.js";
import { loginAsStandardUser } from "./auth.js";
import { loginAsPoolUser } from "./standard-users.js";
import { gqlAsync } from "./graphql.js";
import { GraphqlWsClient } from "./graphql-ws.js";
import { tags, wsEventLatency, wsLostEvents, wsRoundTrip } from "./metrics.js";

/** Scenario labels, literal so lib/scenario-catalog.test.js can find them. */
const EXPLORE = { scenario: "explore-tab" };
const OBSERVE = { scenario: "observe-browser" };

/**
 * Where in the standard-user pool this script's VUs start (ticket 017): each subscriber VU is
 * its own PI or staff member, by its test-wide VU id, so no two VUs of a run — this script's
 * or a composed run's (ticket 018) — share one. Without a pool, every VU is the browser persona.
 */
const SUBSCRIBER_PI_OFFSET = Number(__ENV.SUBSCRIBER_PI_OFFSET || 0);
const SUBSCRIBER_STAFF_OFFSET = Number(__ENV.SUBSCRIBER_STAFF_OFFSET || 0);

/** How long a round trip may take before the event counts as lost. */
const EVENT_TIMEOUT_MS = Number(__ENV.WS_EVENT_TIMEOUT_SECONDS || 10) * 1000;

/**
 * @typedef {object} SessionOptions
 * @property {number} holdMs how long to stay connected
 * @property {number} cadenceMs seconds between edits, jittered ±25 %
 * @property {boolean} [drop] leave by dropping the socket instead of completing
 */

/**
 * @typedef {object} Fixture
 * @property {{token: string}} session
 * @property {string} programId
 * @property {string} observationId
 */

/**
 * The PI and the program she has open. Created once per VU and reused across sessions.
 * @returns {Fixture}
 */
export function exploreTabFixture() {
  const session =
    loginAsPoolUser("pi", SUBSCRIBER_PI_OFFSET + exec.vu.idInTest - 1) ||
    loginAsStandardUser("TEST_PI");
  if (!session) fail("no PI identity: run stack/scripts/create-standard-users.sh against this stack");
  return { session, ...seedProgram(session, EXPLORE, "explore tab") };
}

/**
 * The staff member and the observation loaded in Observe. Created once per VU.
 * @returns {Fixture}
 */
export function observeBrowserFixture() {
  const session =
    loginAsPoolUser("staff", SUBSCRIBER_STAFF_OFFSET + exec.vu.idInTest - 1) ||
    loginAsStandardUser("TEST_STAFF");
  if (!session) fail("no staff identity: run stack/scripts/create-standard-users.sh against this stack");
  return { session, ...seedProgram(session, OBSERVE, "observe browser") };
}

/**
 * One Explore-tab session: eight subscriptions on the program, edits measured on
 * ProgramObservationsDelta.
 *
 * @param {Fixture} fixture
 * @param {SessionOptions} opts
 * @returns {Promise<boolean>} every round trip answered
 */
export function exploreTabSession(fixture, opts) {
  const { programId } = fixture;
  return runSession(fixture, EXPLORE, opts, {
    subscriptions: [
      programEditDetails({ programId }),
      programEditAttachments({ programId }),
      programEditInfo({ programId }),
      programTargetsDelta({ programId }),
      programGroupsDelta({ programId }),
      programConfigurationRequestsDelta({ programId }),
      obscalcUpdates({ programId }),
    ],
    measured: programObservationsDelta({ programId }),
    matches: (payload, subtitle) => {
      const edit = payload && payload.data && payload.data.observationEdit;
      return Boolean(edit) && edit.observationId === fixture.observationId && edit.value?.subtitle === subtitle;
    },
  });
}

/**
 * One Observe-browser session: the three subscriptions for the loaded observation, edits
 * measured on ObservationEdits.
 *
 * @param {Fixture} fixture
 * @param {SessionOptions} opts
 * @returns {Promise<boolean>}
 */
export function observeBrowserSession(fixture, opts) {
  const { observationId } = fixture;
  return runSession(fixture, OBSERVE, opts, {
    subscriptions: [datasetEdits({ observationId }), stepEventsAdded({ observationId })],
    measured: observationEdits({ observationId }),
    matches: (payload, subtitle) => {
      const edit = payload && payload.data && payload.data.observationEdit;
      return Boolean(edit) && edit.value?.subtitle === subtitle;
    },
  });
}

/**
 * @param {Fixture} fixture
 * @param {{scenario: string}} label
 * @param {SessionOptions} opts
 * @param {{subscriptions: any[], measured: any, matches: (payload: any, subtitle: string) => boolean}} shape
 */
async function runSession(fixture, label, opts, shape) {
  const client = new GraphqlWsClient(fixture.session, { ...label });
  try {
    await client.connect();
  } catch (error) {
    console.warn(`${label.scenario}: could not connect: ${error}`);
    return false;
  }

  // Events on the measured subscription are offered to whoever is waiting for one.
  /** @type {Set<(payload: any) => void>} */
  const listeners = new Set();
  for (const operation of shape.subscriptions) client.subscribe(operation, () => {});
  client.subscribe(shape.measured, (payload) => {
    for (const listener of listeners) listener(payload);
  });

  const end = Date.now() + opts.holdMs;
  let allAnswered = true;
  let edits = 0;
  while (Date.now() < end) {
    const wait = opts.cadenceMs * (0.75 + Math.random() * 0.5);
    const remaining = end - Date.now();
    if (remaining <= wait + EVENT_TIMEOUT_MS) {
      await sleep(Math.max(0, remaining));
      break;
    }
    await sleep(wait);
    edits += 1;
    const answered = await roundTrip(fixture, label, shape, listeners);
    allAnswered = allAnswered && answered;
  }

  if (opts.drop) client.drop();
  else client.close();
  return allAnswered || edits === 0;
}

/**
 * One measured edit: subtitle over HTTP, the matching event on our own subscription.
 * @returns {Promise<boolean>} whether the event arrived in time
 */
async function roundTrip(fixture, label, shape, listeners) {
  const subtitle = `gpp-tests ws ${exec.vu.idInTest} ${Date.now()}`;
  let eventAt = 0;
  const arrived = new Promise((resolve) => {
    const listener = (payload) => {
      if (!shape.matches(payload, subtitle)) return;
      eventAt = Date.now();
      listeners.delete(listener);
      resolve(true);
    };
    listeners.add(listener);
    setTimeout(() => {
      if (listeners.has(listener)) {
        listeners.delete(listener);
        resolve(false);
      }
    }, EVENT_TIMEOUT_MS);
  });

  const sentAt = Date.now();
  const ack = await gqlAsync(
    fixture.session,
    updateObservationSubtitle({ observationId: fixture.observationId, subtitle }),
    { ...label },
  );
  const ackAt = Date.now();
  if (!ack) return false;

  const ok = await arrived;
  const operation = shape.measured.operationName;
  if (ok) {
    // The event can beat the HTTP acknowledgement; that is a zero, not a negative number.
    wsRoundTrip.add(Math.max(0, eventAt - ackAt), tags({ ...label, operation }));
    wsEventLatency.add(eventAt - sentAt, tags({ ...label, operation }));
  } else {
    wsLostEvents.add(1, tags({ ...label, operation }));
  }
  return ok;
}

/**
 * A program with one GMOS-N long-slit observation, as the identity itself.
 * @param {{token: string}} session
 * @param {{scenario: string}} label
 * @param {string} what
 */
function seedProgram(session, label, what) {
  const opts = { ...label, measure: false };
  const name = `gpp-tests ${what} vu${exec.vu.idInTest}`;
  const program = gqlSync(session, createProgram({ name }), opts);
  const programId = program && program.createProgram.program.id;
  if (!programId) fail(`${label.scenario}: could not create a program`);
  const target = gqlSync(session, createTarget({ programId, name: `${name} target` }), opts);
  const created =
    target &&
    gqlSync(
      session,
      createObservation({
        programId,
        targetIds: [target.createTarget.target.id],
        subtitle: name,
        observingMode: gmosNorthLongSlit(),
      }),
      opts,
    );
  const observationId = created && created.createObservation.observation.id;
  if (!observationId) fail(`${label.scenario}: could not create an observation`);
  return { programId, observationId };
}

// Seeding runs before a session's async loop, so the blocking call is fine here and keeps
// the fixture code free of awaits.
import { gql as gqlSync } from "./graphql.js";

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
