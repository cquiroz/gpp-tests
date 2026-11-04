import { expect, test } from "@playwright/test";
import {
  createProgram,
  observationCalibration as observationCalibrationQuery,
} from "../../lib/odb-operations.js";
import { eventually } from "../support/odb.js";
import * as ui from "../support/selectors.js";
import { StandardSession, loadStandardUser } from "../support/standard-users.js";

/**
 * Daytime calibrations (`ObsTree.scala`, `DaytimeConfigurationTile.scala`): a staff-only obs
 * tree button creates an observation whose observing mode is a daytime calibration (GMOS
 * North by default, no target), the ODB stamps it `DAYTIME_CALIBRATION`, and the editor
 * swaps the Configuration tile for the Daytime Calibration tile: an instrument dropdown and
 * a table of calibration sets, each edit sent whole through `updateObservations`.
 *
 * The role gate is the ODB's (the mode input is "staff only"), and the button only renders
 * for staff; a PI's tree is checked for its absence. Every edit is read back from the ODB.
 */

const staff = loadStandardUser("TEST_STAFF");
const pi = loadStandardUser("TEST_PI");

interface CalibrationRow {
  observation: {
    calibrationRole: string | null;
    observingMode: {
      mode: string;
      daytimeCalibration: { instrument: string; calibrationSets: { kind: string; count: number }[] } | null;
    } | null;
  };
}

test("staff add a daytime calibration from the obs tree and edit its instrument and sets", async ({
  browser,
}) => {
  test.skip(!staff || !pi, "no fabricated standard users — run stack/scripts/create-standard-users.sh");

  const staffOdb = new StandardSession(staff!).client();
  const calibration = async (observationId: string) =>
    (await staffOdb.run<CalibrationRow>(observationCalibrationQuery({ observationId }))).observation;
  const polling = { timeoutMs: 60_000, intervalMs: 1_000 };

  await test.step("a PI's obs tree offers no daytime calibration button", async () => {
    const piOdb = new StandardSession(pi!).client();
    const program = await piOdb.run<{ createProgram: { program: { id: string } } }>(
      createProgram({ name: `gpp-tests daytime cal (pi) ${Date.now()}` }),
    );
    const context = await browser.newContext();
    try {
      await new StandardSession(pi!).inject(context);
      const page = await context.newPage();
      await page.goto(`/${program.createProgram.program.id}/observations`);
      await expect(ui.obsTreeAddObservationButton(page)).toBeVisible({ timeout: 120_000 });
      await expect(ui.addDaytimeCalibrationButton(page)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  const program = await staffOdb.run<{ createProgram: { program: { id: string } } }>(
    createProgram({ name: `gpp-tests daytime cal ${Date.now()}` }),
  );
  const programId = program.createProgram.program.id;

  const context = await browser.newContext();
  await new StandardSession(staff!).inject(context);
  const page = await context.newPage();

  try {
    await page.goto(`/${programId}/observations`);
    await expect(ui.obsTreeAddObservationButton(page)).toBeVisible({ timeout: 120_000 });

    const observationId = await test.step("the button creates a GMOS North daytime calibration and focuses it", async () => {
      await ui.addDaytimeCalibrationButton(page).click();
      await expect(page).toHaveURL(/\/observation\/o-[0-9a-f]+/, { timeout: 60_000 });
      const observationId = /\/observation\/(o-[0-9a-f]+)/.exec(page.url())![1]!;
      await expect(ui.obsBadge(page, observationId)).toContainText("Daytime Calibration");
      await expect(ui.tile(page, /^Daytime Calibration/)).toBeVisible({ timeout: 60_000 });
      await expect(ui.tile(page, /^Configuration$/)).toHaveCount(0);
      await expect(ui.dropdownLabel(ui.daytimeCalInstrument(page))).toHaveText(/GMOS North/);

      const row = await calibration(observationId);
      expect(row.calibrationRole).toBe("DAYTIME_CALIBRATION");
      expect(row.observingMode?.mode).toBe("DAYTIME_CALIBRATION");
      expect(row.observingMode?.daytimeCalibration).toEqual({
        instrument: "GMOS_NORTH",
        calibrationSets: [],
      });
      return observationId;
    });

    await test.step("adding a calibration set stores a bias set of one exposure", async () => {
      await ui.addCalibrationSetButton(page).click();
      await expect(ui.calibrationSetCell(page, "kind", 0)).toBeVisible();
      await eventually("the ODB to hold one BIAS set", async () => {
        const sets = (await calibration(observationId)).observingMode?.daytimeCalibration?.calibrationSets;
        return sets?.length === 1 && sets[0]!.kind === "BIAS" && sets[0]!.count === 1 ? true : undefined;
      }, polling);
    });

    await test.step("switching the instrument to GMOS South clears the sets", async () => {
      await ui.daytimeCalInstrument(page).click();
      await ui.dropdownItems(page).filter({ hasText: /GMOS South/ }).click();
      await expect(ui.dropdownLabel(ui.daytimeCalInstrument(page))).toHaveText(/GMOS South/);
      await expect(page.getByText("No calibration sets.")).toBeVisible();
      await eventually("the ODB to hold GMOS South with no sets", async () => {
        const mode = (await calibration(observationId)).observingMode?.daytimeCalibration;
        return mode?.instrument === "GMOS_SOUTH" && mode.calibrationSets.length === 0 ? true : undefined;
      }, polling);
    });
  } finally {
    await context.close();
  }
});
