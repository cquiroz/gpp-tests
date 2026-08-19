import { type Page, expect, test } from "@playwright/test";
import {
  createProgram,
  gmosNorthLongSlit,
  observation as observationQuery,
  observationCalculated,
  observations as observationsQuery,
  programs as programsQuery,
  setObservingMode,
  targets as targetsQuery,
  updateObservationSubtitle,
  updateTargetToTestTarget,
} from "../../lib/odb-operations.js";
import { GuestSession, type OdbClient, eventually } from "../support/odb.js";
import * as ui from "../support/selectors.js";

/**
 * The v1 regression journey (spec §5).
 *
 * One chained guest session: each scenario is a test so that pass/fail and duration are
 * recorded per scenario (spec §7's durable record needs that granularity), and `serial` mode
 * keeps them chained — a failure stops the rest, and a retry re-runs the whole journey from
 * a fresh guest, which is the only meaningful way to retry a chained flow.
 *
 * Every scenario ends with a direct GraphQL read-back as the *same guest*, which is what
 * separates "the backend broke" from "the frontend broke" (ticket 004).
 */

test.describe.configure({ mode: "serial" });

const SUBTITLE = "odbattr scenario-3";
const EDITED_SUBTITLE = "odbattr scenario-4 edited";

let page: Page;
let session: GuestSession;
let odb: OdbClient;

/** Carried between the chained scenarios. */
const journey: {
  programsAtLogin: string[];
  createdProgramId?: string;
  observationId?: string;
  targetId?: string;
} = { programsAtLogin: [] };

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  page = await context.newPage();
  // Attach before the login click: the JWT Explore receives is the one the read-backs use.
  session = GuestSession.watch(page);
  odb = session.client();
});

test.afterAll(async () => {
  await page?.context().close();
});

test("scenario 1: login as guest", async () => {
  await test.step("continue as guest", async () => {
    await page.goto("/");
    await ui.guestLoginButton(page).click();
  });

  await test.step("the logged-in shell renders", async () => {
    // Explore only renders past the spinner once *both* the ODB and the prefs websockets
    // have connected, so this assertion also covers the Hasura service being reachable.
    await expect(ui.obsTreeAddObservationButton(page)).toBeVisible({
      timeout: 120_000,
    });
  });

  await test.step("read back: the auto-created program exists", async () => {
    // On first login with no programs Explore creates one for the guest.
    const data = await odb.run(programsQuery({}));
    const matches = data.programs.matches as { id: string }[];
    expect(matches.length).toBeGreaterThanOrEqual(1);
    journey.programsAtLogin = matches.map((p) => p.id);
  });
});

test("scenario 2: create a program", async () => {
  await test.step("Manage Programs → Proposals & Programs → create", async () => {
    await ui.mainMenuButton(page).click();
    await ui.managePrograms(page).click();
    await expect(ui.programsDialog(page)).toBeVisible();
    await ui.createProgramButton(page).click();
  });

  await test.step("read back: a new program appears in the programs query", async () => {
    journey.createdProgramId = await eventually(
      "the new program to appear in the ODB",
      async () => {
        const data = await odb.run(programsQuery({}));
        const ids = (data.programs.matches as { id: string }[]).map((p) => p.id);
        return ids.find((id) => !journey.programsAtLogin.includes(id));
      },
      { timeoutMs: 30_000, intervalMs: 1_000 },
    );
  });

  await test.step("the UI lists it too", async () => {
    // The dialog closes onto the new program; the obs tree comes back for it.
    await expect(ui.obsTreeAddObservationButton(page)).toBeVisible();
  });
});

