/**
 * The one source of truth for every ODB GraphQL document the suites issue.
 *
 * Shared by the Playwright journey (read-back assertions, spec §5) and the k6 suites
 * (scenario variants + the read mix, spec §5/§6), so a schema change breaks one file.
 * Every document and every variable payload is validated against the vendored
 * `schema/OdbSchema.graphql` in `odb-operations.test.js`, and `tools/verify-operations.js`
 * replays them against a live stack during boot.
 *
 * Pure and dependency-free: k6 imports this module directly.
 *
 * @typedef {{operationName: string, query: string, variables: Record<string, unknown>}} Operation
 */

/**
 * v1 target: hardcoded coordinates, no catalog lookup (spec §5). M1 (the Crab Nebula) is
 * a real, always-resolvable position, which keeps the fixture recognisable in the UI.
 */
export const TEST_TARGET = {
  name: "GPP Test Star (gpp-tests)",
  sidereal: {
    ra: { hms: "05:34:31.940" },
    dec: { dms: "+22:00:52.20" },
    epoch: "J2000.000",
  },
  sourceProfile: {
    point: {
      bandNormalized: {
        sed: { stellarLibrary: "O5_V" },
        // A brightness is what makes the ITC solvable; an empty list yields no results.
        brightnesses: [{ band: "R", value: 15, units: "VEGA_MAGNITUDE" }],
      },
    },
  },
};

/**
 * The proposal fixture.
 *
 * Relative to today rather than hardcoded, and both directions are forced:
 *
 *  - the semester cannot be far future. The ODB refuses one beyond the current year + 1
 *    ("The maximum semester is capped at the current year +1"), so a fixed date would have
 *    worked until it didn't;
 *  - the submission deadline must not have passed, or Explore keeps both Submit and Retract
 *    disabled (`ProposalSubmissionBar.scala`: `isDueDeadline`).
 *
 * Next year's A semester satisfies both whenever the suite runs, and its February-July active
 * period is what a real A semester spans. `US` is an ordinary Gemini partner, and the category
 * is arbitrary but has to be a real `TacCategory`.
 */
const CALL_YEAR = new Date().getUTCFullYear() + 1;

export const TEST_CALL = {
  semester: `${CALL_YEAR}A`,
  activeStart: `${CALL_YEAR}-02-01`,
  activeEnd: `${CALL_YEAR}-07-31`,
  deadline: `${CALL_YEAR}-01-15T00:00:00Z`,
  partner: "US",
  category: "SMALL_BODIES",
  // Requested explicitly rather than derived. Left unset, the ask is the sum of the
  // program's observation estimates — zero for a program with no observations — and Explore
  // keeps "Submit Proposal" disabled while the proposal has errors
  // (ProposalSubmissionBar.scala: `disabled = … || hasProposalErrors || …`). Setting it makes
  // the fixture submittable without also building an observation and waiting on obscalc.
  timeRequestHours: 5,
};

/** Central wavelength shared by the observing mode and the science requirements. */
const CENTRAL_WAVELENGTH = { nanometers: 500 };

/**
 * A minimal, valid GMOS North long-slit configuration (spec §5 scenario 3).
 *
 * No order-blocking filter by default, and that is load-bearing: verified against the live
 * ITC, an r' filter (passband ~550-700 nm) combined with this fixture's 500 nm central
 * wavelength blocks the light entirely, and the ITC rejects the observation with
 * "Insufficient signal at 500.0 nm with this configuration". No brightness or signal-to-noise
 * value rescues it, so the calculated-results assertion — the whole point of scenario 3 —
 * could never pass. Unfiltered also keeps the fixture valid if the wavelength changes.
 *
 * If you do pass a filter, match it to the wavelength: g' for ~500 nm, r' for ~630 nm.
 *
 * @param {{grating?: string, filter?: string, fpu?: string, centralWavelength?: Record<string, number>}} [overrides]
 */
export function gmosNorthLongSlit(overrides = {}) {
  /** @type {Record<string, unknown>} */
  const mode = {
    grating: overrides.grating ?? "R831_G5302",
    fpu: overrides.fpu ?? "LONG_SLIT_0_50",
    centralWavelength: overrides.centralWavelength ?? CENTRAL_WAVELENGTH,
  };
  if (overrides.filter) mode.filter = overrides.filter;
  return { gmosNorthLongSlit: mode };
}

/**
 * Science requirements that give the ITC something to solve: signal-to-noise at the
 * observing wavelength. Without these, `execution.digest` has no sequence to estimate.
 */
export function spectroscopyRequirements() {
  return {
    exposureTimeMode: {
      signalToNoise: { value: 100, at: CENTRAL_WAVELENGTH },
    },
    spectroscopy: {
      wavelength: CENTRAL_WAVELENGTH,
      resolution: 1000,
      focalPlane: "SINGLE_SLIT",
    },
  };
}

