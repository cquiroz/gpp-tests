// The proposal loop on its own (ticket 017): PIs submitting proposals against one Call for
// Proposals at a literal rate, for developing and reading the proposal class before the
// surge profile (ticket 018) layers it under execution, subscribers and the regular mix.
//
//   source stack/.env.generated
//   SUBMISSIONS_PER_HOUR=250 DURATION=10m npm run k6:proposals
//
// Submissions arrive on a ramping-arrival-rate executor — ramp to the tier's rate, hold —
// so the realistic tier's 100–250 per hour and the ceiling's 500 are what the ODB actually
// sees, whatever each submission costs. Each VU is one PI from the standard-user pool
// (`stack/.env.standard-users.json`, written at bootstrap), kept for the run: a PI's first
// iteration builds a complete proposal from nothing and submits it; later ones either do
// that again or retract, edit and resubmit one of theirs. Staff open the call in `setup()`.
//
// `dropped_iterations` is the honest number here: an iteration k6 could not start because
// every PI was still busy with an earlier submission means the arrival rate was not met.
import exec from "k6/execution";
import tempo from "./vendor/http-instrumentation-tempo.js";
import { fail } from "k6";
import { loginAsStandardUser, refreshed } from "./lib/auth.js";
import { INSECURE_TLS, TEMPO_ENABLED, TESTID, endpoints } from "./lib/config.js";
import { ProposalPi, openCall } from "./lib/proposals.js";
import { loginAsPoolUser, poolSize } from "./lib/standard-users.js";

if (TEMPO_ENABLED) {
  tempo.instrumentHTTP({ propagator: "w3c" });
}

/** Submissions per hour: realistic tier 100–250, ceiling 500 (ticket 020). */
const SUBMISSIONS_PER_HOUR = Number(__ENV.SUBMISSIONS_PER_HOUR || 250);
const DURATION = __ENV.DURATION || "10m";
const RAMP = __ENV.RAMP || "1m";

/**
 * PIs this script may draw from the pool, and where its range starts. A composed run
 * (ticket 018) gives the subscriber scripts the rest of the pool through their own offsets.
 */
const PI_POOL_OFFSET = Number(__ENV.PI_POOL_OFFSET || 0);
const MAX_PIS = Number(__ENV.MAX_PIS || 50);

/**
 * PIs k6 keeps ready. A submission from scratch takes a minute or two (mostly waiting for
 * obscalc), so the pool has to cover the rate times that; k6 adds VUs up to MAX_PIS when
 * it falls short and counts a dropped iteration when even that is not enough.
 */
const PREALLOCATED_PIS = Number(
  __ENV.PREALLOCATED_PIS || Math.min(MAX_PIS, Math.ceil((SUBMISSIONS_PER_HOUR / 3600) * 120) + 2),
);

export const options = {
  insecureSkipTLSVerify: INSECURE_TLS,
  scenarios: {
    proposals: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1h",
      preAllocatedVUs: PREALLOCATED_PIS,
      maxVUs: MAX_PIS,
      stages: [
        { duration: RAMP, target: SUBMISSIONS_PER_HOUR },
        { duration: DURATION, target: SUBMISSIONS_PER_HOUR },
      ],
      // A submission in flight at the end is allowed to finish: a proposal built but never
      // submitted would count as a failure that the deadline did not cause.
      gracefulStop: __ENV.GRACEFUL_STOP || "4m",
    },
  },
  thresholds: {
    checks: [`rate>${__ENV.MIN_CHECK_RATE || 0.99}`],
    // The arrival rate is the claim: an iteration k6 had no free PI for is a submission the
    // ODB never saw, so the literal "N per hour" did not happen.
    dropped_iterations: ["count==0"],
    // Provisional proposal SLO from ticket 020 (submit p95 < 2 s); the surge SLO file
    // (ticket 023) owns the final figure. Here it makes a local run's verdict visible.
    "odb_write_duration{operation:SetProposalStatus}": ["p(95)<2000"],
    // Informational: a sub-metric only appears in the summary when a threshold names it.
    "odb_write_duration{operation:UploadAttachment}": ["p(95)>=0"],
    "odb_write_duration{scenario:proposal-create}": ["p(95)>=0"],
    "gpp_scenario_duration{scenario:proposal-create}": ["p(95)>=0"],
    "gpp_scenario_duration{scenario:proposal-submit}": ["p(95)>=0"],
    "gpp_scenario_duration{scenario:proposal-retract}": ["p(95)>=0"],
    gpp_proposal_definition_wait: ["p(95)>=0"],
    "gpp_proposal_submissions{operation:FirstSubmission}": ["count>=0"],
    "gpp_proposal_submissions{operation:Resubmission}": ["count>=0"],
  },
};

/** Per-VU state; module scope persists across a VU's iterations. */
let pi = null;

export function setup() {
  const staff = loginAsPoolUser("staff", 0) || loginAsStandardUser("TEST_STAFF");
  if (!staff) fail("no staff identity: run stack/scripts/create-standard-users.sh against this stack");
  const callId = openCall(staff);
  if (!callId) fail("staff could not open a Call for Proposals; nothing could be submitted");
  console.log(
    `proposals run ${TESTID} against ${endpoints.odbGraphqlUrl}: ${SUBMISSIONS_PER_HOUR}/h for ` +
      `${DURATION} after a ${RAMP} ramp, call ${callId}, ${PREALLOCATED_PIS}–${MAX_PIS} PIs ` +
      `from a pool of ${poolSize("pi")} (offset ${PI_POOL_OFFSET})`,
  );
  return { callId };
}

/** @param {{callId: string}} data */
export default function (data) {
  if (!pi) {
    const index = PI_POOL_OFFSET + exec.vu.idInTest - 1;
    const session = loginAsPoolUser("pi", index);
    if (!session) {
      exec.test.abort(
        "no standard-user pool: run stack/scripts/create-standard-users.sh (it writes stack/.env.standard-users.json)",
      );
    }
    pi = new ProposalPi(session, {
      callId: data.callId,
      label: `gpp-tests ${TESTID} pi${exec.vu.idInTest}`,
    });
  }
  pi.session = refreshed(pi.session);
  pi.submitOne();
}
