import { expect, test } from "@playwright/test";
import { MODE_TARGETS } from "../../lib/observing-modes.js";
import {
  addTimeChargeCorrection,
  createObservation,
  createProgram,
  createTarget,
  gmosNorthLongSlit,
  programTimes as programTimesQuery,
  setAllocations,
} from "../../lib/odb-operations.js";
import { executeFirstStep, serviceJwt } from "../support/execution.js";
import { eventually } from "../support/odb.js";
import * as ui from "../support/selectors.js";
import { StandardSession, loadStandardUser } from "../support/standard-users.js";

/**
 * Time award and time accounting (`TimeAwardTable.scala`, `TimeAccountingTable.scala`, the
 * Program Details tile of the Program tab): awarded time is the program's allocations, a
 * staff-only ODB mutation Explore has no editor for; prepared time is obscalc's banded
 * estimate of the defined observations; used time is the charge of recorded visits. The
 * spec seeds all three through the API and checks that the tables show what the ODB holds.
 *
 * Nothing in Explore edits these, so the ODB values are the reference and the tables are the
 * behavior under test; execution is recorded with the service JWT (`tests/support/execution.ts`).
 */

const staff = loadStandardUser("TEST_STAFF");

const AWARD_HOURS = 10;
const CORRECTION_HOURS = 0.5;

interface ProgramTimesRow {
  program: {
    allocations: { category: string; scienceBand: string; duration: { hours: number } }[];
    timeEstimateBanded: {
      calculationState: string;
      value: { band: string | null; time: { program: { hours: number } } } | null;
    }[];
    timeCharge: { band: string | null; time: { program: { seconds: number } } }[];
  };
}

/** The tables print decimal hours to two places, as "9.50 h". */
const hours = (value: number) => `${value.toFixed(2)} h`;

test("the Program tab's time tables show the award, the prepared estimate and the used time the ODB holds", async ({
  browser,
}) => {
  test.skip(!staff, "no fabricated standard users — run stack/scripts/create-standard-users.sh");
  test.skip(!serviceJwt, "ODB_SERVICE_JWT is not set — source stack/.env.generated");

  const odb = new StandardSession(staff!).client();
  const times = async () => (await odb.run<ProgramTimesRow>(programTimesQuery({ programId }))).program;

  const { programId } = await test.step(
    "seed: a defined observation, a 10 h Band 1 award for the US, one executed step",
    async () => {
      const program = await odb.run<{ createProgram: { program: { id: string } } }>(
        createProgram({ name: `gpp-tests time accounting ${Date.now()}` }),
      );
      const programId = program.createProgram.program.id;
      const target = await odb.run<{ createTarget: { target: { id: string } } }>(
        createTarget({ programId, target: MODE_TARGETS.optical }),
      );
      const created = await odb.run<{ createObservation: { observation: { id: string } } }>(
        createObservation({
          programId,
          targetIds: [target.createTarget.target.id],
          subtitle: "charged",
          observingMode: gmosNorthLongSlit(),
        }),
      );
      // One allocated band also assigns it to the observations that have none.
      await odb.run(
        setAllocations({
          programId,
          allocations: [{ category: "US", scienceBand: "BAND1", hours: AWARD_HOURS }],
        }),
      );
      // The visit's own seconds only count inside Gemini North's nautical night (the ODB's
      // daylight discount), so the used time that must show is put on the visit as a
      // staff correction, which the ODB applies to the same `timeCharge` the tile reads.
      const { visitId } = await executeFirstStep(created.createObservation.observation.id);
      await odb.run(addTimeChargeCorrection({ visitId, hours: CORRECTION_HOURS, comment: "gpp-tests" }));
      return { programId };
    },
  );

  const expected = await test.step("the ODB holds the award, a Band 1 estimate and a charge", async () => {
    return eventually(
      "the program's estimate to be ready and its charge to be positive",
      async () => {
        const t = await times();
        const estimate = t.timeEstimateBanded.find((e) => e.value?.band === "BAND1");
        const charge = t.timeCharge.find((c) => c.band === "BAND1");
        const ready = estimate?.calculationState === "READY" && (estimate.value?.time.program.hours ?? 0) > 0;
        const charged = (charge?.time.program.seconds ?? 0) > 0;
        return ready && charged
          ? {
              award: t.allocations,
              preparedHours: estimate!.value!.time.program.hours,
              usedHours: charge!.time.program.seconds / 3600,
            }
          : undefined;
      },
      { timeoutMs: 180_000, intervalMs: 3_000 },
    );
  });
  expect(expected.award).toEqual([{ category: "US", scienceBand: "BAND1", duration: { hours: AWARD_HOURS } }]);

  const context = await browser.newContext();
  await new StandardSession(staff!).inject(context);
  const page = await context.newPage();

  try {
    await page.goto(`/${programId}/program`);
    await expect(ui.timeAccountingTable(page)).toBeVisible({ timeout: 120_000 });

    await test.step("the Time Award table lists the US award in Band 1 and in the total", async () => {
      const row = ui.tableRow(ui.timeAwardTable(page), /United States/);
      await expect(row).toBeVisible();
      await expect(row.locator("td").nth(1)).toHaveText(hours(AWARD_HOURS));
      await expect(row.locator("td").last()).toHaveText(hours(AWARD_HOURS));
    });

    await test.step("the Time Accounting table shows prepared, used and remaining time per the ODB", async () => {
      const table = ui.timeAccountingTable(page);
      await expect(ui.tableRow(table, /^Prepared/).locator("td").nth(1)).toHaveText(
        hours(expected.preparedHours),
        { timeout: 60_000 },
      );
      await expect(ui.tableRow(table, /^Used/).locator("td").nth(1)).toHaveText(hours(expected.usedHours));
      await expect(ui.tableRow(table, /^Remain/).locator("td").nth(1)).toHaveText(
        hours(AWARD_HOURS - expected.usedHours),
      );
    });
  } finally {
    await context.close();
  }
});
