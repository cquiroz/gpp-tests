import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  createObservation,
  createProgram,
  createTarget,
  observationScheduling as observationSchedulingQuery,
} from "../../lib/odb-operations.js";
import { eventually } from "../support/odb.js";
import * as ui from "../support/selectors.js";
import { StandardSession, loadStandardUser } from "../support/standard-users.js";

/**
 * The Constraints and Scheduling tiles of one observation, as a PI. Every edit is read back
 * from the ODB (`observationScheduling`), so the check is that Explore sent the change, not
 * only that the field shows it.
 *
 * The condition dropdowns pick whichever option differs from the one shown, as
 * `undo-redo.spec.ts` does, so the test does not depend on Explore's display labels.
 */

const pi = loadStandardUser("TEST_PI");
const polling = { timeoutMs: 60_000, intervalMs: 1_000 };

interface Scheduling {
  constraintSet: {
    imageQuality: string;
    cloudExtinction: string;
    skyBackground: string;
    waterVapor: string;
    elevationRange: {
      airMass: { min: number; max: number } | null;
      hourAngle: { minHours: number; maxHours: number } | null;
    };
  };
  timingWindows: {
    inclusion: string;
    startUtc: string;
    end:
      | { atUtc: string }
      | { after: { hours: number }; repeat: { period: { hours: number }; times: number | null } | null }
      | null;
  }[];
}

/** Picks an option other than the one shown and returns its label. */
async function pickAnotherOption(page: Page, dropdown: Locator): Promise<string> {
  const shown = (await ui.dropdownLabel(dropdown).innerText()).trim();
  await dropdown.click();
  const other = ui.dropdownItems(page).filter({ hasNotText: shown }).last();
  const picked = (await other.innerText()).trim();
  await other.click();
  await expect(ui.dropdownLabel(dropdown)).toHaveText(picked);
  return picked;
}

/**
 * Real keystrokes over a selected value. Explore's fields run an input mask (Inputmask),
 * which `fill` bypasses: it sets the value in one go and the mask can rewrite it.
 */
async function typeInto(field: Locator, value: string): Promise<void> {
  await field.click();
  await field.press("ControlOrMeta+a");
  await field.pressSequentially(value);
  await field.press("Tab");
}

