import { readFileSync } from "node:fs";
import { buildSchema, graphql } from "graphql";
import { beforeAll, describe, expect, it } from "vitest";
import {
  OPERATION_KIND,
  TEST_CALL,
  TEST_TARGET,
  createCallForProposals,
  createObservation,
  createProgram,
  createProposal,
  createTarget,
  gmosNorthLongSlit,
  observation,
  observationCalculated,
  observationWorkflow,
  observations,
  programDetails,
  programs,
  proposalDetails,
  setObservingMode,
  setProgramDescription,
  setProgramUserDetails,
  setProposalStatus,
  targets,
  updateObservationSubtitle,
  updateTargetToTestTarget,
  observationMode,
  recordVisit,
  addSequenceEvent,
  addStepEvent,
  recordDataset,
  addDatasetEvent,
  executionConfig,
  STEP_STAGES,
  DATASET_STAGES,
  programEditDetails,
  programEditAttachments,
  programEditInfo,
  programObservationsDelta,
  programTargetsDelta,
  programGroupsDelta,
  programConfigurationRequestsDelta,
  obscalcUpdates,
  observationEdits,
  datasetEdits,
  stepEventsAdded,
} from "./odb-operations.js";
import {
  MODE_TARGETS,
  OBSERVING_MODES,
  fixtureProblems,
} from "./observing-modes.js";

/** @type {import('graphql').GraphQLSchema} */
let schema;

beforeAll(() => {
  // Vendored snapshot of lucuma-odb's OdbSchema.graphql — see schema/README.md.
  const sdl = readFileSync(
    new URL("../schema/OdbSchema.graphql", import.meta.url),
    "utf8",
  );
  // The SDL uses @oneOf without declaring it, so skip SDL validation.
  schema = buildSchema(sdl, { assumeValidSDL: true });
});

/**
 * Run an operation through graphql-js with no resolvers: this performs document
 * validation *and* real variable coercion against the ODB schema, so a typo in a field
 * name, an invalid enum value or a malformed input object fails here rather than on a
 * live stack at 07:00 UTC. Without resolvers every field resolves to undefined, so the
 * only errors we tolerate are the resulting non-null complaints.
 *
 * @param {{operationName: string, query: string, variables: Record<string, unknown>}} op
 */
async function schemaErrors(op) {
  const result = await graphql({
    schema,
    source: op.query,
    variableValues: op.variables,
  });
  return (result.errors ?? [])
    .map((e) => e.message)
    .filter((m) => !m.startsWith("Cannot return null for non-nullable field"));
}

// The execution VU's documents (ticket 021), with the per-mutation idempotency key and client
// time that Observe sends — every stage of every enum, so a renamed stage fails here.
const KEY = "4b3e1b1e-5d1d-4d6c-9c1f-2c9f6b1a7e10";
const AT = "2026-10-03T03:00:00.000Z";
const EXECUTION_OPERATIONS = [
  recordVisit({ observationId: "o-300", idempotencyKey: KEY, clientTime: AT }),
  recordVisit({ observationId: "o-300", idempotencyKey: KEY }),
  .../** @type {const} */ (["START", "CONTINUE", "PAUSE", "STOP", "ABORT"]).map((command) =>
    addSequenceEvent({ visitId: "v-100", command, idempotencyKey: KEY, clientTime: AT }),
  ),
  ...STEP_STAGES.map((stepStage) =>
    addStepEvent({
      visitId: "v-100",
      stepId: "s-e6429613-f117-367b-a06c-15fde59eba8f",
      stepStage,
      idempotencyKey: KEY,
      clientTime: AT,
    }),
  ),
  recordDataset({
    visitId: "v-100",
    stepId: "s-e6429613-f117-367b-a06c-15fde59eba8f",
    filename: "N20261003S0042.fits",
    idempotencyKey: KEY,
  }),
  ...DATASET_STAGES.map((datasetStage) =>
    addDatasetEvent({ datasetId: "d-100", datasetStage, idempotencyKey: KEY, clientTime: AT }),
  ),
  executionConfig({ observationId: "o-300" }),
  executionConfig({ observationId: "o-300", futureLimit: 0 }),
];

