// The proposal loop (ticket 017): what a PI does to a proposal at a Call for Proposals
// deadline, as ODB operations, driven by the surge's arrival-rate executor so that
// "N submissions per hour" is literal.
//
// One submission is the unit. A PI's first submission builds everything the ODB requires
// before it will accept one (verified against the stack, 2026-10-06, and the rules the
// nightly caught on 2026-09-07/10): a program whose PI has a partner, an educational status
// and an affiliation; an abstract; **at least one defined observation** — the ODB refuses
// "At least one observation must be defined", so an empty program cannot submit and the loop
// has to wait for obscalc; a proposal against the call; and a Science and a Team attachment
// through the REST route (ticket 028). Later submissions on the same PI are the deadline
// churn: retract, edit, resubmit.
//
// Every document comes from `lib/odb-operations.js`, the same ones `tests/e2e/proposals.spec.ts`
// drives, so the two suites cannot drift. Scenario names are literals, as everywhere in
// `k6/` (`lib/scenario-catalog.test.js` greps for them).
import { check, sleep } from "k6";
import {
  TEST_TARGET,
  createCallForProposals,
  createObservation,
  createProgram,
  createProposal,
  createTarget,
  gmosNorthLongSlit,
  observationWorkflow,
  proposalDetails,
  setProgramDescription,
  setProgramUserDetails,
  setProposalStatus,
} from "../../lib/odb-operations.js";
import { proposalAttachmentsScenario } from "./attachments.js";
import { gql } from "./graphql.js";
import { proposalDefinitionWait, proposalSubmissions, tags } from "./metrics.js";
import { scenario } from "./scenarios.js";

/** How long a fresh observation may take to become defined before the submission is given up. */
const DEFINITION_TIMEOUT_MS = Number(__ENV.PROPOSAL_DEFINITION_TIMEOUT_SECONDS || 180) * 1000;
const DEFINITION_POLL_SECONDS = Number(__ENV.PROPOSAL_DEFINITION_POLL_SECONDS || 3);

/** Observations a new proposal carries; one is the least the ODB accepts. */
const OBSERVATIONS_PER_PROPOSAL = Number(__ENV.PROPOSAL_OBSERVATIONS || 1);

/**
 * Of a PI's later submissions, the share that resubmit an existing proposal after an edit
 * rather than submitting a new one. A guess at the deadline mix, to be read against the
 * next real CfP close (`research/cfp-deadline-telemetry.md`).
 */
const RESUBMIT_SHARE = Number(__ENV.RESUBMIT_SHARE || 0.3);

/** The edit between a retract and its resubmission, seconds, uniform. */
const EDIT_SECONDS = {
  min: Number(__ENV.PROPOSAL_EDIT_SECONDS_MIN || 5),
  max: Number(__ENV.PROPOSAL_EDIT_SECONDS_MAX || 15),
};

/**
 * Open the Call for Proposals every PI submits against — staff only, once per run (the
 * surge script does it in `setup()`). The fixture's window is next semester with the
 * deadline months away, so nothing a run does can be "past the deadline".
 *
 * @param {{token: string}} staff
 * @returns {string | undefined} the call id
 */
export function openCall(staff) {
  return scenario("proposal-call", () => {
    const data = gql(staff, createCallForProposals(), { scenario: "proposal-call" });
    return data && data.createCallForProposals.callForProposals.id;
  });
}

/**
 * @typedef {object} Proposal
 * @property {string} programId
 * @property {string[]} observationIds
 * @property {boolean} defined every observation has left UNDEFINED
 * @property {boolean} attached both attachments are on the program
 * @property {number} submissions how many times this proposal has been submitted
 */

/**
 * Everything the ODB needs before a proposal can be submitted, except the observation
 * becoming defined and the attachments: program, PI details, abstract, target and
 * observation(s), proposal. Measured as writes under `proposal-create`.
 *
 * @param {{token: string}} pi
 * @param {{callId: string, label: string}} args
 * @returns {Proposal | undefined}
 */
