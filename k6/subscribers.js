// Subscribers on their own (ticket 022): a steady population of held websockets, plus users
// who come and go, against the odb's graphql-transport-ws endpoint.
//
//   source stack/.env.generated && source stack/.env.standard-users
//   SUBSCRIBERS=20 CHURN_VUS=5 DURATION=5m npm run k6:subscribers
//
// Three out of four VUs are Explore tabs (a PI, eight subscriptions on one program), the
// fourth an Observe browser (staff, three subscriptions on one observation). The steady
// population holds sessions of SESSION_SECONDS and reconnects; the churn executor ramps users
// in and out with one- to three-minute sessions, half of which drop the socket instead of
// closing it. Each session edits on a cadence and measures the round trip on its own
// subscription. Design target on AWS: 50–100 steady (ticket 020).
import exec from "k6/execution";
import tempo from "./vendor/http-instrumentation-tempo.js";
import { INSECURE_TLS, TEMPO_ENABLED, TESTID, endpoints } from "./lib/config.js";
import { scenarioAsync } from "./lib/scenarios.js";
import {
  exploreTabFixture,
  exploreTabSession,
  observeBrowserFixture,
  observeBrowserSession,
} from "./lib/subscribers.js";

if (TEMPO_ENABLED) {
  tempo.instrumentHTTP({ propagator: "w3c" });
}

const SUBSCRIBERS = Number(__ENV.SUBSCRIBERS || 20);
const CHURN_VUS = Number(__ENV.CHURN_VUS || 5);
const DURATION = __ENV.DURATION || "10m";
const SESSION_SECONDS = Number(__ENV.SESSION_SECONDS || 300);
const EDIT_CADENCE_SECONDS = Number(__ENV.EDIT_CADENCE_SECONDS || 30);

export const options = {
  insecureSkipTLSVerify: INSECURE_TLS,
  scenarios: {
    steady: {
      executor: "constant-vus",
      exec: "steady",
      vus: SUBSCRIBERS,
      duration: DURATION,
      gracefulStop: "30s",
    },
    churn: {
      executor: "ramping-vus",
      exec: "churn",
      startVUs: 0,
      stages: [
        { duration: __ENV.CHURN_RAMP || "1m", target: CHURN_VUS },
        { duration: __ENV.CHURN_HOLD || "7m", target: CHURN_VUS },
        { duration: __ENV.CHURN_DRAIN || "2m", target: 0 },
      ],
      gracefulRampDown: "30s",
      gracefulStop: "30s",
    },
  },
  thresholds: {
    checks: [`rate>${__ENV.MIN_CHECK_RATE || 0.99}`],
    // Provisional: the subscription round trip has no SLO yet (ticket 023 picks one from these
    // numbers). Named so the summary shows them.
    "odb_ws_round_trip{operation:ProgramObservationsDelta}": ["p(95)>=0"],
    "odb_ws_round_trip{operation:ObservationEdits}": ["p(95)>=0"],
    "odb_ws_event_latency{operation:ProgramObservationsDelta}": ["p(95)>=0"],
    "odb_ws_event_latency{operation:ObservationEdits}": ["p(95)>=0"],
    "odb_ws_ping{scenario:explore-tab}": ["p(95)>=0"],
    "odb_ws_ping{scenario:observe-browser}": ["p(95)>=0"],
    odb_ws_lost_events: ["count>=0"],
    odb_ws_unanswered_pings: ["count>=0"],
    odb_ws_reconnects: ["count>=0"],
  },
};

/** Per-VU fixture; module scope persists across a VU's iterations. */
let fixture = null;

export function setup() {
  console.log(
    `subscribers run ${TESTID} against ${endpoints.odbWsUrl}: ${SUBSCRIBERS} steady, ` +
      `${CHURN_VUS} churning, sessions ${SESSION_SECONDS} s, an edit every ~${EDIT_CADENCE_SECONDS} s`,
  );
}

/** One VU in four is an Observe browser; the rest are Explore tabs. */
function isObserveBrowser() {
  return exec.vu.idInTest % 4 === 0;
}

function ensureFixture() {
  if (!fixture) fixture = isObserveBrowser() ? observeBrowserFixture() : exploreTabFixture();
  return fixture;
}

export async function steady() {
  const f = ensureFixture();
  const opts = { holdMs: SESSION_SECONDS * 1000, cadenceMs: EDIT_CADENCE_SECONDS * 1000, drop: false };
  if (isObserveBrowser()) {
    await scenarioAsync("observe-browser", () => observeBrowserSession(f, opts));
  } else {
    await scenarioAsync("explore-tab", () => exploreTabSession(f, opts));
  }
}

export async function churn() {
  const f = ensureFixture();
  const opts = {
    holdMs: (60 + Math.random() * 120) * 1000,
    cadenceMs: EDIT_CADENCE_SECONDS * 1000,
    drop: Math.random() < 0.5,
  };
  if (isObserveBrowser()) {
    await scenarioAsync("observe-browser", () => observeBrowserSession(f, opts));
  } else {
    await scenarioAsync("explore-tab", () => exploreTabSession(f, opts));
  }
}
