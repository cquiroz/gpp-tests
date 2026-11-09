import { type Locator, type Page, expect, test } from "@playwright/test";
import { createObservation, createProgram, createTarget } from "../../lib/odb-operations.js";
import { eventually } from "../support/odb.js";
import { gridLayoutPositions, tablePreferences } from "../support/prefs.js";
import * as ui from "../support/selectors.js";
import { StandardSession, loadStandardUser } from "../support/standard-users.js";

/**
 * Layout preferences through Hasura: the grid layout of the observation editor's tiles
 * (`TileController.scala`, one row per tile, section and breakpoint in
 * `lucumaGridLayoutPositions`, written through a 1 s throttle), a minimized tile (stored as
 * height 1 of that same row), the Observations Summary table's state (`lucumaTablePreferences`,
 * the TanStack state as JSON) and the "Reset Tile Layouts" button of User Preferences, which
 * deletes every layout row. Each change is read back from Hasura before the reload, so the
 * reload asserts the round trip rather than racing the websocket write.
 *
 * The persona persists between runs, so the spec resets the layouts first and again at the
 * end, the second time as the assertion that the reset deletes the rows.
 */

const pi = loadStandardUser("TEST_PI");

/** Hasura's row height for a minimized tile (`TileController.scala`: `h = 1`). */
const MINIMIZED = 1;
/** Two grid rows, the resize under test (`Constants.GridRowHeight` is 36 px). */
const RESIZE_ROWS = 2;
const RESIZE_PX = RESIZE_ROWS * 36;

const polling = { timeoutMs: 60_000, intervalMs: 1_000 };

async function openUserPreferences(page: Page): Promise<void> {
  await ui.mainMenuButton(page).click();
  await ui.userPreferencesMenuItem(page).click();
  await expect(ui.resetTileLayoutsButton(page)).toBeVisible();
}

async function closeUserPreferences(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(ui.resetTileLayoutsButton(page)).toBeHidden();
}

async function resetTileLayouts(page: Page, userId: string): Promise<void> {
  await openUserPreferences(page);
  await ui.resetTileLayoutsButton(page).click();
  await expect(page.getByText(/Layouts reset/)).toBeVisible();
  await eventually("Hasura to hold no layout row for the ITC tile", async () =>
    (await gridLayoutPositions(userId, "itc")).length === 0 ? true : undefined, polling);
  await closeUserPreferences(page);
}

async function heightOf(tile: Locator): Promise<number> {
  return (await tile.boundingBox())!.height;
}

