import { readFileSync } from "node:fs";
import { buildSchema, graphql } from "graphql";
import { beforeAll, describe, expect, it } from "vitest";
import {
  OPERATION_KIND,
  TEST_TARGET,
  createObservation,
  createProgram,
  createTarget,
  gmosNorthLongSlit,
  observation,
  observationCalculated,
  observations,
  programDetails,
  programs,
  setObservingMode,
  targets,
  updateObservationSubtitle,
  updateTargetToTestTarget,
} from "./odb-operations.js";

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

const ALL_OPERATIONS = [
  createProgram({ name: "odbattr program" }),
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
];

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
    expect(createProgram({ name: "odbattr program" }).variables).toEqual({
      input: { SET: { name: "odbattr program" } },
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
      expect(["read", "write"]).toContain(OPERATION_KIND[op.operationName]);
    }
    expect(OPERATION_KIND.CreateProgram).toBe("write");
    expect(OPERATION_KIND.AllPrograms).toBe("read");
  });
});