test("scenario 3: create an observation with a target and configuration", async () => {
  const programId = journey.createdProgramId!;
  expect(programId, "scenario 2 must have created a program").toBeTruthy();

  await test.step("add an observation from the obs tree", async () => {
    await ui.obsTreeAddObservationButton(page).click();
  });

  await test.step("read back: the observation exists in the new program", async () => {
    journey.observationId = await eventually(
      "the new observation to appear in the ODB",
      async () => {
        const data = await odb.run(observationsQuery({ programId }));
        const matches = data.observations.matches as { id: string }[];
        return matches[0]?.id;
      },
      { timeoutMs: 60_000, intervalMs: 2_000 },
    );
  });

  await test.step("add a manual sidereal target — no catalog lookup", async () => {
    await ui.addTargetButton(page).click();
    await ui.emptySiderealTargetItem(page).click();
  });

  await test.step("read back: the target is in the program and in the asterism", async () => {
    journey.targetId = await eventually(
      "the new target to appear in the ODB",
      async () => {
        const data = await odb.run(targetsQuery({ programId }));
        const matches = data.targets.matches as { id: string }[];
        return matches[0]?.id;
      },
      { timeoutMs: 60_000, intervalMs: 2_000 },
    );

    const observation = await eventually(
      "the target to join the observation's asterism",
      async () => {
        const data = await odb.run(
          observationQuery({ observationId: journey.observationId! }),
        );
        const asterism = data.observation.targetEnvironment.asterism as {
          id: string;
        }[];
        return asterism.some((t) => t.id === journey.targetId)
          ? data.observation
          : undefined;
      },
      { timeoutMs: 60_000, intervalMs: 2_000 },
    );
    expect(observation.targetEnvironment.asterism).toHaveLength(1);
  });

  await test.step("give the target the v1 coordinates and brightness", async () => {
    // Explore's "Empty Sidereal Target" lands with placeholder coordinates and no
    // brightness. The hardcoded v1 fixture is written through the API: typing into the
    // coordinate editor depends on labels that move, and the ITC needs a brightness before
    // it can produce anything for the assertion below.
    const data = await odb.run(
      updateTargetToTestTarget({ targetId: journey.targetId! }),
    );
    expect(data.updateTargets.targets).toHaveLength(1);
    expect(data.updateTargets.targets[0].sidereal.epoch).toBe("J2000.000");
  });

  await test.step("select a minimal GMOS long-slit mode", async () => {
    // Also through the API, for the same reason: Explore's configuration tile has no stable
    // selectors today (spec §10 ask 1). What matters for regression detection is that the
    // ODB accepts the mode and that ITC + obscalc then produce results, asserted next.
    const data = await odb.run(
      setObservingMode({
        observationId: journey.observationId!,
        observingMode: gmosNorthLongSlit(),
      }),
    );
    const updated = data.updateObservations.observations[0];
    expect(updated.instrument).toBe("GMOS_NORTH");
    expect(updated.observingMode.gmosNorthLongSlit.fpu).toBe("LONG_SLIT_0_50");
  });

  await test.step("calculated results appear (ITC and obscalc are alive)", async () => {
    // The end-to-end liveness check of the two background services: obscalc computes the
    // execution digest and the workflow state, and it can only do so once the ITC has
    // answered. Both are asynchronous, hence the poll.
    const digest = await eventually(
      "obscalc to publish an execution digest",
      async () => {
        const data = await odb.run(
          observationCalculated({ observationId: journey.observationId! }),
        );
        const calculated = data.observation.execution.digest;
        return calculated?.calculationState === "READY" && calculated.value
          ? calculated.value
          : undefined;
      },
      { timeoutMs: 300_000, intervalMs: 5_000 },
    );

    expect(Number(digest.estimate.total.total.seconds)).toBeGreaterThan(0);
    expect(digest.science.atomCount).toBeGreaterThan(0);
  });
});

test("scenario 4: edit the subtitle and read it back after a reload", async () => {
  const observationId = journey.observationId!;
  expect(observationId, "scenario 3 must have created an observation").toBeTruthy();

  await test.step("set a subtitle to edit", async () => {
    // Seed through the API so the UI has a stable label to click in the next step.
    await odb.run(updateObservationSubtitle({ observationId, subtitle: SUBTITLE }));
    await expect(ui.obsBadgeSubtitle(page, SUBTITLE)).toBeVisible({
      timeout: 60_000,
    });
  });

  await test.step("edit it inline on the observation card", async () => {
    await ui.obsBadgeSubtitle(page, SUBTITLE).click();
    const input = page.getByRole("textbox").first();
    await input.fill(EDITED_SUBTITLE);
    await input.press("Enter");
  });

  await test.step("read back: the ODB has the new subtitle", async () => {
    await eventually(
      "the edited subtitle to reach the ODB",
      async () => {
        const data = await odb.run(observationQuery({ observationId }));
        return data.observation.subtitle === EDITED_SUBTITLE ? true : undefined;
      },
      { timeoutMs: 60_000, intervalMs: 2_000 },
    );
  });

  await test.step("it survives a full page reload", async () => {
    await page.reload();
    await expect(ui.obsBadgeSubtitle(page, EDITED_SUBTITLE)).toBeVisible({
      timeout: 120_000,
    });

    const data = await odb.run(observationQuery({ observationId }));
    expect(data.observation.subtitle).toBe(EDITED_SUBTITLE);
  });
});
