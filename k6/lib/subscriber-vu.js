// The subscriber VUs' bodies (ticket 022): one Explore tab or one Observe browser per VU,
// one session per iteration. Shared by the standalone subscriber profile
// (`k6/subscribers.js`, which mixes the two shapes by VU id) and the surge run
// (`k6/surge.js`, ticket 018, which runs each shape as its own scenario).
import { sleep } from "k6";
import { scenarioAsync } from "./scenarios.js";

/**
 * A session that could not connect, or lost an event, ends at once — and the VU's next
 * iteration would reconnect within milliseconds. A person whose tab lost the server waits
 * before reloading; without this, 200 tabs against a restarting odb were a reconnect storm
 * (16 attempts per VU in 130 ms, the 2026-10-07 local smoke). Seconds, uniform.
 */
const RETRY_SECONDS = {
  min: Number(__ENV.WS_RETRY_SECONDS_MIN || 5),
  max: Number(__ENV.WS_RETRY_SECONDS_MAX || 15),
};

/** @param {boolean | undefined} ok the session's outcome */
function backOffUnless(ok) {
  if (ok) return;
  sleep(RETRY_SECONDS.min + Math.random() * (RETRY_SECONDS.max - RETRY_SECONDS.min));
}
import {
  exploreTabFixture,
  exploreTabSession,
  observeBrowserFixture,
  observeBrowserSession,
} from "./subscribers.js";

/** @typedef {import("./subscribers.js").SessionOptions} SessionOptions */

/**
 * Informational thresholds: the per-subscription and per-shape breakdown, named so the
 * summary shows it (a sub-metric only appears there when a threshold names it); `>=0`
 * never fails.
 * @type {Record<string, string[]>}
 */
export const SUBSCRIPTION_BREAKDOWN = {
  "odb_ws_round_trip{operation:ProgramObservationsDelta}": ["p(95)>=0"],
  "odb_ws_round_trip{operation:ObservationEdits}": ["p(95)>=0"],
  "odb_ws_event_latency{operation:ProgramObservationsDelta}": ["p(95)>=0"],
  "odb_ws_event_latency{operation:ObservationEdits}": ["p(95)>=0"],
  "odb_ws_ping{scenario:explore-tab}": ["p(95)>=0"],
  "odb_ws_ping{scenario:observe-browser}": ["p(95)>=0"],
  odb_ws_reconnects: ["count>=0"],
};

/**
 * Per-VU fixtures; module scope persists across a VU's iterations. One per shape, because
 * k6 may hand a VU to another scenario once its own has ended, and a fixture is tied to the
 * identity and program its shape created.
 * @type {{explore: import("./subscribers.js").Fixture | null, observe: import("./subscribers.js").Fixture | null}}
 */
const fixture = { explore: null, observe: null };

/**
 * One Explore-tab session: a PI with one program open, eight subscriptions, edits on a
 * cadence, hold, leave.
 * @param {SessionOptions} opts
 */
export async function exploreTabVu(opts) {
  if (!fixture.explore) fixture.explore = exploreTabFixture();
  const f = fixture.explore;
  backOffUnless(await scenarioAsync("explore-tab", () => exploreTabSession(f, opts)));
}

/**
 * One Observe-browser session: a staff member with one observation loaded, three
 * subscriptions, edits on a cadence, hold, leave.
 * @param {SessionOptions} opts
 */
export async function observeBrowserVu(opts) {
  if (!fixture.observe) fixture.observe = observeBrowserFixture();
  const f = fixture.observe;
  backOffUnless(await scenarioAsync("observe-browser", () => observeBrowserSession(f, opts)));
}