// ---------------------------------------------------------------------------
// Mutations (spec §5 scenarios 2–4)
// ---------------------------------------------------------------------------

/**
 * @param {{name?: string}} args
 * @returns {Operation}
 */
export function createProgram({ name }) {
  return {
    operationName: "CreateProgram",
    query: `mutation CreateProgram($input: CreateProgramInput!) {
  createProgram(input: $input) {
    program { id name existence }
  }
}`,
    // Explore's own create button passes SET = null; an empty name would be rejected.
    variables: { input: { SET: name ? { name } : null } },
  };
}

/**
 * The shape `createTarget` sends: a name, a sidereal position and a source profile.
 * @typedef {{name: string, sidereal: {ra: {hms: string}, dec: {dms: string}, epoch: string}, sourceProfile: Record<string, unknown>}} TargetFixture
 */

/**
 * `target` replaces the v1 fixture — the observing-modes scenario passes one per instrument
 * family (`MODE_TARGETS` in observing-modes.js).
 *
 * @param {{programId: string, name?: string, target?: TargetFixture}} args
 * @returns {Operation}
 */
export function createTarget({ programId, name, target = TEST_TARGET }) {
  return {
    operationName: "CreateTarget",
    query: `mutation CreateTarget($input: CreateTargetInput!) {
  createTarget(input: $input) {
    target { id name }
  }
}`,
    variables: {
      input: {
        programId,
        SET: { ...target, name: name ?? target.name },
      },
    },
  };
}

/**
 * Science requirements default to `spectroscopyRequirements()` whenever a mode is given, which
 * suits the v1 GMOS long-slit fixture only; imaging and near-IR modes pass their own. Passing
 * requirements without a mode is what the browser half of the observing-modes scenario does:
 * Explore then offers the modes that satisfy them.
 *
 * @param {{programId: string, targetIds?: string[], subtitle?: string, observingMode?: Record<string, unknown>, scienceRequirements?: Record<string, unknown>}} args
 * @returns {Operation}
 */
export function createObservation({
  programId,
  targetIds,
  subtitle,
  observingMode,
  scienceRequirements,
}) {
  /** @type {Record<string, unknown>} */
  const SET = {};
  if (subtitle) SET.subtitle = subtitle;
  if (targetIds?.length) SET.targetEnvironment = { asterism: targetIds };
  if (observingMode) SET.observingMode = observingMode;
  if (scienceRequirements) SET.scienceRequirements = scienceRequirements;
  else if (observingMode) SET.scienceRequirements = spectroscopyRequirements();

  return {
    operationName: "CreateObservation",
    query: `mutation CreateObservation($input: CreateObservationInput!) {
  createObservation(input: $input) {
    observation { id title subtitle observingMode { mode } }
  }
}`,
    variables: {
      input: {
        programId,
        SET: Object.keys(SET).length > 0 ? SET : null,
      },
    },
  };
}

/**
 * Edit + read-back in one round trip: `updateObservations` echoes the updated rows.
 * @param {{observationId: string, subtitle: string}} args
 * @returns {Operation}
 */
export function updateObservationSubtitle({ observationId, subtitle }) {
  return {
    operationName: "UpdateObservationSubtitle",
    query: `mutation UpdateObservationSubtitle($input: UpdateObservationsInput!) {
  updateObservations(input: $input) {
    observations { id subtitle }
  }
}`,
    variables: {
      input: { SET: { subtitle }, WHERE: { id: { EQ: observationId } } },
    },
  };
}

/**
 * Turn a target created by Explore's "Empty Sidereal Target" action into the v1 fixture:
 * hardcoded coordinates (no Simbad) and a brightness the ITC can work with.
 *
 * @param {{targetId: string}} args
 * @returns {Operation}
 */
export function updateTargetToTestTarget({ targetId }) {
  return {
    operationName: "UpdateTargetToTestTarget",
    query: `mutation UpdateTargetToTestTarget($input: UpdateTargetsInput!) {
  updateTargets(input: $input) {
    targets {
      id
      name
      sidereal { ra { hms } dec { dms } epoch }
    }
  }
}`,
    variables: {
      input: { SET: { ...TEST_TARGET }, WHERE: { id: { EQ: targetId } } },
    },
  };
}

/**
 * Attach an observing mode (and the science requirements it needs) to one observation.
 * @param {{observationId: string, observingMode: Record<string, unknown>}} args
 * @returns {Operation}
 */
