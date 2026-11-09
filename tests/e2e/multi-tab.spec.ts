import { type Page, expect, test } from "@playwright/test";
import { createObservation, createProgram, createTarget } from "../../lib/odb-operations.js";
import * as ui from "../support/selectors.js";
import { StandardSession, loadStandardUser } from "../support/standard-users.js";

/**
 * Two browser contexts on the same program (`ProgramCache.scala`: the program's observations,
 * targets and edits arrive over ODB subscriptions, so a change made in one Explore shows up
 * in every other without a reload). One context edits, the other only watches: a constraint
 * on the open observation, the target's name, and a new observation in the tree.
 */

const pi = loadStandardUser("TEST_PI");

test("an edit in one Explore shows up in another on the same program without a reload", async ({
  browser,
}) => {
  test.skip(!pi, "no fabricated standard users — run stack/scripts/create-standard-users.sh");

  const odb = new StandardSession(pi!).client();
  const { programId, observationId } = await test.step(
    "seed: a program with one observation on one target",
    async () => {
      const program = await odb.run<{ createProgram: { program: { id: string } } }>(
        createProgram({ name: `gpp-tests multi-tab ${Date.now()}` }),
      );
      const programId = program.createProgram.program.id;
      const target = await odb.run<{ createTarget: { target: { id: string } } }>(
        createTarget({ programId, name: "shared target" }),
      );
      const created = await odb.run<{ createObservation: { observation: { id: string } } }>(
        createObservation({
          programId,
          targetIds: [target.createTarget.target.id],
          subtitle: "shared",
        }),
      );
      return { programId, observationId: created.createObservation.observation.id };
    },
  );

  const open = async (): Promise<Page> => {
    const context = await browser.newContext();
    await new StandardSession(pi!).inject(context);
    const page = await context.newPage();
    await page.goto(`/${programId}/observation/${observationId}`);
    await expect(ui.obsTreeAddObservationButton(page)).toBeVisible({ timeout: 120_000 });
    await expect(ui.constraintDropdown(page, "image-quality")).toBeVisible({ timeout: 60_000 });
    return page;
  };

  const editor = await open();
  const watcher = await open();

  try {
    await test.step("a constraint picked in one shows in the other", async () => {
      const dropdown = ui.constraintDropdown(editor, "image-quality");
      const shown = (await ui.dropdownLabel(dropdown).innerText()).trim();
      await dropdown.click();
      const other = ui.dropdownItems(editor).filter({ hasNotText: shown }).first();
      const picked = (await other.innerText()).trim();
      await other.click();
      await expect(ui.dropdownLabel(dropdown)).toHaveText(picked);
      await expect(ui.dropdownLabel(ui.constraintDropdown(watcher, "image-quality"))).toHaveText(picked, {
        timeout: 30_000,
      });
    });

    await test.step("a target renamed in one is renamed in the other", async () => {
      const name = ui.targetNameInput(editor);
      await expect(name).toHaveValue("shared target");
      await name.fill("shared target renamed");
      await name.press("Tab");
      await expect(ui.targetNameInput(watcher)).toHaveValue("shared target renamed", { timeout: 30_000 });
    });

    await test.step("an observation added in one appears in the other's tree", async () => {
      await expect(watcher.locator(".obs-badge")).toHaveCount(1);
      await ui.obsTreeAddObservationButton(editor).click();
      await expect(editor.locator(".obs-badge")).toHaveCount(2, { timeout: 30_000 });
      await expect(watcher.locator(".obs-badge")).toHaveCount(2, { timeout: 30_000 });
    });
  } finally {
    await editor.context().close();
    await watcher.context().close();
  }
});
