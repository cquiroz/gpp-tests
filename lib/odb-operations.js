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

/** Central wavelength shared by the observing mode and the science requirements. */
const CENTRAL_WAVELENGTH = { nanometers: 500 };

/**
 * A minimal, valid GMOS North long-slit configuration (spec §5 scenario 3).
 * @param {{grating?: string, filter?: string, fpu?: string, centralWavelength?: Record<string, number>}} [overrides]
 */
export function gmosNorthLongSlit(overrides = {}) {
  return {
    gmosNorthLongSlit: {
      grating: overrides.grating ?? "R831_G5302",
      filter: overrides.filter ?? "R_PRIME",
      fpu: overrides.fpu ?? "LONG_SLIT_0_50",
      centralWavelength: overrides.centralWavelength ?? CENTRAL_WAVELENGTH,
    },
  };
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
};
