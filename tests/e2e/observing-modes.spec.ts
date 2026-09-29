import { type Page, expect, test } from "@playwright/test";
import {
  createObservation,
  createProgram,
  createTarget,
  observationCalculated,
  observationMode,
} from "../../lib/odb-operations.js";
import {
  MODE_TARGETS,
  OBSERVING_MODES,
  type ObservingModeFixture,
  modeTestTitle,
} from "../../lib/observing-modes.js";
import { type OdbClient, eventually } from "../support/odb.js";
import * as ui from "../support/selectors.js";
import { StandardSession, loadStandardUser } from "../support/standard-users.js";

/**
 * An observation in every observing mode, picked through Explore's own configuration panel
 * (wayfinder ticket 030).
 *
 * Program, target and science requirements are seeded through GraphQL; the behavior under
 * test is Explore's mode picker: choose the mode and instrument, take the first row Explore
 * offers, accept it. Explore's defaults decide the rest of the configuration, which is why
 * this layer builds a different observation from k6's for the same mode — a mode that is
 * green there and red here points at Explore's defaults.
 *
 * Pass means Explore shows a time estimate and sequence steps, and the ODB confirms both —
 * not necessarily READY — within a minute. Visitor and exchange have nothing to calculate
 * and pass on the mode reading back. A mode can be marked `expectedFailure` in the fixture
 * table, which runs it as `test.fail`, so it goes red the day it starts passing.
 *
 * Runs as the fabricated regular PI only. Each test is independent (its own program), so the
 * file can run in parallel once the suite's workers allow it.
 */

const pi = loadStandardUser("TEST_PI");

/** Ticket 030: a sequence and time estimate within a minute of accepting the mode. */
const CALCULATION_TIMEOUT_MS = 60_000;

test.describe.configure({ mode: "parallel" });

for (const mode of OBSERVING_MODES) {
  test(modeTestTitle(mode), async ({ browser }) => {
    test.skip(!pi, "no fabricated standard users — run stack/scripts/create-standard-users.sh");
    if (mode.expectedFailure) {
      test.fail(true, `${mode.expectedFailure.reason} (${mode.expectedFailure.link})`);
    }

    const session = new StandardSession(pi!);
    const context = await browser.newContext();
    await session.inject(context);
    const page = await context.newPage();
    const odb = session.client();

    try {
      const { programId, observationId } = await test.step(
        "seed a program, a target and the science requirements",
        () => seed(odb, mode),
      );

      await test.step("open the observation", async () => {
        await page.goto(`/${programId}/observation/${observationId}`);
        await expect(ui.configModeDropdown(page)).toBeVisible({ timeout: 120_000 });
      });

      await test.step(`pick ${mode.title} in the configuration panel`, () =>
        pickMode(page, mode),
      );

      await test.step("read back: the observation carries the mode", async () => {
        await eventually(
          `the observation to carry ${mode.modeType}`,
          async () => {
            const data = await odb.run(observationMode({ observationId }));
            return data.observation.observingMode?.mode === mode.modeType || undefined;
          },
          { timeoutMs: 30_000, intervalMs: 1_000 },
        );
      });

      if (mode.check === "sequence") {
        await test.step("Explore shows a time estimate and a sequence", async () => {
          await expect(ui.sequencePlannedTime(page)).toBeVisible({
            timeout: CALCULATION_TIMEOUT_MS,
          });
          await expect(ui.sequenceSteps(page).first()).toBeVisible({
            timeout: CALCULATION_TIMEOUT_MS,
          });
        });

        await test.step("read back: the ODB has an estimate and a science sequence", async () => {
          const digest = await eventually(
            "an execution digest with an estimate and science atoms",
            async () => {
              const data = await odb.run(observationCalculated({ observationId }));
              const value = data.observation.execution.digest?.value;
              return value?.estimate && value.science?.atomCount > 0 ? value : undefined;
            },
            { timeoutMs: CALCULATION_TIMEOUT_MS, intervalMs: 3_000 },
          );
          expect(Number(digest.estimate.total.total.seconds)).toBeGreaterThan(0);
        });
      }
    } finally {
      await context.close();
    }
  });
}

/**
 * A fresh program per mode, so tests never share state. Sequence modes get their family's
 * target and the fixture's science requirements — Explore needs a wavelength and an
 * exposure-time mode before it will accept any row — but no observing mode: choosing it is
 * the UI's job. Visitor and exchange modes need neither.
 */
async function seed(
  odb: OdbClient,
  mode: ObservingModeFixture,
): Promise<{ programId: string; observationId: string }> {
  const program = await odb.run(createProgram({ name: `gpp-tests mode ${mode.key}` }));
  const programId: string = program.createProgram.program.id;

  const targetIds: string[] = [];
  if (mode.target) {
    const target = await odb.run(
      createTarget({ programId, target: MODE_TARGETS[mode.target] }),
    );
    targetIds.push(target.createTarget.target.id);
  }

  const created = await odb.run(
    createObservation({
      programId,
      targetIds,
      subtitle: `observing mode: ${mode.key}`,
      scienceRequirements: mode.scienceRequirements,
    }),
  );
  const observation = created.createObservation.observation;
  expect(observation.observingMode, "seeded without a mode").toBeNull();
  return { programId, observationId: observation.id };
}

/**
 * Explore's basic configuration: the Mode dropdown (seeded requirements already select
 * Spectroscopy or Imaging, and switching would reset them), then for the table modes the
 * instrument filter and the first enabled row — or, for visitor, the editor's six fields,
 * which have no defaults — then Accept.
 */
async function pickMode(page: Page, mode: ObservingModeFixture): Promise<void> {
  const { configMode, instrument, instrumentTag, focalPlane } = mode.explore;

  const dropdown = ui.configModeDropdown(page);
  if (!(await dropdown.textContent())?.includes(configMode)) {
    await dropdown.click();
    await ui.dropdownOption(page, configMode).click();
    await expect(dropdown).toContainText(configMode);
  }

  if (mode.explore.visitor) {
    const v = mode.explore.visitor;
    await ui.visitorField(page, "site").click();
    await ui.dropdownOption(page, v.site).click();
    // Each input commits on blur, like a user tabbing through the form.
    for (const [field, value] of [
      ["name", v.name],
      ["central-wavelength", v.centralWavelength],
      ["ags-diameter", v.agsDiameter],
      ["science-fov-diameter", v.scienceFovDiameter],
      ["total-time", v.totalTime],
    ] as const) {
      const input = ui.visitorField(page, field);
      await input.fill(value);
      await input.blur();
    }
  }

  if (instrumentTag) {
    await ui.configInstrumentDropdown(page).click();
    await ui.dropdownOption(page, instrument!).click();
    const row = ui.configModeRows(page, instrumentTag, focalPlane).first();
    await expect(row, `Explore offers an enabled ${mode.title} row`).toBeVisible({
      timeout: 30_000,
    });
    await row.click();
  }

  // Waits out "Waiting for ITC result..." — Accept stays disabled until the ITC answers.
  const accept = ui.configAcceptButton(page);
  await expect(accept).toBeEnabled({ timeout: CALCULATION_TIMEOUT_MS });
  await accept.click();
}
