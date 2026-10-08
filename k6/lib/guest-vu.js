// The guest VU (spec §6, CONTEXT.md "Guest VU"): the regular-operations read/write mix, one
// SSO guest per VU. The body of the trend run (`k6/load.js`) and the regular-ops layer of
// the surge run (`k6/surge.js`, ticket 018), so both exercise exactly the same mix.
//
// Every VU is an SSO guest, and a guest sees only its own programs — so the ramp doubles as
// seeding: each VU creates a handful of programs with observations before entering the
// measured 60/40 read/write loop.
import exec from "k6/execution";
import { loginAsGuest, refreshed } from "./auth.js";
import { TESTID } from "./config.js";
import {
  calculatedResultsScenario,
  createObservationScenario,
  createProgramScenario,
  editSubtitleScenario,
  readMixScenario,
  scenario,
  think,
} from "./scenarios.js";

/** Share of iterations that are reads (spec §6: 60% reads / 40% writes). */
export const READ_SHARE = Number(__ENV.READ_SHARE || 0.6);

/** Programs each VU seeds for itself before the measured loop (spec §6: 3–5). */
const SEED_PROGRAMS_MIN = Number(__ENV.SEED_PROGRAMS_MIN || 3);
const SEED_PROGRAMS_MAX = Number(__ENV.SEED_PROGRAMS_MAX || 5);

/**
 * Per-VU state; module scope persists across a VU's iterations.
 * @type {{session: import("./auth.js").Session, programs: {programId: string, observationId?: string}[]} | null}
 */
let vu = null;

/** One iteration of the guest mix: a read or a write against this VU's own programs. */
export function guestIteration() {
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
  const label = `gpp-tests ${TESTID} vu${exec.vu.idInTest}`;
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
  if (!vu || vu.programs.length === 0) return undefined;
  return vu.programs[Math.floor(Math.random() * vu.programs.length)];
}

function read() {
  const target = pick();
  if (!target || !vu) return;

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
  if (!vu) return;
  const state = vu;
  const target = pick();
  const roll = Math.random();

  // Subtitle edits are the cheapest and most frequent real edit; new observations are next;
  // new programs are rare, but they keep the working set (and the tables) growing.
  if (target && target.observationId && roll < 0.5) {
    scenario("edit-observation", () =>
      editSubtitleScenario(state.session, target.observationId),
    );
  } else if (target && roll < 0.85) {
    scenario("create-observation", () => {
      const observation = createObservationScenario(state.session, target.programId);
      if (observation && !target.observationId) {
        target.observationId = observation.observationId;
      }
      return observation;
    });
  } else {
    scenario("create-program", () => {
      const programId = createProgramScenario(state.session, {
        name: `gpp-tests ${TESTID} vu${exec.vu.idInTest} extra`,
      });
      if (programId) state.programs.push({ programId, observationId: undefined });
      return programId;
    });
  }
}