export function buildProposal(pi, { callId, label }) {
  const opts = { scenario: "proposal-create" };
  return scenario("proposal-create", () => {
    const program = gql(pi, createProgram({ name: label }), opts);
    const programId = program && program.createProgram.program.id;
    if (!programId) return undefined;

    if (!gql(pi, setProgramUserDetails({ programId }), opts)) return undefined;
    if (
      !gql(
        pi,
        setProgramDescription({ programId, description: `${label}: abstract, first draft.` }),
        opts,
      )
    ) {
      return undefined;
    }

    /** @type {string[]} */
    const observationIds = [];
    for (let i = 0; i < OBSERVATIONS_PER_PROPOSAL; i += 1) {
      const target = gql(
        pi,
        createTarget({ programId, name: `${label} t${i}`, target: TEST_TARGET }),
        opts,
      );
      if (!target) return undefined;
      const created = gql(
        pi,
        createObservation({
          programId,
          targetIds: [target.createTarget.target.id],
          subtitle: `${label} o${i}`,
          observingMode: gmosNorthLongSlit(),
        }),
        opts,
      );
      if (!created) return undefined;
      observationIds.push(created.createObservation.observation.id);
    }

    if (!gql(pi, createProposal({ programId, callId }), opts)) return undefined;
    return { programId, observationIds, defined: false, attached: false, submissions: 0 };
  });
}

/**
 * Wait until the ODB calls every observation defined — obscalc has to compute the sequence
 * digest first — and record how long that took. Unmeasured reads: this is the PI waiting on
 * the system, not the system answering a request.
 *
 * @param {{token: string}} pi
 * @param {Proposal} proposal
 * @returns {boolean}
 */
export function awaitDefined(pi, proposal) {
  if (proposal.defined) return true;
  const started = Date.now();
  const pending = new Set(proposal.observationIds);
  let lastState = "not read";
  while (pending.size > 0 && Date.now() - started < DEFINITION_TIMEOUT_MS) {
    for (const observationId of [...pending]) {
      const data = gql(pi, observationWorkflow({ observationId }), {
        scenario: "proposal-create",
        measure: false,
      });
      if (!data) return false;
      const workflow = data.observation.workflow.value;
      lastState = `${workflow.state}: ${workflow.validationErrors
        .flatMap((/** @type {{messages: string[]}} */ e) => e.messages)
        .join("; ")}`;
      if (workflow.state !== "UNDEFINED") pending.delete(observationId);
    }
    // k6's blocking sleep is fine here: nothing of this VU's is in flight.
    if (pending.size > 0) sleep(DEFINITION_POLL_SECONDS);
  }
  const waited = Date.now() - started;
  proposal.defined = pending.size === 0;
  proposalDefinitionWait.add(waited, tags({ scenario: "proposal-create" }));
  check(proposal, {
    "the proposal's observation became defined": (p) => p.defined,
  });
  if (!proposal.defined) {
    console.warn(
      `${proposal.programId}: observation still undefined after ${Math.round(waited / 1000)} s — ${lastState}`,
    );
  }
  return proposal.defined;
}

/**
 * The two uploads a submission needs, at the model's sizes.
 *
 * @param {{token: string}} pi
 * @param {Proposal} proposal
 * @param {string} label
 * @returns {boolean}
 */
export function attach(pi, proposal, label) {
  if (proposal.attached) return true;
  proposal.attached = Boolean(
    scenario("proposal-attachments", () =>
      proposalAttachmentsScenario(pi, proposal.programId, { label, pad: true }),
    ),
  );
  return proposal.attached;
}

/**
 * Submit, and read back that it took: SUBMITTED with a reference minted. This is the
 * surge's proposal SLO's subject (`odb_write_duration{operation:SetProposalStatus}`).
 *
 * @param {{token: string}} pi
 * @param {Proposal} proposal
 * @returns {boolean}
 */
