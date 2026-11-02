import { type Page, expect, test } from "@playwright/test";
import {
  createObservation,
  createProgram,
  createTarget,
  observations as observationsQuery,
} from "../../lib/odb-operations.js";
import { eventually } from "../support/odb.js";
import { globalPreferences } from "../support/prefs.js";
import * as ui from "../support/selectors.js";
import { StandardSession, loadStandardUser } from "../support/standard-users.js";

/**
 * Explore's keyboard shortcuts (`shortcuts.scala`), bound with react-hotkeys-hook at three
 * levels: the layout (`ExploreLayout.scala`: tab keys, `w`, the help keys), the Observations
 * tab (`ObsTabContents.scala`: `j`/`k`, `s`, copy and paste) and the Targets tab. What each
 * key does is observable without ids: the tab keys and `j`/`k` change the URL, copy raises
 * a toast and paste clones the observation in the ODB, `w` moves a preference the User
 * Preferences dialog shows, and the help keys open the help sidebar.
 *
 * `w` writes the preference through Hasura, so the spec reads it back after a reload — and
 * cycles the full ring so the persona's units end where they started. The help pages are
 * fetched by the browser from GitHub (`HelpBody.scala`), so the last step needs the net.
 */

const pi = loadStandardUser("TEST_PI");

/** `Enumerated[WavelengthUnits].all`, the ring `w` walks (`WavelengthUnits.scala`). */
const WAVELENGTH_UNITS = ["μm", "nm", "Å"];
/** The same ring as Hasura stores it (`LucumaWavelengthUnitsEnum`). */
const UNIT_TAGS: Record<string, string> = { "μm": "MICROMETERS", nm: "NANOMETERS", "Å": "ANGSTROMS" };

interface ObservationRow {
  id: string;
  subtitle: string | null;
  targetEnvironment: { asterism: { id: string }[] };
}

async function openUserPreferences(page: Page): Promise<void> {
  await ui.mainMenuButton(page).click();
  await ui.userPreferencesMenuItem(page).click();
  await expect(ui.wavelengthUnitsSelected(page)).toBeVisible();
}

async function closeUserPreferences(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(ui.wavelengthUnitsSelected(page)).toBeHidden();
}