export function setObservingMode({ observationId, observingMode }) {
  return {
    operationName: "SetObservingMode",
    query: `mutation SetObservingMode($input: UpdateObservationsInput!) {
  updateObservations(input: $input) {
    observations {
      id
      instrument
      observingMode {
        gmosNorthLongSlit {
          grating
          filter
          fpu
          centralWavelength { nanometers }
        }
      }
    }
  }
}`,
    variables: {
      input: {
        SET: {
          observingMode,
          scienceRequirements: spectroscopyRequirements(),
        },
        WHERE: { id: { EQ: observationId } },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Reads — named and shaped after the queries Explore actually issues (spec §5)
// ---------------------------------------------------------------------------

/**
 * @param {{offset?: string|null, includeDeleted?: boolean}} args
 * @returns {Operation}
 */
export function programs({ offset = null, includeDeleted = true }) {
  return {
    operationName: "AllPrograms",
    query: `query AllPrograms($OFFSET: ProgramId, $includeDeleted: Boolean!) {
  programs(OFFSET: $OFFSET, includeDeleted: $includeDeleted) {
    matches {
      id
      name
      description
      type
      existence
      proposalStatus
      reference { label }
      pi { user { id } }
    }
    hasMore
  }
}`,
    variables: { OFFSET: offset, includeDeleted },
  };
}

/**
 * @param {{programId: string}} args
 * @returns {Operation}
 */
export function programDetails({ programId }) {
  return {
    operationName: "ProgramDetails",
    query: `query ProgramDetails($programId: ProgramId!) {
  program(programId: $programId) {
    id
    name
    description
    type
    existence
    proposalStatus
    pi { user { id } }
    users { user { id } role }
    reference { label }
  }
}`,
    variables: { programId },
  };
}

/**
 * The heavy one: Explore drains this loop on every program open.
 * @param {{programId: string, offset?: string|null}} args
 * @returns {Operation}
 */
export function observations({ programId, offset = null }) {
  return {
    operationName: "AllProgramObservations",
    query: `query AllProgramObservations($WHERE: WhereObservation, $OFFSET: ObservationId) {
  observations(WHERE: $WHERE, OFFSET: $OFFSET) {
    matches {
      ...observationFields
    }
    hasMore
  }
}

${OBSERVATION_FRAGMENT()}`,
    variables: { WHERE: { program: { id: { EQ: programId } } }, OFFSET: offset },
  };
}

/**
 * Single-observation read-back used after every mutating step of the journey.
 * @param {{observationId: string}} args
 * @returns {Operation}
 */
export function observation({ observationId }) {
  return {
    operationName: "ObservationReadBack",
    query: `query ObservationReadBack($observationId: ObservationId!) {
  observation(observationId: $observationId) {
    ...observationFields
  }
}

${OBSERVATION_FRAGMENT()}`,
    variables: { observationId },
  };
}

/**
 * The ITC/obscalc liveness check (spec §5 scenario 3): the workflow state and the
 * execution digest are produced by the obscalc worker, the ITC results by ITC.
 * @param {{observationId: string}} args
 * @returns {Operation}
 */
export function observationCalculated({ observationId }) {
  return {
    operationName: "ObservationCalculated",
    query: `query ObservationCalculated($observationId: ObservationId!) {
  observation(observationId: $observationId) {
    id
    workflow {
      calculationState
      value { state }
    }
    execution {
      digest {
        calculationState
        value {
          estimate {
            setupCount
            total { program { seconds } nonCharged { seconds } total { seconds } }
          }
          science { observeClass atomCount }
        }
      }
    }
    itc {
      itcType
    }
  }
}`,
    variables: { observationId },
  };
}

/**
 * Which observing mode an observation carries, whatever the mode — `mode` is generic, unlike
 * the per-instrument branches of `observingMode`. The observing-modes scenario reads it back
 * after Explore's Accept Configuration, and for visitor/exchange it is the whole assertion.
 *
 * @param {{observationId: string}} args
 * @returns {Operation}
 */
export function observationMode({ observationId }) {
  return {
    operationName: "ObservationMode",
    query: `query ObservationMode($observationId: ObservationId!) {
  observation(observationId: $observationId) {
    id
    instrument
    observingMode { mode instrument }
  }
}`,
    variables: { observationId },
  };
}

/**
 * @param {{programId: string, offset?: string|null}} args
 * @returns {Operation}
 */
export function targets({ programId, offset = null }) {
  return {
    operationName: "AllProgramTargets",
    query: `query AllProgramTargets($WHERE: WhereTarget, $OFFSET: TargetId) {
  targets(WHERE: $WHERE, OFFSET: $OFFSET) {
    matches {
      id
      name
      existence
      sidereal { ra { hms } dec { dms } epoch }
    }
    hasMore
  }
}`,
    variables: { WHERE: { program: { id: { EQ: programId } } }, OFFSET: offset },
  };
}

/**
 * Shaped after Explore's ObservationSubquery: the point of the read mix is to make the
 * server do the work it does for a real session, not to fetch the smallest possible row.
 */
function OBSERVATION_FRAGMENT() {
  return `fragment observationFields on Observation {
  id
  title
  subtitle
  existence
  instrument
  observationTime
  observationDuration { seconds }
  posAngleConstraint { mode angle { degrees } }
  targetEnvironment {
    asterism {
      id
      name
      sidereal { ra { hms } dec { dms } epoch }
    }
  }
  constraintSet {
    imageQuality
    cloudExtinction
    skyBackground
    waterVapor
    elevationRange {
      airMass { min max }
      hourAngle { minHours maxHours }
    }
  }
  scienceRequirements {
    exposureTimeMode { signalToNoise { value at { nanometers } } }
    spectroscopy { wavelength { nanometers } resolution focalPlane }
  }
  observingMode {
    gmosNorthLongSlit {
      grating
      filter
      fpu
      centralWavelength { nanometers }
    }
  }
}`;
}

/**
 * Proposals (tests/COVERAGE.md "Proposals"). Three things have to line up before the ODB will
 * accept a submission, and they are why this area needed the standard-user work first:
 *
 *  1. a **Call for Proposals** must exist, and only staff may create one
 *     (`createCallForProposals` is documented "Requires staff access");
 *  2. the proposal's type must match the call's — a queue proposal needs a
 *     REGULAR_SEMESTER call;
 *  3. `partnerSplits` must sum to 100 and `considerForBand3` must not be UNSET.
 *
 * @typedef {{semester: string, activeStart: string, activeEnd: string, deadline: string}} CallWindow
 */

/**
 * A Regular Semester call open to a single partner. Staff-only.
 *
 * @param {Partial<CallWindow>} [window]
 * @returns {Operation}
 */
export function createCallForProposals(window = {}) {
  return {
    operationName: "CreateCallForProposals",
    query: `mutation CreateCallForProposals($input: CreateCallForProposalsInput!) {
  createCallForProposals(input: $input) {
    callForProposals { id semester title existence }
  }
}`,
    variables: {
      input: {
        SET: {
          semester: window.semester ?? TEST_CALL.semester,
          activeStart: window.activeStart ?? TEST_CALL.activeStart,
          activeEnd: window.activeEnd ?? TEST_CALL.activeEnd,
          // The type is what a queue proposal has to match; REGULAR_SEMESTER is the
          // ordinary semester call and the only one a plain queue proposal may target.
          gemini: { type: "REGULAR_SEMESTER" },
          partners: [{ geminiPartner: TEST_CALL.partner }],
          // Must be in the future or a submission is refused as past the deadline.
          submissionDeadlineDefault: window.deadline ?? TEST_CALL.deadline,
        },
      },
    },
  };
}

/**
 * A submittable queue proposal: the call, a TAC category, a 100% partner split and a Band 3
 * decision. Anything missing here surfaces at submission time rather than here, so the
 * fixture sets all of it up front.
 *
 * @param {{programId: string, callId: string, partner?: string, category?: string}} args
 * @returns {Operation}
 */
export function createProposal({ programId, callId, partner, category }) {
  return {
    operationName: "CreateProposal",
    query: `mutation CreateProposal($input: CreateProposalInput!) {
  createProposal(input: $input) {
    proposal {
      category
      call { id semester }
      gemini {
        scienceSubtype
        ... on Queue {
          minPercentTime
          considerForBand3
          partnerSplits { partner percent }
        }
      }
    }
  }
}`,
    variables: {
      input: {
        programId,
        SET: {
          category: category ?? TEST_CALL.category,
          callId,
          explicitTimeRequest: { hours: TEST_CALL.timeRequestHours },
          gemini: {
            queue: {
              minPercentTime: 100,
              considerForBand3: "DO_NOT_CONSIDER",
              partnerSplits: [{ partner: partner ?? TEST_CALL.partner, percent: 100 }],
            },
          },
        },
      },
    },
  };
}

/**
 * Give a program an abstract — Explore's proposal validation reads it from the program's
 * `description` and refuses to submit without one ("Abstract is required.",
 * `explore/model/Proposal.scala`).
 *
 * @param {{programId: string, description: string}} args
 * @returns {Operation}
 */
export function setProgramDescription({ programId, description }) {
  return {
    operationName: "SetProgramDescription",
    query: `mutation SetProgramDescription($input: UpdateProgramsInput!) {
  updatePrograms(input: $input) {
    programs { id description }
  }
}`,
    variables: {
      input: {
        SET: { description },
        WHERE: { id: { EQ: programId } },
      },
    },
  };
}

/**
 * An observation's workflow state, with the reasons it is not further along.
 *
 * The ODB refuses a submission whose proposal "contains undefined observations", so a
 * proposal fixture has to wait for its observation to leave `UNDEFINED` — which happens once
 * the observation has a target, a configuration and everything else the ODB validates.
 * `validationErrors` is why this returns more than the state: when it does *not* advance, the
 * messages say what is missing, which is the difference between a five-second fix and an
 * afternoon.
 *
 * @param {{observationId: string}} args
 * @returns {Operation}
 */
export function observationWorkflow({ observationId }) {
  return {
    operationName: "ObservationWorkflow",
    query: `query ObservationWorkflow($observationId: ObservationId!) {
  observation(observationId: $observationId) {
    id
    workflow {
      calculationState
      value {
        state
        validationErrors { code messages }
      }
    }
  }
}`,
    variables: { observationId },
  };
}

/**
 * Affiliate a program's PI with a Gemini partner.
 *
 * Not cosmetic, and not obvious: Explore derives the call's submission deadline from the PI's
 * partner, and `ProposalSubmissionBar.scala` computes
 * `isDueDeadline = deadline.forall(_ < now)` — where `forall` on an empty Option is **true**.
 * So a PI with no partner has no deadline, which reads as "deadline passed" and leaves both
 * Submit and Retract disabled, with the UI hint "Select PI's partner to show CfP deadline".
 * A fabricated standard user has no partner (`role_ngo` is NULL for a `pi` role), no
 * educational status and no affiliation, and the odb refuses to submit a proposal unless every
 * investigator has all three — the partner since the beginning, the other two since
 * 2026-09-10 ("Every investigator must have an educational status / an affiliation"). A
 * proposal test sets them all in one update so that the only rule left unsatisfied is the
 * one it means to test.
 *
 * @param {{programId: string, partner?: string, educationalStatus?: string, affiliation?: string}} args
 * @returns {Operation}
 */
export function setProgramUserDetails({ programId, partner, educationalStatus, affiliation }) {
  return {
    operationName: "SetProgramUserDetails",
    query: `mutation SetProgramUserDetails($input: UpdateProgramUsersInput!) {
  updateProgramUsers(input: $input) {
    programUsers { id role }
  }
}`,
    variables: {
      input: {
        SET: {
          partnerLink: { geminiPartner: partner ?? TEST_CALL.partner },
          educationalStatus: educationalStatus ?? "PHD",
          affiliation: affiliation ?? "gpp-tests (fabricated investigator)",
        },
        WHERE: {
          program: { id: { EQ: programId } },
          role: { EQ: "PI" },
        },
      },
    },
  };
}

/**
 * The proposal as the UI and the read-backs see it: status, reference and the splits.
 * `reference` is null until a submission assigns one, which is the strongest available
 * evidence that a submit actually took.
 *
 * @param {{programId: string}} args
 * @returns {Operation}
 */
export function proposalDetails({ programId }) {
  return {
    operationName: "ProposalDetails",
    query: `query ProposalDetails($programId: ProgramId!) {
  program(programId: $programId) {
    id
    proposalStatus
    proposal {
      reference { label }
      category
      explicitTimeRequest { hours }
      call { id semester }
      gemini {
        scienceSubtype
        ... on Queue {
          minPercentTime
          considerForBand3
          partnerSplits { partner percent }
        }
      }
    }
  }
}`,
    variables: { programId },
  };
}

/**
 * Submit or retract, by API. The spec drives both through Explore's buttons; this is here so
 * a failure can be bisected — if the mutation succeeds and the button does not, the bug is in
 * the UI leg rather than in the fixture.
 *
 * @param {{programId: string, status: "NOT_SUBMITTED"|"SUBMITTED"|"ACCEPTED"|"NOT_ACCEPTED"}} args
 * @returns {Operation}
 */
export function setProposalStatus({ programId, status }) {
  return {
    operationName: "SetProposalStatus",
    query: `mutation SetProposalStatus($input: SetProposalStatusInput!) {
  setProposalStatus(input: $input) {
    program { id proposalStatus }
  }
}`,
    variables: { input: { programId, status } },
  };
}

// ---------------------------------------------------------------------------
// Execution: the ODB traffic one Observe server instance produces (ticket 021)
// ---------------------------------------------------------------------------
//
// Documents mirror `observe/server/src/clue/scala/observe/common/EventsGQL.scala` and
// `ObsQueriesGQL.scala` on gemini-hlsw/lucuma-apps main (2026-10-02): same inputs, same
// selections (named here, where Observe's are anonymous). Service-role only — the execution
// mutations are refused for guests and PIs — so `tools/verify-operations.js` replays them
// under `ODB_SERVICE_JWT` when it has one, and the k6 execution VU is the consumer.
//
// `idempotencyKey` is a fresh UUID per mutation, and the same value also travels in the
// `Idempotency-Key` HTTP header, which is what lets Observe's http4s client retry a timed-out
// mutation without double-recording (OdbCommandsImpl.addIdempotencyKey). Callers mint it, so
// this module stays pure. `clientTime` is the moment the event happened at the telescope, ISO
// 8601; the ODB falls back to its own receipt time when it is omitted.

/**
 * Open a visit for an observation. Observe does this at the first Start after a load, and
 * blocks on it — nothing about the visit can be recorded until the id comes back.
 *
 * @param {{observationId: string, idempotencyKey: string, clientTime?: string}} args
 * @returns {Operation}
 */
export function recordVisit({ observationId, idempotencyKey, clientTime }) {
  return {
    operationName: "RecordVisit",
    query: `mutation RecordVisit($input: RecordVisitInput!) {
  recordVisit(input: $input) {
    visit { id }
  }
}`,
    variables: { input: { observationId, idempotencyKey, clientTime } },
  };
}

/**
 * A sequence-level event: START once per visit, CONTINUE when the next step loads, PAUSE at an
 * acquisition hand-off or a breakpoint, STOP and ABORT off the normal path.
 *
 * @param {{visitId: string, command: "START"|"CONTINUE"|"PAUSE"|"STOP"|"ABORT", idempotencyKey: string, clientTime?: string}} args
 * @returns {Operation}
 */
export function addSequenceEvent({ visitId, command, idempotencyKey, clientTime }) {
  return {
    operationName: "AddSequenceEvent",
    query: `mutation AddSequenceEvent($input: AddSequenceEventInput!) {
  addSequenceEvent(input: $input) {
    event { id recordedTime }
  }
}`,
    variables: { input: { visitId, command, idempotencyKey, clientTime } },
  };
}

/** The six step stages Observe emits for every step, in order. */
export const STEP_STAGES = /** @type {const} */ ([
  "START_STEP",
  "START_CONFIGURE",
  "END_CONFIGURE",
  "START_OBSERVE",
  "END_OBSERVE",
  "END_STEP",
]);

/**
 * A step-stage event. The first one recorded for a step (START_STEP) is what creates the
 * step's execution record, and the ODB refuses `recordDataset` until it exists — Observe
 * waits for that acknowledgement, and nothing else, before recording the dataset.
 *
 * @param {{visitId: string, stepId: string, stepStage: string, idempotencyKey: string, clientTime?: string}} args
 * @returns {Operation}
 */
export function addStepEvent({ visitId, stepId, stepStage, idempotencyKey, clientTime }) {
  return {
    operationName: "AddStepEvent",
    query: `mutation AddStepEvent($input: AddStepEventInput!) {
  addStepEvent(input: $input) {
    event { id }
  }
}`,
    variables: { input: { visitId, stepId, stepStage, idempotencyKey, clientTime } },
  };
}

/**
 * Record the dataset a step is about to expose. Synchronous in Observe: the dataset id is
 * needed for every dataset event, and the reference label goes into the FITS headers.
 *
 * `filename` follows lucuma-core's `Dataset.Filename`: site letter, `uuuuMMdd`, `S`, an index
 * of at least four digits, `.fits` — e.g. `N20261003S0042.fits`. The ODB keeps filenames unique.
 *
 * @param {{visitId: string, stepId: string, filename: string, idempotencyKey: string}} args
 * @returns {Operation}
 */
export function recordDataset({ visitId, stepId, filename, idempotencyKey }) {
  return {
    operationName: "RecordDataset",
    query: `mutation RecordDataset($input: RecordDatasetInput!) {
  recordDataset(input: $input) {
    dataset { id reference { label } }
  }
}`,
    variables: { input: { visitId, stepId, filename, idempotencyKey } },
  };
}

/** The six dataset stages Observe emits for every dataset, in order. */
export const DATASET_STAGES = /** @type {const} */ ([
  "START_EXPOSE",
  "END_EXPOSE",
  "START_READOUT",
  "END_READOUT",
  "START_WRITE",
  "END_WRITE",
]);

/**
 * A dataset-stage event. START_EXPOSE goes out right after `recordDataset`; the other five
 * are sent back-to-back once the exposure ends (ObserveActions.scala).
 *
 * @param {{datasetId: string, datasetStage: string, idempotencyKey: string, clientTime?: string}} args
 * @returns {Operation}
 */
export function addDatasetEvent({ datasetId, datasetStage, idempotencyKey, clientTime }) {
  return {
    operationName: "AddDatasetEvent",
    query: `mutation AddDatasetEvent($input: AddDatasetEventInput!) {
  addDatasetEvent(input: $input) {
    event { id }
  }
}`,
    variables: { input: { datasetId, datasetStage, idempotencyKey, clientTime } },
  };
}

/**
 * The fields of one GMOS step as Observe's `ExecutionConfigSubquery` reads them, minus the
 * fields that only matter to a real instrument. What stays is what sizes the payload:
 * instrument, step and telescope configuration plus the estimate.
 */
const GMOS_STEP_FIELDS = `id
      breakpoint
      observeClass
      estimate { total { seconds } }
      instrumentConfig {
        exposure { seconds }
        readout { xBin yBin ampCount ampGain ampReadMode }
        dtax
        roi
        gratingConfig { grating order wavelength { nanometers } }
        filter
        fpu { builtin customMask { slitWidth } }
        centralWavelength { nanometers }
      }
      stepConfig {
        stepType
        ... on Gcal { continuum arcs filter diffuser shutter }
        ... on SmartGcal { smartGcalType }
      }
      telescopeConfig { offset { p { arcseconds } q { arcseconds } } guiding }`;

const GMOS_SEQUENCE_FIELDS = `nextAtom { id description observeClass steps { ${GMOS_STEP_FIELDS} } }
    possibleFuture { id description observeClass steps { ${GMOS_STEP_FIELDS} } }
    hasMore`;

/**
 * The execution config Observe reads before the first step and again after every step
 * (`ObsExecutionQuery`): the next atom and the possible future of both sequences. Observe
 * reads it over the websocket with `futureLimit: 100`, and the engine stalls until it answers.
 *
 * The ODB returns `null` with a `sequence_unavailable` error while the sequence cannot yet be
 * generated (ITC and obscalc still working), so a fresh observation needs polling.
 *
 * GMOS North and South only, matching the executable seed; other instruments return the
 * `instrument` field and empty branches.
 *
 * @param {{observationId: string, futureLimit?: number}} args
 * @returns {Operation}
 */
export function executionConfig({ observationId, futureLimit = 100 }) {
  return {
    operationName: "ExecutionConfig",
    query: `query ExecutionConfig($observationId: ObservationId!, $futureLimit: NonNegInt!) {
  executionConfig(observationId: $observationId, futureLimit: $futureLimit) {
    instrument
    gmosNorth {
      static { stageMode detector mosPreImaging }
      acquisition { ${GMOS_SEQUENCE_FIELDS} }
      science { ${GMOS_SEQUENCE_FIELDS} }
    }
    gmosSouth {
      static { stageMode detector mosPreImaging }
      acquisition { ${GMOS_SEQUENCE_FIELDS} }
      science { ${GMOS_SEQUENCE_FIELDS} }
    }
  }
}`,
    variables: { observationId, futureLimit },
  };
}

// ---------------------------------------------------------------------------
// Subscriptions: what an open Explore tab and a loaded Observe browser hold (ticket 022)
// ---------------------------------------------------------------------------
//
// Mirrors gemini-hlsw/lucuma-apps main (2026-10-03). Explore's program cache
// (`explore/cache/ProgramCacheController.scala`) opens eight subscriptions for the current
// program: two `programEdit` (details, attachments), `observationEdit`, `targetEdit`,
// `groupEdit`, `configurationRequestEdit`, `programEdit` again for the program list, and
// `obscalcUpdate`. The sequence tile adds `executionEventAdded` (STEP) and `datasetEdit` for the
// selected observation (`queries/common/ObsQueriesGQL.scala`); Observe's browser holds
// `observationEdit` and `datasetEdit` for the loaded one (`observe/queries/ObsQueriesGQL.scala`).
// Selections are shaped after Explore's subqueries, trimmed where they would dwarf the event.
// Sent over graphql-transport-ws by `k6/lib/graphql-ws.js`; never over HTTP.

/**
 * @param {{programId: string}} args
 * @returns {Operation}
 */
export function programEditDetails({ programId }) {
  return {
    operationName: "ProgramEditDetails",
    query: `subscription ProgramEditDetails($input: ProgramEditInput!) {
  programEdit(input: $input) {
    editType
    value {
      id
      name
      description
      type
      existence
      proposalStatus
      pi { user { id } }
      reference { label }
    }
  }
}`,
    variables: { input: { programId } },
  };
}

/**
 * @param {{programId: string}} args
 * @returns {Operation}
 */
export function programEditAttachments({ programId }) {
  return {
    operationName: "ProgramEditAttachments",
    query: `subscription ProgramEditAttachments($input: ProgramEditInput!) {
  programEdit(input: $input) {
    editType
    value {
      id
      attachments { id attachmentType fileName checked fileSize updatedAt }
    }
  }
}`,
    variables: { input: { programId } },
  };
}

/**
 * Explore's program list delta: the third `programEdit` an open tab holds.
 * @param {{programId: string}} args
 * @returns {Operation}
 */
export function programEditInfo({ programId }) {
  return {
    operationName: "ProgramEditInfo",
    query: `subscription ProgramEditInfo($input: ProgramEditInput!) {
  programEdit(input: $input) {
    editType
    value { id name existence proposalStatus type }
  }
}`,
    variables: { input: { programId } },
  };
}

/**
 * Every observation edit in the program, with the observation as Explore reads it. This is the
 * subscription the Explore-tab subscriber measures its round trip on.
 * @param {{programId: string}} args
 * @returns {Operation}
 */
export function programObservationsDelta({ programId }) {
  return {
    operationName: "ProgramObservationsDelta",
    query: `subscription ProgramObservationsDelta($input: ObservationEditInput!) {
  observationEdit(input: $input) {
    editType
    observationId
    value {
      ...observationFields
    }
  }
}

${OBSERVATION_FRAGMENT()}`,
    variables: { input: { programId } },
  };
}

/**
 * @param {{programId: string}} args
 * @returns {Operation}
 */
export function programTargetsDelta({ programId }) {
  return {
    operationName: "ProgramTargetsDelta",
    query: `subscription ProgramTargetsDelta($input: TargetEditInput!) {
  targetEdit(input: $input) {
    editType
    targetId
    value {
      id
      name
      existence
      sidereal { ra { hms } dec { dms } epoch }
    }
  }
}`,
    variables: { input: { programId } },
  };
}

/**
 * @param {{programId: string}} args
 * @returns {Operation}
 */
export function programGroupsDelta({ programId }) {
  return {
    operationName: "ProgramGroupsDelta",
    query: `subscription ProgramGroupsDelta($input: GroupEditInput!) {
  groupEdit(input: $input) {
    editType
    groupId
    value { id name parentId parentIndex minimumRequired ordered }
  }
}`,
    variables: { input: { programId } },
  };
}

/**
 * @param {{programId: string}} args
 * @returns {Operation}
 */
export function programConfigurationRequestsDelta({ programId }) {
  return {
    operationName: "ProgramConfigurationRequestsDelta",
    query: `subscription ProgramConfigurationRequestsDelta($input: ConfigurationRequestEditInput!) {
  configurationRequestEdit(input: $input) {
    editType
    configurationRequestId
    configurationRequest { id status }
  }
}`,
    variables: { input: { programId } },
  };
}

/**
 * obscalc's results arriving: the subscription that turns Explore's spinners into numbers.
 * @param {{programId: string}} args
 * @returns {Operation}
 */
export function obscalcUpdates({ programId }) {
  return {
    operationName: "ObscalcUpdates",
    query: `subscription ObscalcUpdates($input: ObscalcUpdateInput!) {
  obscalcUpdate(input: $input) {
    editType
    observationId
    oldCalculationState
    newCalculationState
    value {
      id
      workflow { calculationState value { state } }
      execution {
        digest {
          calculationState
          value { estimate { total { total { seconds } } } science { atomCount } }
        }
      }
    }
  }
}`,
    variables: { input: { programId } },
  };
}

/**
 * One observation's edits, as Observe's browser holds it for the loaded observation. The
 * Observe-browser subscriber measures its round trip on this one.
 * @param {{observationId: string}} args
 * @returns {Operation}
 */
export function observationEdits({ observationId }) {
  return {
    operationName: "ObservationEdits",
    query: `subscription ObservationEdits($input: ObservationEditInput!) {
  observationEdit(input: $input) {
    editType
    observationId
    value { id subtitle }
  }
}`,
    variables: { input: { observationId } },
  };
}

/**
 * @param {{observationId: string}} args
 * @returns {Operation}
 */
export function datasetEdits({ observationId }) {
  return {
    operationName: "DatasetEdits",
    query: `subscription DatasetEdits($input: DatasetEditInput!) {
  datasetEdit(input: $input) {
    editType
    datasetId
    value { id filename qaState isWritten }
  }
}`,
    variables: { input: { observationId } },
  };
}

/**
 * Step events for one observation, as the sequence tile follows execution.
 * @param {{observationId: string}} args
 * @returns {Operation}
 */
export function stepEventsAdded({ observationId }) {
  return {
    operationName: "StepEventsAdded",
    query: `subscription StepEventsAdded($input: ExecutionEventAddedInput!) {
  executionEventAdded(input: $input) {
    value {
      id
      eventType
      ... on StepEvent { stepStage step { id } }
    }
  }
}`,
    variables: { input: { observationId, eventType: { EQ: "STEP" } } },
  };
}

/**
 * Read/write classification driving the 60/40 load mix (spec §6) and the separate
 * read/mutation latency thresholds. Subscriptions are their own kind: held open on a socket,
 * never timed as a request (ticket 022).
 * @type {Record<string, "read"|"write"|"subscription">}
 */
export const OPERATION_KIND = {
  CreateProgram: "write",
  CreateTarget: "write",
  CreateObservation: "write",
  UpdateObservationSubtitle: "write",
  UpdateTargetToTestTarget: "write",
  SetObservingMode: "write",
  AllPrograms: "read",
  ProgramDetails: "read",
  AllProgramObservations: "read",
  ObservationReadBack: "read",
  ObservationCalculated: "read",
  ObservationMode: "read",
  AllProgramTargets: "read",
  CreateCallForProposals: "write",
  CreateProposal: "write",
  SetProposalStatus: "write",
  ProposalDetails: "read",
  SetProgramUserDetails: "write",
  ObservationWorkflow: "read",
  SetProgramDescription: "write",
  RecordVisit: "write",
  AddSequenceEvent: "write",
  AddStepEvent: "write",
  RecordDataset: "write",
  AddDatasetEvent: "write",
  ExecutionConfig: "read",
  ProgramEditDetails: "subscription",
  ProgramEditAttachments: "subscription",
  ProgramEditInfo: "subscription",
  ProgramObservationsDelta: "subscription",
  ProgramTargetsDelta: "subscription",
  ProgramGroupsDelta: "subscription",
  ProgramConfigurationRequestsDelta: "subscription",
  ObscalcUpdates: "subscription",
  ObservationEdits: "subscription",
  DatasetEdits: "subscription",
  StepEventsAdded: "subscription",
};
