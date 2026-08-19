// The nightly load suite (spec §6).
//
//   SUITE=load GPP_THRESHOLDS="$(node tools/compute-thresholds.js)" \
//     k6 run -o experimental-prometheus-rw --summary-export out/k6-summary.json k6/load.js
//
// The claim is "tonight is slower than last night", not absolute capacity: thresholds come
// from the run-data ledger (threshold-free for the first three nights), and the profile is
// fixed so night-over-night numbers are comparable.
//
// Every VU is an SSO guest, and a guest sees only its own programs — so the ramp doubles as
// seeding: each VU creates a handful of programs with observations before entering the
// measured 60/40 read/write loop.
import exec from "k6/execution";
import tempo from "./vendor/http-instrumentation-tempo.js";
import { loginAsGuest, refreshed } from "./lib/auth.js";
import {
  INSECURE_TLS,
  TEMPO_ENABLED,
  TESTID,
  endpoints,
  ledgerThresholds,
} from "./lib/config.js";
import {
  calculatedResultsScenario,
  createObservationScenario,
  createProgramScenario,
  editSubtitleScenario,
  readMixScenario,
  scenario,
  think,
} from "./lib/scenarios.js";

if (TEMPO_ENABLED) {
  tempo.instrumentHTTP({ propagator: "w3c" });
}

/** Share of iterations that are reads (spec §6: 60% reads / 40% writes). */
const READ_SHARE = Number(__ENV.READ_SHARE || 0.6);

/** Programs each VU seeds for itself before the measured loop (spec §6: 3–5). */
const SEED_PROGRAMS_MIN = Number(__ENV.SEED_PROGRAMS_MIN || 3);
const SEED_PROGRAMS_MAX = Number(__ENV.SEED_PROGRAMS_MAX || 5);

export const options = {
  insecureSkipTLSVerify: INSECURE_TLS,
  // k6 runs on a hosted GitHub runner; its CPU is the recorded ceiling for v1 (spec §6).
  scenarios: {
    guests: {
      executor: "ramping-vus",
      startVUs: 0,
      gracefulRampDown: "60s",
      stages: [
        { duration: __ENV.STAGE_1 || "5m", target: Number(__ENV.VUS_LOW || 50) },
        { duration: __ENV.STAGE_2 || "10m", target: Number(__ENV.VUS_HIGH || 200) },
        { duration: __ENV.STAGE_3 || "20m", target: Number(__ENV.VUS_HIGH || 200) },
        { duration: __ENV.STAGE_4 || "5m", target: 0 },
      ],
    },
  },
  thresholds: {
    // A functional floor that is armed on every run, baseline nights included: the ODB
    // answers a rejected GraphQL operation with HTTP 200 and an `errors` array, so
    // `http_req_failed` stays at 0% even if every mutation is failing. Without this, a night
    // where nothing worked would pass — and be recorded as a clean baseline.
    // Every operation adds one check, so this covers GraphQL-level failures too.
    checks: [`rate>${__ENV.MIN_CHECK_RATE || 0.99}`],
    // Latency and error-rate thresholds come from the ledger, and are empty for the first
    // three nights (spec §6). Ledger entries override the floors above by metric name.
    ...ledgerThresholds(),
  },
};

/** Per-VU state; module scope persists across a VU's iterations. */
let vu = null;

export function setup() {
  console.log(
    `load run ${TESTID} against ${endpoints.odbGraphqlUrl} ` +
      `(${Math.round(READ_SHARE * 100)}% reads, thresholds: ${JSON.stringify(ledgerThresholds())})`,
  );
}

export default function () {
  if (!vu) vu = seedWorkingSet();

  const session = refreshed(vu.session);
  if (session.reauthenticated) {
    // A new guest cannot see the previous guest's programs, so the working set has to be
    // rebuilt before the read mix means anything again.
    vu = seedWorkingSet();
    think();
    return;
  }
  vu.session = session;

  if (Math.random() < READ_SHARE) {
    read();
  } else {
    write();
  }

  think();
}

/**
 * The ramp doubles as seeding: a fresh guest with no programs would make every read return
 * an empty list and measure nothing (spec §6). Seeding traffic is deliberately excluded from
 * the measured read/write trends.
 */
function seedWorkingSet() {
  const session = loginAsGuest();
  const label = `odbattr ${TESTID} vu${exec.vu.idInTest}`;
  const count =
    SEED_PROGRAMS_MIN +
    Math.floor(Math.random() * (SEED_PROGRAMS_MAX - SEED_PROGRAMS_MIN + 1));

  const programs = [];
  for (let i = 0; i < count; i += 1) {
    const programId = createProgramScenario(session, {
      name: `${label} p${i}`,
      measure: false,
    });
    if (!programId) continue;
    const observation = createObservationScenario(session, programId, {
      measure: false,
      subtitle: `${label} o${i}`,
      targetName: `${label} t${i}`,
    });
    programs.push({
      programId,
      observationId: observation ? observation.observationId : undefined,
    });
  }

  return { session, programs };
}

/** One of the VU's own programs, chosen at random. */
function pick() {
  if (vu.programs.length === 0) return undefined;
  return vu.programs[Math.floor(Math.random() * vu.programs.length)];
}

function read() {
  const target = pick();
  if (!target) return;

  // Weighted inside the read half: opening a program is the dominant real-world read, and
  // the calculated-results poll is what Explore keeps asking for while obscalc catches up.
  if (Math.random() < 0.8 || !target.observationId) {
    scenario("read-mix", () =>
      readMixScenario(vu.session, {
        programId: target.programId,
        observationId: target.observationId,
      }),
    );
  } else {
    scenario("calculated-results", () =>
      calculatedResultsScenario(vu.session, target.observationId),
    );
  }
}

function write() {
  const target = pick();
  const roll = Math.random();

  // Subtitle edits are the cheapest and most frequent real edit; new observations are next;
  // new programs are rare, but they keep the working set (and the tables) growing.
  if (target && target.observationId && roll < 0.5) {
    scenario("edit-observation", () =>
      editSubtitleScenario(vu.session, target.observationId),
    );
  } else if (target && roll < 0.85) {
    scenario("create-observation", () => {
      const observation = createObservationScenario(vu.session, target.programId);
      if (observation && !target.observationId) {
        target.observationId = observation.observationId;
      }
      return observation;
    });
  } else {
    scenario("create-program", () => {
      const programId = createProgramScenario(vu.session, {
        name: `odbattr ${TESTID} vu${exec.vu.idInTest} extra`,
      });
      if (programId) vu.programs.push({ programId, observationId: undefined });
      return programId;
    });
  }
}