// The eleven subscriptions an Explore tab and an Observe browser hold (ticket 022).
const SUBSCRIPTION_OPERATIONS = [
  programEditDetails({ programId: "p-100" }),
  programEditAttachments({ programId: "p-100" }),
  programEditInfo({ programId: "p-100" }),
  programObservationsDelta({ programId: "p-100" }),
  programTargetsDelta({ programId: "p-100" }),
  programGroupsDelta({ programId: "p-100" }),
  programConfigurationRequestsDelta({ programId: "p-100" }),
  obscalcUpdates({ programId: "p-100" }),
  observationEdits({ observationId: "o-300" }),
  datasetEdits({ observationId: "o-300" }),
  stepEventsAdded({ observationId: "o-300" }),
];

const ALL_OPERATIONS = [
  createProgram({ name: "gpp-tests program" }),
  createProgram({}),
  createTarget({ programId: "p-100" }),
  createObservation({ programId: "p-100" }),
  createObservation({
    programId: "p-100",
    targetIds: ["t-200"],
    subtitle: "scenario-3",
    observingMode: gmosNorthLongSlit(),
  }),
  updateObservationSubtitle({ observationId: "o-300", subtitle: "edited" }),
  updateTargetToTestTarget({ targetId: "t-200" }),
  setObservingMode({ observationId: "o-300", observingMode: gmosNorthLongSlit() }),
  programs({}),
  programs({ offset: "p-100", includeDeleted: true }),
  programDetails({ programId: "p-100" }),
  observations({ programId: "p-100" }),
  observations({ programId: "p-100", offset: "o-300" }),
  observation({ observationId: "o-300" }),
  observationCalculated({ observationId: "o-300" }),
  targets({ programId: "p-100" }),
  createCallForProposals(),
  createProposal({ programId: "p-100", callId: "c-400" }),
  proposalDetails({ programId: "p-100" }),
  setProposalStatus({ programId: "p-100", status: "SUBMITTED" }),
  setProgramUserDetails({ programId: "p-100" }),
  observationWorkflow({ observationId: "o-300" }),
  setProgramDescription({ programId: "p-100", description: "abstract" }),
  observationMode({ observationId: "o-300" }),
  ...EXECUTION_OPERATIONS,
  ...SUBSCRIPTION_OPERATIONS,
];

// Every observing-mode fixture, both as k6 sends it (mode + requirements) and as the browser
// seeds it (requirements only), plus each target family.
/** @type {[string, import("./odb-operations.js").Operation][]} */
const MODE_OPERATIONS = [
  ...OBSERVING_MODES.flatMap((m) => /** @type {[string, import("./odb-operations.js").Operation][]} */ ([
    [
      `${m.key} (k6)`,
      createObservation({
        programId: "p-100",
        targetIds: ["t-200"],
        observingMode: m.observingMode,
        scienceRequirements: m.scienceRequirements,
      }),
    ],
    [
      `${m.key} (browser seed)`,
      createObservation({
        programId: "p-100",
        targetIds: ["t-200"],
        scienceRequirements: m.scienceRequirements,
      }),
    ],
  ])),
  ...Object.entries(MODE_TARGETS).map(
    ([family, target]) =>
      /** @type {[string, import("./odb-operations.js").Operation]} */ ([
        `target ${family}`,
        createTarget({ programId: "p-100", target }),
      ]),
  ),
];

describe("every observing-mode fixture is valid against the ODB schema", () => {
  it.each(MODE_OPERATIONS)("%s", async (_name, op) => {
    expect(await schemaErrors(op)).toEqual([]);
  });

  it("is structurally sound", () => {
    expect(fixtureProblems(OBSERVING_MODES)).toEqual([]);
  });
});