test("keyboard shortcuts drive the tabs, the obs tree, copy and paste, the units and the help", async ({
  browser,
}) => {
  test.skip(!pi, "no fabricated standard users — run stack/scripts/create-standard-users.sh");

  const odb = new StandardSession(pi!).client();

  const { programId, first, second } = await test.step(
    "seed: a program with two observations on one target",
    async () => {
      const program = await odb.run<{ createProgram: { program: { id: string } } }>(
        createProgram({ name: `gpp-tests shortcuts ${Date.now()}` }),
      );
      const programId = program.createProgram.program.id;
      const target = await odb.run<{ createTarget: { target: { id: string } } }>(
        createTarget({ programId, name: "shortcuts target" }),
      );
      const ids: string[] = [];
      for (const subtitle of ["shortcuts first", "shortcuts second"]) {
        const created = await odb.run<{ createObservation: { observation: { id: string } } }>(
          createObservation({
            programId,
            targetIds: [target.createTarget.target.id],
            subtitle,
          }),
        );
        ids.push(created.createObservation.observation.id);
      }
      return { programId, first: ids[0]!, second: ids[1]! };
    },
  );

  const session = new StandardSession(pi!);
  const context = await browser.newContext();
  await session.inject(context);
  const page = await context.newPage();

  const atObservations = async () => {
    await page.goto(`/${programId}/observations`);
    await expect(ui.obsTreeAddObservationButton(page)).toBeVisible({ timeout: 120_000 });
    await treeListsObservations();
  };

  // Explore stores the preference over its websocket without waiting; reloading before the
  // row is written is a race, so the reload follows Hasura, not the keypress.
  const expectStoredUnits = (symbol: string) =>
    eventually(`Hasura to hold ${symbol}`, async () =>
      (await globalPreferences(pi!.userId))?.wavelengthUnits === UNIT_TAGS[symbol] ? true : undefined,
    );

  try {
    await atObservations();

    await test.step("t, n, r and o switch tabs", async () => {
      for (const [key, path] of [
        ["t", "targets"],
        ["n", "constraints"],
        ["r", "proposal"],
        ["o", "observations"],
      ]) {
        await page.keyboard.press(key!);
        await expect(page).toHaveURL(new RegExp(`/${programId}/${path}$`));
      }
    });

    await test.step("j and k walk the obs tree in screen order; s returns to the summary", async () => {
      // The tab binds j/k/s once the program's observations are loaded (ObsTabContents.scala),
      // which the tree listing them is the visible proof of; a key pressed before that is lost.
      await treeListsObservations();
      // Focusing an observation also focuses its target (the editor opens on it), so the URL
      // settles on the target route; waiting for that is what keeps the next key from landing
      // while the tab is still rebinding its hotkeys to the new focus.
      const focusedOn = (id: string) =>
        new RegExp(`/${programId}/observation/${id}/target/[^/]+$`);
      await page.keyboard.press("j");
      await expect(page).toHaveURL(focusedOn(first));
      await page.keyboard.press("j");
      await expect(page).toHaveURL(focusedOn(second));
      await page.keyboard.press("k");
      await expect(page).toHaveURL(focusedOn(first));
      await page.keyboard.press("s");
      await expect(page).toHaveURL(new RegExp(`/${programId}/observations$`));
    });

    await test.step("y copies the focused observation and p pastes a clone of it", async () => {
      await page.goto(`/${programId}/observation/${first}`);
      await expect(ui.obsTreeAddObservationButton(page)).toBeVisible({ timeout: 120_000 });
      await page.keyboard.press("y");
      await expect(ui.copiedObservationToast(page, first)).toBeVisible();
      await page.keyboard.press("p");

      const original = (await observationRows()).find((o) => o.id === first)!;
      const clone = await eventually("the pasted clone to exist in the ODB", async () => {
        const rows = await observationRows();
        return rows.find((o) => o.id !== first && o.id !== second);
      });
      expect(clone.subtitle).toBe(original.subtitle);
      expect(clone.targetEnvironment.asterism.map((t) => t.id)).toEqual(
        original.targetEnvironment.asterism.map((t) => t.id),
      );
    });

    await test.step("w cycles the wavelength units, and the preference survives a reload", async () => {
      await openUserPreferences(page);
      const start = (await ui.wavelengthUnitsSelected(page).innerText()).trim();
      expect(WAVELENGTH_UNITS, `a known unit, got ${start}`).toContain(start);
      await closeUserPreferences(page);
      const next = WAVELENGTH_UNITS[(WAVELENGTH_UNITS.indexOf(start) + 1) % 3]!;

      await page.keyboard.press("w");
      await expectStoredUnits(next);
      await atObservations();
      await openUserPreferences(page);
      await expect(ui.wavelengthUnitsSelected(page)).toHaveText(next);
      await closeUserPreferences(page);

      // Round the ring so the persona's preference ends where it started.
      await page.keyboard.press("w");
      await page.keyboard.press("w");
      await expectStoredUnits(start);
      await atObservations();
      await openUserPreferences(page);
      await expect(ui.wavelengthUnitsSelected(page)).toHaveText(start);
      await closeUserPreferences(page);
    });

    await test.step("F1 opens the shortcuts help, Escape closes it", async () => {
      // `?` is advertised too (shortcuts.md) but dead: react-hotkeys-hook 5 matches on the key
      // *code*, so Explore's `shift+?` binding never fires, and the `shift+slash` twin it
      // also registers is not handled by the callback (ExploreLayout.scala). Pressing it is a
      // no-op, verified with a real shifted keypress; an upstream fix would add it here.
      await page.keyboard.press("F1");
      await expect(ui.helpSidebar(page)).toBeVisible();
      await expect(ui.helpHeading(page, /^Shortcuts$/)).toBeVisible({ timeout: 60_000 });
      await page.keyboard.press("Escape");
      await expect(ui.helpSidebar(page)).toBeHidden();
    });
  } finally {
    await context.close();
  }

  async function treeListsObservations(): Promise<void> {
    await expect(page.getByText("shortcuts first").first()).toBeVisible({ timeout: 60_000 });
  }

  async function observationRows(): Promise<ObservationRow[]> {
    const data = await odb.run<{ observations: { matches: ObservationRow[] } }>(
      observationsQuery({ programId }),
    );
    return data.observations.matches;
  }
});
