import { type Page, expect, test } from "@playwright/test";
import { createProgram } from "../../lib/odb-operations.js";
import { eventually } from "../support/odb.js";
import { globalPreferences } from "../support/prefs.js";
import * as ui from "../support/selectors.js";
import { StandardSession, loadStandardUser } from "../support/standard-users.js";

/**
 * The Getting Started guide: a "Getting Started" button in the top bar (`TopBar.scala`) opens
 * the help sidebar on `getting-started.md`, and the "Show/Hide Getting Started" checkbox of
 * User Preferences (`UserPreferencesPopup.scala`, id `explore-guide-button`) removes and
 * restores the button. The checkbox writes a global preference through Hasura
 * (`storeExploreGuideButtonPreference`), so each toggle is read back after a reload: that is
 * the round trip through the prefs service, not just a local state change.
 *
 * The guide's text is fetched by the browser from GitHub (`HelpBody.scala`), so the first
 * step needs the net. A standard user is required: guests get no User Preferences item.
 */

const pi = loadStandardUser("TEST_PI");

async function openUserPreferences(page: Page): Promise<void> {
  await ui.mainMenuButton(page).click();
  await ui.userPreferencesMenuItem(page).click();
  await expect(ui.guideButtonToggle(page)).toBeAttached();
}

async function closeUserPreferences(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(ui.guideButtonToggle(page)).toBeHidden();
}

test("the Getting Started guide opens from the top bar, and User Preferences hides and restores the button", async ({
  browser,
}) => {
  test.skip(!pi, "no fabricated standard users — run stack/scripts/create-standard-users.sh");

  const odb = new StandardSession(pi!).client();
  const program = await odb.run<{ createProgram: { program: { id: string } } }>(
    createProgram({ name: `gpp-tests getting-started ${Date.now()}` }),
  );
  const programId = program.createProgram.program.id;

  const session = new StandardSession(pi!);
  const context = await browser.newContext();
  await session.inject(context);
  const page = await context.newPage();

  const reload = async () => {
    await page.goto(`/${programId}/observations`);
    await expect(ui.obsTreeAddObservationButton(page)).toBeVisible({ timeout: 120_000 });
  };

  // The checkbox stores the preference over the prefs websocket without waiting, so the
  // reload follows Hasura, not the click: that is the round trip under test.
  const expectStoredGuide = (shown: boolean) =>
    eventually(`Hasura to hold exploreGuideButton=${shown}`, async () =>
      (await globalPreferences(pi!.userId))?.exploreGuideButton === shown ? true : undefined,
    );

  try {
    await reload();

    await test.step("the button is shown (restored first if an earlier run left it hidden)", async () => {
      if (!(await ui.gettingStartedButton(page).isVisible())) {
        await openUserPreferences(page);
        await ui.guideButtonToggle(page).setChecked(true);
        await closeUserPreferences(page);
      }
      await expect(ui.gettingStartedButton(page)).toBeVisible();
    });

    await test.step("the button opens the guide, and its close button dismisses it", async () => {
      await ui.gettingStartedButton(page).click();
      await expect(ui.helpSidebar(page)).toBeVisible();
      await expect(ui.helpHeading(page, /^Getting Started$/)).toBeVisible({ timeout: 60_000 });
      await ui.helpCloseButton(page).click();
      await expect(ui.helpSidebar(page)).toBeHidden();
    });

    await test.step("unchecking Show/Hide hides the button, and the preference survives a reload", async () => {
      await openUserPreferences(page);
      await expect(ui.guideButtonToggle(page)).toBeChecked();
      await ui.guideButtonToggle(page).setChecked(false);
      await expect(ui.gettingStartedButton(page)).toBeHidden();
      await expectStoredGuide(false);
      await closeUserPreferences(page);
      await reload();
      await expect(ui.gettingStartedButton(page)).toBeHidden();
    });

    await test.step("checking it again restores the button, across a reload", async () => {
      await openUserPreferences(page);
      await expect(ui.guideButtonToggle(page)).not.toBeChecked();
      await ui.guideButtonToggle(page).setChecked(true);
      await expect(ui.gettingStartedButton(page)).toBeVisible();
      await expectStoredGuide(true);
      await closeUserPreferences(page);
      await reload();
      await expect(ui.gettingStartedButton(page)).toBeVisible();
    });
  } finally {
    await context.close();
  }
});
