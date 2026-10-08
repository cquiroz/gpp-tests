// The proposal VU's body (ticket 017): one PI from the standard-user pool, one submission per
// iteration. Shared by the standalone proposal loop (`k6/proposals.js`) and the surge run
// (`k6/surge.js`, ticket 018). The call every PI submits against is opened once, in the
// script's `setup()`, by {@link openCallAsStaff}.
import exec from "k6/execution";
import { fail } from "k6";
import { loginAsStandardUser, refreshed } from "./auth.js";
import { TESTID } from "./config.js";
import { ProposalPi, openCall } from "./proposals.js";
import { loginAsPoolUser } from "./standard-users.js";

/**
 * Where in the PI pool this layer's VUs start. A VU's identity is its test-wide id plus this
 * offset, so in a composed run the pool simply has to cover every VU id (ticket 018).
 */
export const PI_POOL_OFFSET = Number(__ENV.PI_POOL_OFFSET || 0);

/**
 * Informational thresholds: the proposal loop's parts, named so the summary carries them
 * (a sub-metric only appears there when a threshold names it); `>=0` never fails.
 * @type {Record<string, string[]>}
 */
export const PROPOSAL_BREAKDOWN = {
  "odb_write_duration{operation:UploadAttachment}": ["p(95)>=0"],
  "odb_write_duration{scenario:proposal-create}": ["p(95)>=0"],
  "gpp_scenario_duration{scenario:proposal-create}": ["p(95)>=0"],
  "gpp_scenario_duration{scenario:proposal-submit}": ["p(95)>=0"],
  "gpp_scenario_duration{scenario:proposal-retract}": ["p(95)>=0"],
  gpp_proposal_definition_wait: ["p(95)>=0"],
  "gpp_proposal_submissions{operation:FirstSubmission}": ["count>=0"],
  "gpp_proposal_submissions{operation:Resubmission}": ["count>=0"],
};

/**
 * Open the Call for Proposals as staff (the first pool staff member, else the browser
 * persona). For `setup()`: fails the run when nothing could be submitted.
 * @returns {{callId: string}}
 */
export function openCallAsStaff() {
  const staff = loginAsPoolUser("staff", 0) || loginAsStandardUser("TEST_STAFF");
  if (!staff) fail("no staff identity: run stack/scripts/create-standard-users.sh against this stack");
  const callId = openCall(staff);
  if (!callId) fail("staff could not open a Call for Proposals; nothing could be submitted");
  return { callId: /** @type {string} */ (callId) };
}

/**
 * Per-VU state; module scope persists across a VU's iterations.
 * @type {ProposalPi | null}
 */
let pi = null;

/**
 * One submission attempt by this VU's PI: a proposal from nothing, or a retract, edit and
 * resubmit of one of theirs.
 * @param {{callId: string}} data from {@link openCallAsStaff}
 */
export function proposalVu(data) {
  if (!pi) {
    const index = PI_POOL_OFFSET + exec.vu.idInTest - 1;
    const session = loginAsPoolUser("pi", index);
    if (!session) {
      exec.test.abort(
        "no standard-user pool: run stack/scripts/create-standard-users.sh (it writes stack/.env.standard-users.json)",
      );
      return;
    }
    pi = new ProposalPi(session, {
      callId: data.callId,
      label: `gpp-tests ${TESTID} pi${exec.vu.idInTest}`,
    });
  }
  pi.session = refreshed(pi.session);
  pi.submitOne();
}