export function submit(pi, proposal) {
  const ok = Boolean(
    scenario("proposal-submit", () => {
      const opts = { scenario: "proposal-submit" };
      const set = gql(pi, setProposalStatus({ programId: proposal.programId, status: "SUBMITTED" }), opts);
      if (!set) return false;
      const details = gql(pi, proposalDetails({ programId: proposal.programId }), opts);
      if (!details) return false;
      const program = details.program;
      const reference = program.proposal && program.proposal.reference;
      const took = program.proposalStatus === "SUBMITTED" && Boolean(reference && reference.label);
      check(program, { "proposal is SUBMITTED with a reference": () => took });
      return took;
    }),
  );
  if (ok) {
    proposal.submissions += 1;
    proposalSubmissions.add(
      1,
      tags({
        scenario: "proposal-submit",
        operation: proposal.submissions === 1 ? "FirstSubmission" : "Resubmission",
      }),
    );
  }
  return ok;
}

/**
 * Retract and edit: the first half of the deadline churn. The edit is the abstract, the
 * cheapest thing a PI changes before resubmitting.
 *
 * @param {{token: string}} pi
 * @param {Proposal} proposal
 * @param {string} label
 * @returns {boolean}
 */
export function retractAndEdit(pi, proposal, label) {
  return Boolean(
    scenario("proposal-retract", () => {
      const opts = { scenario: "proposal-retract" };
      const set = gql(
        pi,
        setProposalStatus({ programId: proposal.programId, status: "NOT_SUBMITTED" }),
        opts,
      );
      if (!set || set.setProposalStatus.program.proposalStatus !== "NOT_SUBMITTED") return false;
      const edited = gql(
        pi,
        setProgramDescription({
          programId: proposal.programId,
          description: `${label}: abstract, revised ${new Date().toISOString()}.`,
        }),
        opts,
      );
      return Boolean(edited);
    }),
  );
}

/**
 * One PI at the deadline: the proposals they own, and one submission per call to
 * {@link ProposalPi.submitOne}. Module scope is per VU, so a VU constructs one of these on
 * its first iteration and keeps it.
 */
export class ProposalPi {
  /**
   * @param {import("./auth.js").Session} session
   * @param {{callId: string, label: string}} args `label` prefixes every program name this PI
   *   creates (the run id and the VU, by convention)
   */
  constructor(session, { callId, label }) {
    this.session = session;
    this.callId = callId;
    this.label = label;
    /** @type {Proposal[]} */
    this.proposals = [];
  }

  /**
   * Exactly one submission attempt: a new proposal from scratch, or — once this PI has
   * something submitted — with probability RESUBMIT_SHARE a retract, an edit and a
   * resubmission of one of them.
   *
   * @returns {boolean} whether the submission took
   */
  submitOne() {
    const submitted = this.proposals.filter((p) => p.submissions > 0);
    if (submitted.length > 0 && Math.random() < RESUBMIT_SHARE) {
      const proposal = submitted[Math.floor(Math.random() * submitted.length)];
      if (!retractAndEdit(this.session, proposal, this.label)) return false;
      sleep(EDIT_SECONDS.min + Math.random() * (EDIT_SECONDS.max - EDIT_SECONDS.min));
      return submit(this.session, proposal);
    }
    return this.submitNew();
  }

  /** A proposal from nothing to SUBMITTED. */
  submitNew() {
    const label = `${this.label} p${this.proposals.length}`;
    const proposal = buildProposal(this.session, { callId: this.callId, label });
    if (!proposal) return false;
    this.proposals.push(proposal);
    // Uploads first: they do not depend on obscalc, so the wait overlaps less of the loop.
    if (!attach(this.session, proposal, label)) return false;
    if (!awaitDefined(this.session, proposal)) return false;
    return submit(this.session, proposal);
  }
}