describe("every operation is valid against the ODB schema", () => {
  it.each(ALL_OPERATIONS.map((op) => [op.operationName, op]))(
    "%s",
    async (_name, op) => {
      expect(await schemaErrors(op)).toEqual([]);
    },
  );

  it("names every operation (k6 tags and Tempo lookups key off it)", () => {
    for (const op of ALL_OPERATIONS) {
      expect(op.operationName).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
      expect(op.query).toContain(op.operationName);
    }
  });
});

describe("createProgram", () => {
  it("passes a name when given one", () => {
    expect(createProgram({ name: "gpp-tests program" }).variables).toEqual({
      input: { SET: { name: "gpp-tests program" } },
    });
  });

  it("sends SET: null when unnamed, like Explore's own create button", () => {
    // `name: ""` is rejected (NonEmptyString); Explore passes SET = null.
    expect(createProgram({}).variables).toEqual({ input: { SET: null } });
  });
});

describe("createTarget", () => {
  it("always supplies the four fields the ODB requires on creation", () => {
    const { variables } = createTarget({ programId: "p-100" });
    const set = /** @type {any} */ (variables).input.SET;

    expect(set.name).toBe(TEST_TARGET.name);
    expect(set.sidereal.ra).toBeDefined();
    expect(set.sidereal.dec).toBeDefined();
    expect(set.sidereal.epoch).toBe("J2000.000");
    expect(set.sourceProfile).toBeDefined();
  });

  it("uses hardcoded coordinates — no Simbad in v1", () => {
    const json = JSON.stringify(createTarget({ programId: "p-100" }));
    expect(json.toLowerCase()).not.toContain("simbad");
    expect(TEST_TARGET.sidereal.ra).toEqual({ hms: "05:34:31.940" });
  });

  it("carries a brightness so the ITC has something to compute from", () => {
    const set = /** @type {any} */ (
      createTarget({ programId: "p-100" }).variables
    ).input.SET;
    const brightnesses = set.sourceProfile.point.bandNormalized.brightnesses;
    expect(brightnesses.length).toBeGreaterThan(0);
    expect(brightnesses[0]).toMatchObject({ band: "R", units: "VEGA_MAGNITUDE" });
  });

  it("suffixes the name per VU/iteration when asked, keeping names distinguishable", () => {
    const set = /** @type {any} */ (
      createTarget({ programId: "p-100", name: "star-7" }).variables
    ).input.SET;
    expect(set.name).toBe("star-7");
  });
});

describe("createObservation", () => {
  it("needs only a programId", () => {
    expect(createObservation({ programId: "p-100" }).variables).toEqual({
      input: { programId: "p-100", SET: null },
    });
  });

  it("attaches the asterism, subtitle and observing mode in one call", () => {
    const input = /** @type {any} */ (
      createObservation({
        programId: "p-100",
        targetIds: ["t-200", "t-201"],
        subtitle: "scenario-3",
        observingMode: gmosNorthLongSlit(),
      }).variables
    ).input;

    expect(input.SET.targetEnvironment).toEqual({
      asterism: ["t-200", "t-201"],
    });
    expect(input.SET.subtitle).toBe("scenario-3");
    expect(input.SET.observingMode.gmosNorthLongSlit.fpu).toBe(
      "LONG_SLIT_0_50",
    );
    // Science requirements travel with the mode: without an exposure-time mode the ITC
    // has nothing to solve for, and the calculated-results assertion is the point.
    expect(input.SET.scienceRequirements.exposureTimeMode.signalToNoise)
      .toBeDefined();
  });

  it("lets the observing mode be overridden (GMOS South, other gratings)", () => {
    const mode = gmosNorthLongSlit({ grating: "B1200_G5301", fpu: "LONG_SLIT_1_00" });
    expect(mode.gmosNorthLongSlit).toMatchObject({
      grating: "B1200_G5301",
      fpu: "LONG_SLIT_1_00",
    });
  });

  it("sets no order-blocking filter by default", () => {
    // Verified against the live ITC: an r' filter (~550-700 nm) at the fixture's 500 nm
    // central wavelength blocks the light, and the ITC rejects the observation with
    // "Insufficient signal at 500.0 nm" — no brightness or S/N value rescues it, so the
    // calculated-results assertion could never pass. Unfiltered is also the safer default:
    // it stays valid if the central wavelength is ever changed.
    expect(gmosNorthLongSlit().gmosNorthLongSlit).not.toHaveProperty("filter");
  });

  it("still allows a filter when one is asked for", () => {
    // If you set one, match it to the wavelength — g' for ~500 nm, r' for ~630 nm.
    expect(
      gmosNorthLongSlit({ filter: "G_PRIME" }).gmosNorthLongSlit.filter,
    ).toBe("G_PRIME");
  });
});

