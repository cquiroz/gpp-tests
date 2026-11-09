import { expect, test } from "@playwright/test";
import { createProgram, programs as programsQuery } from "../../lib/odb-operations.js";
import { GuestSession } from "../support/odb.js";
import * as ui from "../support/selectors.js";
import { StandardSession, loadStandardUser } from "../support/standard-users.js";

/**
 * The landing without a program id in the URL (`ExploreLayout.scala`, the `optProgramId.fold`
 * case): a user who can see no program gets one created for them and is routed to its obs
 * tree; a user who can see some gets the Proposals & Programs dialog. Which branch an
 * identity takes is a property of the ODB's contents, not of the kind of user, so each
 * branch is driven by an identity whose contents are known: a brand-new guest, who can only
 * ever see their own programs and starts with none, and a PI who just created one.
 *
 * The journey and the shell-render waits accept either landing (`ui.loggedInLanding`); this
 * spec is where each branch is asserted on its own, with the guest's new program read back
 * from the ODB as the proof that "auto-created" means a real program.
 */

const pi = loadStandardUser("TEST_PI");

interface ProgramRows {
  programs: { matches: { id: string }[] };
}

test("the landing without a program id creates one for a guest and offers the dialog to a PI", async ({
  browser,
}) => {
  await test.step("a guest, who can see no program, lands on the obs tree of a program made for them", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const session = GuestSession.watch(page);
      await page.goto("/");
      await ui.guestLoginButton(page).click();
      await expect(ui.obsTreeAddObservationButton(page)).toBeVisible({ timeout: 120_000 });
      await expect(ui.programsDialog(page)).toBeHidden();
      await expect(page).toHaveURL(/\/p-[0-9a-f]+\/observations/);
      const programId = /\/(p-[0-9a-f]+)\//.exec(page.url())![1]!;

      const mine = await session.client().run<ProgramRows>(programsQuery({}));
      expect(mine.programs.matches.map((p) => p.id)).toEqual([programId]);
    } finally {
      await context.close();
    }
  });

  await test.step("a PI who can see a program gets the Proposals & Programs dialog listing it", async () => {
    test.skip(!pi, "no fabricated standard users — run stack/scripts/create-standard-users.sh");
    const session = new StandardSession(pi!);
    const program = await session.client().run<{ createProgram: { program: { id: string } } }>(
      createProgram({ name: `gpp-tests landing ${Date.now()}` }),
    );
    const programId = program.createProgram.program.id;

    const context = await browser.newContext();
    try {
      await session.inject(context);
      const page = await context.newPage();
      await page.goto("/");
      await expect(ui.programsDialog(page)).toBeVisible({ timeout: 120_000 });
      await expect(ui.obsTreeAddObservationButton(page)).toBeHidden();
      // The dialog's table only renders the rows in view, and this persona accumulates a
      // program per run, so the new one is reached by scrolling the list to its end.
      const row = ui.programRow(page, programId);
      for (let i = 0; i < 40 && !(await row.isVisible()); i++) {
        await page.getByTestId("explore-programs-row").last().scrollIntoViewIfNeeded();
        await page.waitForTimeout(250);
      }
      await expect(row).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