test("constraints and timing windows edited in Explore reach the ODB", async ({ browser }) => {
  test.skip(!pi, "no fabricated standard users — run stack/scripts/create-standard-users.sh");

  const odb = new StandardSession(pi!).client();

  const { programId, observationId } = await test.step("seed: one observation on one target", async () => {
    const program = await odb.run<{ createProgram: { program: { id: string } } }>(
      createProgram({ name: `gpp-tests constraints ${Date.now()}` }),
    );
    const programId = program.createProgram.program.id;
    const target = await odb.run<{ createTarget: { target: { id: string } } }>(
      createTarget({ programId, name: "constraints target" }),
    );
    const created = await odb.run<{ createObservation: { observation: { id: string } } }>(
      createObservation({ programId, targetIds: [target.createTarget.target.id], subtitle: "constraints" }),
    );
    return { programId, observationId: created.createObservation.observation.id };
  });

  const read = async () =>
    (await odb.run<{ observation: Scheduling }>(observationSchedulingQuery({ observationId }))).observation;
  const odbHolds = async <T>(description: string, check: (s: Scheduling) => T | undefined) => {
    let last: Scheduling | undefined;
    try {
      return await eventually(`the ODB to hold ${description}`, async () => check((last = await read())), polling);
    } catch (error) {
      throw new Error(`${(error as Error).message}; last read: ${JSON.stringify(last)}`);
    }
  };

  const context = await browser.newContext();
  await new StandardSession(pi!).inject(context);
  const page = await context.newPage();

  try {
    await page.goto(`/${programId}/observation/${observationId}`);
    await expect(ui.constraintDropdown(page, "image-quality")).toBeVisible({ timeout: 120_000 });

    await test.step("each condition dropdown changes its ODB value", async () => {
      const fields = [
        ["image-quality", "imageQuality"],
        ["cloud-extinction", "cloudExtinction"],
        ["water-vapor", "waterVapor"],
        ["sky-background", "skyBackground"],
      ] as const;
      for (const [id, key] of fields) {
        const before = (await read()).constraintSet[key];
        await pickAnotherOption(page, ui.constraintDropdown(page, id));
        await odbHolds(`a new ${key}`, (s) => (s.constraintSet[key] !== before ? true : undefined));
      }
    });

    await test.step("air mass limits typed in reach the ODB", async () => {
      await typeInto(ui.formInput(page, "minam"), "1.2");
      await typeInto(ui.formInput(page, "maxam"), "1.8");
      await odbHolds("air mass 1.2–1.8", (s) => {
        const am = s.constraintSet.elevationRange.airMass;
        return am && Number(am.min) === 1.2 && Number(am.max) === 1.8 ? true : undefined;
      });
    });

    await test.step("switching to hour angle replaces the air mass range", async () => {
      await pickAnotherOption(page, ui.dropdownRoot(page, "ertype"));
      await odbHolds("an hour angle range", (s) =>
        s.constraintSet.elevationRange.hourAngle && !s.constraintSet.elevationRange.airMass ? true : undefined,
      );
      await typeInto(ui.formInput(page, "minha"), "-2");
      await typeInto(ui.formInput(page, "maxha"), "3");
      await odbHolds("hour angle −2 to 3", (s) => {
        const ha = s.constraintSet.elevationRange.hourAngle;
        return ha && Number(ha.minHours) === -2 && Number(ha.maxHours) === 3 ? true : undefined;
      });
    });

    await test.step("a new timing window is an open-ended include window", async () => {
      await expect(ui.timingWindowRows(page)).toHaveCount(0);
      await ui.addTimingWindowButton(page).click();
      await expect(ui.timingWindowRows(page)).toHaveCount(1);
      await odbHolds("one include window with no end", (s) =>
        s.timingWindows.length === 1 && s.timingWindows[0]?.inclusion === "INCLUDE" && s.timingWindows[0]?.end === null
          ? true
          : undefined,
      );
    });

    await test.step("Exclude, a duration and a repeat count reach the ODB", async () => {
      await ui.labelFor(page, "exclude-option").click();
      await odbHolds("an exclude window", (s) => (s.timingWindows[0]?.inclusion === "EXCLUDE" ? true : undefined));

      await ui.labelFor(page, "for").click();
      await odbHolds("a window that ends after a duration", (s) => {
        const end = s.timingWindows[0]?.end;
        return end && "after" in end ? true : undefined;
      });
      await typeInto(ui.formInput(page, "for-duration"), "12:00");
      await odbHolds("a 12 hour window", (s) => {
        const end = s.timingWindows[0]?.end;
        return end && "after" in end && Number(end.after.hours) === 12 ? true : undefined;
      });

      await ui.checkboxInput(page, "repeat-with-period").check({ force: true });
      await odbHolds("a repeating window", (s) => {
        const end = s.timingWindows[0]?.end;
        return end && "after" in end && end.repeat ? true : undefined;
      });
      await page.locator("#repeat-n-times").check({ force: true });
      await typeInto(ui.formInput(page, "repeat-n-times-value"), "3");
      await odbHolds("a window repeated 3 times", (s) => {
        const end = s.timingWindows[0]?.end;
        return end && "after" in end && end.repeat?.times === 3 ? true : undefined;
      });
    });

    await test.step("deleting the window empties the ODB list", async () => {
      await ui.timingWindowDelete(ui.timingWindowRows(page).first()).click();
      await expect(ui.timingWindowRows(page)).toHaveCount(0);
      await odbHolds("no timing windows", (s) => (s.timingWindows.length === 0 ? true : undefined));
    });
  } finally {
    await context.close();
  }
});
