import { expect, test } from "@playwright/test";
import {
  createObservation,
  createProgram,
  createTarget,
  observation as observationQuery,
  targets as targetsQuery,
} from "../../lib/odb-operations.js";
import { eventually } from "../support/odb.js";
import * as ui from "../support/selectors.js";
import { StandardSession, loadStandardUser } from "../support/standard-users.js";

/**
 * Undo and redo (`UNDO.md`, `UndoContext.scala`): every edit updates the local model, pushes
 * the old value on one stack shared by the whole program, and sends the mutation; undo and
 * redo replay that mutation with the restored value, so the ODB copy moves with every click.
 * That makes the ODB read-back after each step the assertion, not the field's text.
 *
 * Explore binds no key for undo (`shortcuts.scala` has none; `mod+z` is the browser's own
 * text undo), so the toolbar buttons of the obs tree are the only path. Two edits with
 * different commit paths: a constraint dropdown commits on selection, the target name on
 * blur plus a 200 ms delay (`SearchForm.scala`; Enter would start a catalog search instead).
 */

const pi = loadStandardUser("TEST_PI");

interface ObservationConstraints {
  observation: { constraintSet: { imageQuality: string } };
}

interface TargetRows {
  targets: { matches: { id: string; name: string }[] };
}

test("undo and redo move the ODB copy of a constraint and of a target name", async ({ browser }) => {
  test.skip(!pi, "no fabricated standard users — run stack/scripts/create-standard-users.sh");

  const odb = new StandardSession(pi!).client();

  const { programId, targetId, observationId } = await test.step(
    "seed: a program with one observation on one target",
    async () => {
      const program = await odb.run<{ createProgram: { program: { id: string } } }>(
        createProgram({ name: `gpp-tests undo ${Date.now()}` }),
      );
      const programId = program.createProgram.program.id;
      const target = await odb.run<{ createTarget: { target: { id: string } } }>(
        createTarget({ programId, name: "undo target" }),
      );
      const targetId = target.createTarget.target.id;
      const created = await odb.run<{ createObservation: { observation: { id: string } } }>(
        createObservation({ programId, targetIds: [targetId], subtitle: "undo" }),
      );
      return { programId, targetId, observationId: created.createObservation.observation.id };
    },
  );

  const imageQuality = async () =>
    (await odb.run<ObservationConstraints>(observationQuery({ observationId }))).observation
      .constraintSet.imageQuality;
  const targetName = async () =>
    (await odb.run<TargetRows>(targetsQuery({ programId }))).targets.matches.find(
      (t) => t.id === targetId,
    )!.name;
  const polling = { timeoutMs: 60_000, intervalMs: 1_000 };
  const expectImageQuality = (value: string) =>
    eventually(`the ODB to hold imageQuality=${value}`, async () =>
      (await imageQuality()) === value ? true : undefined, polling);
  const expectTargetName = (value: string) =>
    eventually(`the ODB to hold the target name "${value}"`, async () =>
      (await targetName()) === value ? true : undefined, polling);

  const session = new StandardSession(pi!);
  const context = await browser.newContext();
  await session.inject(context);
  const page = await context.newPage();

  try {
    await page.goto(`/${programId}/observation/${observationId}`);
    await expect(ui.obsTreeAddObservationButton(page)).toBeVisible({ timeout: 120_000 });
    const dropdown = ui.constraintDropdown(page, "image-quality");
    await expect(dropdown).toBeVisible({ timeout: 60_000 });

    await test.step("a fresh editor has nothing to undo or redo", async () => {
      await expect(ui.undoButton(page)).toBeDisabled();
      await expect(ui.redoButton(page)).toBeDisabled();
    });

    await test.step("a new image quality reaches the ODB; undo restores it, redo reapplies it", async () => {
      const original = await imageQuality();
      const shown = (await ui.dropdownLabel(dropdown).innerText()).trim();
      await dropdown.click();
      const other = ui.dropdownItems(page).filter({ hasNotText: shown }).first();
      const picked = (await other.innerText()).trim();
      await other.click();
      await expect(ui.dropdownLabel(dropdown)).toHaveText(picked);
      const changed = await eventually(
        "the ODB to hold a different imageQuality",
        async () => {
          const value = await imageQuality();
          return value !== original ? value : undefined;
        },
        polling,
      );

      await expect(ui.undoButton(page)).toBeEnabled();
      await ui.undoButton(page).click();
      await expect(ui.dropdownLabel(dropdown)).toHaveText(shown);
      await expectImageQuality(original);

      await expect(ui.redoButton(page)).toBeEnabled();
      await ui.redoButton(page).click();
      await expect(ui.dropdownLabel(dropdown)).toHaveText(picked);
      await expectImageQuality(changed);
    });

    await test.step("a renamed target reaches the ODB; undo restores the name, redo reapplies it", async () => {
      const name = ui.targetNameInput(page);
      await expect(name).toHaveValue("undo target");
      await name.fill("undo target renamed");
      await name.press("Tab");
      await expectTargetName("undo target renamed");

      // The rename is now the top of the program's single stack, above the constraint edit.
      await ui.undoButton(page).click();
      await expectTargetName("undo target");
      await expect(name).toHaveValue("undo target");

      await ui.redoButton(page).click();
      await expectTargetName("undo target renamed");
      await expect(name).toHaveValue("undo target renamed");
    });
  } finally {
    await context.close();
  }
});