test("tile layouts, a minimized tile and the summary table's state persist through Hasura, and Reset Tile Layouts clears them", async ({
  browser,
}) => {
  test.skip(!pi, "no fabricated standard users — run stack/scripts/create-standard-users.sh");

  const odb = new StandardSession(pi!).client();
  const userId = pi!.userId;

  const { programId, observationId } = await test.step(
    "seed: a program with one observation on one target",
    async () => {
      const program = await odb.run<{ createProgram: { program: { id: string } } }>(
        createProgram({ name: `gpp-tests layouts ${Date.now()}` }),
      );
      const programId = program.createProgram.program.id;
      const target = await odb.run<{ createTarget: { target: { id: string } } }>(
        createTarget({ programId, name: "layouts target" }),
      );
      const created = await odb.run<{ createObservation: { observation: { id: string } } }>(
        createObservation({
          programId,
          targetIds: [target.createTarget.target.id],
          subtitle: "layouts",
        }),
      );
      return { programId, observationId: created.createObservation.observation.id };
    },
  );

  const session = new StandardSession(pi!);
  const context = await browser.newContext();
  await session.inject(context);
  const page = await context.newPage();

  const itc = ui.tile(page, /^ITC$/);
  const openEditor = async () => {
    await page.goto(`/${programId}/observation/${observationId}`);
    await expect(ui.obsTreeAddObservationButton(page)).toBeVisible({ timeout: 120_000 });
    await expect(itc).toBeVisible({ timeout: 60_000 });
  };
  const openSummary = async () => {
    await page.goto(`/${programId}/observations`);
    await expect(ui.obsTreeAddObservationButton(page)).toBeVisible({ timeout: 120_000 });
    await expect(ui.columnsButton(page)).toBeVisible({ timeout: 60_000 });
  };
  const itcRows = () => gridLayoutPositions(userId, "itc");

  try {
    await openEditor();

    await test.step("start from the default layouts", async () => {
      await resetTileLayouts(page, userId);
      await openEditor();
      await expect(ui.tileStateIcon(itc)).toHaveAttribute("data-icon", "compress");
    });

    const defaultHeight = await heightOf(itc);

    await test.step("minimizing a tile stores height 1 and survives a reload", async () => {
      await ui.tileStateButton(itc).click();
      await expect(ui.tileStateIcon(itc)).toHaveAttribute("data-icon", "expand");
      await eventually("Hasura to hold the ITC tile at height 1 on every breakpoint", async () => {
        const rows = await itcRows();
        return rows.length > 0 && rows.every((r) => r.height === MINIMIZED) ? true : undefined;
      }, polling);
      await openEditor();
      await expect(ui.tileStateIcon(itc)).toHaveAttribute("data-icon", "expand");
      await expect(itc.locator(".explore-tile-body")).toHaveCount(0);
    });

    await test.step("restoring it stores the full height again, across a reload", async () => {
      await ui.tileStateButton(itc).click();
      await expect(ui.tileStateIcon(itc)).toHaveAttribute("data-icon", "compress");
      await eventually("Hasura to hold the ITC tile taller than 1 on every breakpoint", async () => {
        const rows = await itcRows();
        return rows.length > 0 && rows.every((r) => r.height > MINIMIZED) ? true : undefined;
      }, polling);
      await openEditor();
      await expect(ui.tileStateIcon(itc)).toHaveAttribute("data-icon", "compress");
      expect(await heightOf(itc)).toBeCloseTo(defaultHeight, 0);
    });

    await test.step("resizing a tile by two rows is stored for the active breakpoint and survives a reload", async () => {
      const before = new Map((await itcRows()).map((r) => [r.breakpointName, r.height]));
      const handle = ui.tileResizeHandle(itc);
      await handle.scrollIntoViewIfNeeded();
      const box = (await handle.boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + RESIZE_PX / 2, { steps: 5 });
      await page.mouse.move(x, y + RESIZE_PX, { steps: 5 });
      await page.mouse.up();
      const resized = await heightOf(itc);
      expect(resized).toBeGreaterThan(defaultHeight);

      await eventually("Hasura to hold the ITC tile two rows taller on the active breakpoint", async () => {
        const rows = await itcRows();
        return rows.some((r) => r.height === before.get(r.breakpointName)! + RESIZE_ROWS)
          ? true
          : undefined;
      }, polling);
      await openEditor();
      expect(await heightOf(itc)).toBeCloseTo(resized, 0);
    });

    await test.step("the Observations Summary's shown columns and sort are stored and survive a reload", async () => {
      await openSummary();
      const ra = ui.summaryTableHeader(page, /^RA/);
      const targetsHeader = ui.summaryTableHeader(page, /^Targets/);
      const storedTable = async () =>
        (await tablePreferences(userId)).find(
          (r) => r.tableId.toLowerCase() === "observations_summary",
        );

      // Reset Tile Layouts leaves table state alone, so the persona carries it between runs:
      // each run flips RA and moves the sort one notch (ascending, descending, none) and
      // asserts whichever state that produces.
      const raShown = await ra.isVisible();
      const sortBefore = JSON.stringify((await storedTable())?.preferences.sorting ?? []);
      await ui.columnsButton(page).click();
      await ui.columnToggle(page, "ra").click();
      await page.keyboard.press("Escape");
      await expect(ra).toHaveCount(raShown ? 0 : 1);
      await targetsHeader.locator("div").first().click();

      const stored = await eventually(
        "Hasura to hold the flipped RA column and the next sort",
        async () => {
          const row = await storedTable();
          const sorting = JSON.stringify(row?.preferences.sorting ?? []);
          return row?.preferences.columnVisibility?.ra === !raShown && sorting !== sortBefore
            ? row
            : undefined;
        },
        polling,
      );

      await openSummary();
      await expect(ra).toHaveCount(raShown ? 0 : 1);
      const sorted = stored.preferences.sorting?.[0];
      const sortIcon = targetsHeader.locator("svg[data-icon^='sort-']");
      if (sorted?.id === "target") {
        await expect(sortIcon).toHaveAttribute("data-icon", sorted.desc ? "sort-down" : "sort-up");
      } else {
        await expect(sortIcon).toHaveCount(0);
      }
    });

    await test.step("Reset Tile Layouts deletes the stored rows and the default layout returns", async () => {
      await openEditor();
      await resetTileLayouts(page, userId);
      await openEditor();
      expect(await heightOf(itc)).toBeCloseTo(defaultHeight, 0);
    });
  } finally {
    await context.close();
  }
});