describe("updateObservationSubtitle", () => {
  it("targets exactly one observation and reads the subtitle back in the result", () => {
    const op = updateObservationSubtitle({
      observationId: "o-300",
      subtitle: "edited",
    });
    expect(op.variables).toEqual({
      input: { SET: { subtitle: "edited" }, WHERE: { id: { EQ: "o-300" } } },
    });
    expect(op.query).toContain("subtitle");
  });
});

describe("updateTargetToTestTarget", () => {
  // The browser journey creates its target through Explore's "Empty Sidereal Target"
  // action, which lands with placeholder coordinates and no brightness; this turns that
  // placeholder into the v1 fixture so the ITC has something to compute from.
  it("writes the v1 coordinates, epoch and brightness onto an existing target", () => {
    const input = /** @type {any} */ (
      updateTargetToTestTarget({ targetId: "t-200" }).variables
    ).input;

    expect(input.WHERE).toEqual({ id: { EQ: "t-200" } });
    expect(input.SET.sidereal).toEqual(TEST_TARGET.sidereal);
    expect(input.SET.sourceProfile).toEqual(TEST_TARGET.sourceProfile);
    expect(input.SET.name).toBe(TEST_TARGET.name);
  });
});

describe("setObservingMode", () => {
  it("attaches the mode and the science requirements to one observation", () => {
    const input = /** @type {any} */ (
      setObservingMode({
        observationId: "o-300",
        observingMode: gmosNorthLongSlit(),
      }).variables
    ).input;

    expect(input.WHERE).toEqual({ id: { EQ: "o-300" } });
    expect(input.SET.observingMode.gmosNorthLongSlit.grating).toBe("R831_G5302");
    expect(input.SET.scienceRequirements.exposureTimeMode).toBeDefined();
  });
});

describe("read operations", () => {
  it("mirrors Explore's programs query (paged, includeDeleted)", () => {
    expect(programs({ offset: "p-100", includeDeleted: true }).variables).toEqual(
      { OFFSET: "p-100", includeDeleted: true },
    );
    // Explore always asks for deleted programs in the Proposals & Programs dialog.
    expect(programs({}).variables).toEqual({
      OFFSET: null,
      includeDeleted: true,
    });
  });

  it("pages observations by program, like Explore's drain loop", () => {
    expect(observations({ programId: "p-100", offset: "o-300" }).variables).toEqual(
      { WHERE: { program: { id: { EQ: "p-100" } } }, OFFSET: "o-300" },
    );
  });

  it("asks for the calculated results that prove ITC and obscalc are alive", () => {
    const q = observationCalculated({ observationId: "o-300" }).query;
    expect(q).toContain("workflow");
    expect(q).toContain("digest");
    expect(q).toContain("itcType");
  });
});

describe("OPERATION_KIND", () => {
  it("classifies every operation as a read or a write for the 60/40 load mix", () => {
    for (const op of ALL_OPERATIONS) {
      expect(["read", "write", "subscription"]).toContain(OPERATION_KIND[op.operationName]);
    }
    expect(OPERATION_KIND.CreateProgram).toBe("write");
    expect(OPERATION_KIND.AllPrograms).toBe("read");
  });
});

