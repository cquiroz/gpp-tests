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
  name: "GPP Test Star (odbattr)",
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
 * @param {{programId: string, name?: string}} args
 * @returns {Operation}
 */
export function createTarget({ programId, name }) {
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
        SET: { ...TEST_TARGET, name: name ?? TEST_TARGET.name },
      },
    },
  };
}

/**
 * @param {{programId: string, targetIds?: string[], subtitle?: string, observingMode?: Record<string, unknown>}} args
 * @returns {Operation}
 */
export function createObservation({
  programId,
  targetIds,
  subtitle,
  observingMode,
}) {
  /** @type {Record<string, unknown>} */
  const SET = {};
  if (subtitle) SET.subtitle = subtitle;
  if (targetIds?.length) SET.targetEnvironment = { asterism: targetIds };
  if (observingMode) {
    SET.observingMode = observingMode;
    SET.scienceRequirements = spectroscopyRequirements();
  }

  return {
    operationName: "CreateObservation",
    query: `mutation CreateObservation($input: CreateObservationInput!) {
  createObservation(input: $input) {
    observation { id title subtitle }
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
 * A fabricated standard user has no affiliation (`role_ngo` is NULL for a `pi` role), so a
 * proposal test has to set one.
 *
 * @param {{programId: string, partner?: string}} args
 * @returns {Operation}
 */
export function setProgramUserPartner({ programId, partner }) {
  return {
    operationName: "SetProgramUserPartner",
    query: `mutation SetProgramUserPartner($input: UpdateProgramUsersInput!) {
  updateProgramUsers(input: $input) {
    programUsers { id role }
  }
}`,
    variables: {
      input: {
        SET: { partnerLink: { geminiPartner: partner ?? TEST_CALL.partner } },
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

/**
 * Read/write classification driving the 60/40 load mix (spec §6) and the separate
 * read/mutation latency thresholds.
 * @type {Record<string, "read"|"write">}
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
  AllProgramTargets: "read",
  CreateCallForProposals: "write",
  CreateProposal: "write",
  SetProposalStatus: "write",
  ProposalDetails: "read",
  SetProgramUserPartner: "write",
  ObservationWorkflow: "read",
  SetProgramDescription: "write",
};