describe("the proposal fixture", () => {
  it("uses values the schema actually defines", async () => {
    // Semester, Date and Timestamp are custom scalars, so coercion is the only check the
    // schema can give us — but the enums are real, and a typo in a partner or a category
    // would otherwise surface as a live-stack failure at submission time.
    expect(await schemaErrors(createCallForProposals())).toEqual([]);
    expect(await schemaErrors(createProposal({ programId: "p-100", callId: "c-400" }))).toEqual([]);
    expect(TEST_CALL.semester).toMatch(/^\d{4}[AB]$/);
    expect(TEST_CALL.activeStart < TEST_CALL.activeEnd).toBe(true);
  });

  it("classifies the proposal operations for the load mix", () => {
    expect(OPERATION_KIND.CreateProposal).toBe("write");
    expect(OPERATION_KIND.SetProposalStatus).toBe("write");
    expect(OPERATION_KIND.ProposalDetails).toBe("read");
  });
});

describe("the execution operations (ticket 021)", () => {
  it("mirror Observe's call set: one visit, five sequence commands, six step and six dataset stages", () => {
    expect(STEP_STAGES).toEqual([
      "START_STEP",
      "START_CONFIGURE",
      "END_CONFIGURE",
      "START_OBSERVE",
      "END_OBSERVE",
      "END_STEP",
    ]);
    expect(DATASET_STAGES).toEqual([
      "START_EXPOSE",
      "END_EXPOSE",
      "START_READOUT",
      "END_READOUT",
      "START_WRITE",
      "END_WRITE",
    ]);
  });

  it("carry the idempotency key in the variables, where Observe puts it", () => {
    const op = addStepEvent({
      visitId: "v-100",
      stepId: "s-1",
      stepStage: "START_STEP",
      idempotencyKey: KEY,
      clientTime: AT,
    });
    expect(op.variables.input).toEqual({
      visitId: "v-100",
      stepId: "s-1",
      stepStage: "START_STEP",
      idempotencyKey: KEY,
      clientTime: AT,
    });
    // recordDataset has no clientTime in Observe's document either.
    expect(
      recordDataset({ visitId: "v-100", stepId: "s-1", filename: "N20261003S0042.fits", idempotencyKey: KEY })
        .variables.input,
    ).not.toHaveProperty("clientTime");
  });

  it("read the execution config the way Observe does: top-level, futureLimit 100, both GMOS branches", () => {
    const op = executionConfig({ observationId: "o-300" });
    expect(op.variables).toEqual({ observationId: "o-300", futureLimit: 100 });
    expect(op.query).toContain("executionConfig(observationId: $observationId, futureLimit: $futureLimit)");
    expect(op.query).toContain("gmosNorth {");
    expect(op.query).toContain("gmosSouth {");
    expect(op.query).toContain("possibleFuture");
  });

  it("are classified as writes except the config read", () => {
    for (const name of ["RecordVisit", "AddSequenceEvent", "AddStepEvent", "RecordDataset", "AddDatasetEvent"]) {
      expect(OPERATION_KIND[name]).toBe("write");
    }
    expect(OPERATION_KIND.ExecutionConfig).toBe("read");
  });
});

describe("the subscription operations (ticket 022)", () => {
  it("are all subscriptions, classified as such", () => {
    for (const op of SUBSCRIPTION_OPERATIONS) {
      expect(op.query.trimStart().startsWith("subscription ")).toBe(true);
      expect(OPERATION_KIND[op.operationName]).toBe("subscription");
    }
  });

  it("filter by program for the Explore tab and by observation for the Observe browser", () => {
    expect(programObservationsDelta({ programId: "p-100" }).variables).toEqual({
      input: { programId: "p-100" },
    });
    expect(observationEdits({ observationId: "o-300" }).variables).toEqual({
      input: { observationId: "o-300" },
    });
    expect(stepEventsAdded({ observationId: "o-300" }).variables.input).toEqual({
      observationId: "o-300",
      eventType: { EQ: "STEP" },
    });
  });
});
