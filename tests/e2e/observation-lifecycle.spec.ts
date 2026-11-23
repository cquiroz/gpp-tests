import { expect, test } from "@playwright/test";
import { MODE_TARGETS } from "../../lib/observing-modes.js";
import {
  createObservation,
  createProgram,
  createTarget,
  gmosNorthLongSlit,
  observationWorkflow as observationWorkflowQuery,
  observations as observationsQuery,
} from "../../lib/odb-operations.js";
import { eventually } from "../support/odb.js";
import * as ui from "../support/selectors.js";
import { StandardSession, loadStandardUser } from "../support/standard-users.js";

/**
 * An observation's lifecycle from the obs tree card (`ObsBadge.scala`), as a PI: duplicate,
 * deactivate and reactivate through the workflow state dropdown, and delete through its
 * confirmation. Every step is read back from the ODB, so a card that looks right over a
 * mutation that failed still fails the test. Creation is covered by the journey.
 */

const pi = loadStandardUser("TEST_PI");
const polling = { timeoutMs: 60_000, intervalMs: 1_000 };

interface ObservationRows {
  observations: { matches: { id: string }[] };
}

interface WorkflowRow {
  observation: { workflow: { calculationState: string; value: { state: string } } };
}

const stateLabel = (state: string): string => state.charAt(0) + state.slice(1).toLowerCase();

test("an observation can be duplicated, deactivated, reactivated and deleted from its card", async ({
  browser,
}) => {
  test.skip(!pi, "no fabricated standard users — run stack/scripts/create-standard-users.sh");

  const odb = new StandardSession(pi!).client();

  const { programId, observationId } = await test.step(
    "seed: a GMOS North long slit observation with a target",
    async () => {
      const program = await odb.run<{ createProgram: { program: { id: string } } }>(
        createProgram({ name: `gpp-tests observation lifecycle ${Date.now()}` }),
      );
      const programId = program.createProgram.program.id;
      const target = await odb.run<{ createTarget: { target: { id: string } } }>(
        createTarget({ programId, target: MODE_TARGETS.optical }),
      );
      const created = await odb.run<{ createObservation: { observation: { id: string } } }>(
        createObservation({
          programId,
          targetIds: [target.createTarget.target.id],
          subtitle: "lifecycle",
          observingMode: gmosNorthLongSlit(),
        }),
      );
      return { programId, observationId: created.createObservation.observation.id };
    },
  );

  const listed = async () =>
    (await odb.run<ObservationRows>(observationsQuery({ programId }))).observations.matches.map((o) => o.id);
  const settledState = (id: string) =>
    eventually(`the ODB to settle the workflow of ${id}`, async () => {
      const { workflow } = (await odb.run<WorkflowRow>(observationWorkflowQuery({ observationId: id })))
        .observation;
      return workflow.calculationState === "READY" ? workflow.value.state : undefined;
    }, polling);
  const stateBecomes = (id: string, expected: string) =>
    eventually(`${id} to be ${expected}`, async () => {
      const state = await settledState(id);
      return state === expected ? state : undefined;
    }, polling);

  const context = await browser.newContext();
  await new StandardSession(pi!).inject(context);
  const page = await context.newPage();

  try {
    await page.goto(`/${programId}/observations`);
    const badge = ui.obsBadgeById(page, observationId);
    await expect(badge).toBeVisible({ timeout: 120_000 });

    const clone = await test.step("Duplicate clones at once, with no sequence dialog", async () => {
      await ui.obsBadgeDuplicate(badge).click();
      const clone = await eventually("the ODB to list the clone", async () => {
        const added = (await listed()).filter((id) => id !== observationId);
        return added.length === 1 ? added[0] : undefined;
      }, polling);
      await expect(ui.sequenceCopyDialog(page)).toBeHidden();
      await expect(ui.obsBadgeById(page, clone)).toBeVisible();
      return clone;
    });

    await test.step("Inactive in the state dropdown deactivates; the earlier state reactivates", async () => {
      const original = await settledState(observationId);
      expect(original).not.toBe("INACTIVE");
      await expect(ui.obsBadgeStateLabel(badge)).toHaveText(stateLabel(original));

      await ui.obsBadgeState(badge).click();
      await ui.dropdownPanelOption(page, "Inactive").click();
      await stateBecomes(observationId, "INACTIVE");
      await expect(ui.obsBadgeStateLabel(badge)).toHaveText("Inactive");

      await ui.obsBadgeState(badge).click();
      await ui.dropdownPanelOption(page, stateLabel(original)).click();
      await stateBecomes(observationId, original);
      await expect(ui.obsBadgeStateLabel(badge)).toHaveText(stateLabel(original));
    });

    await test.step("Delete asks first, then removes only the clone", async () => {
      const cloneBadge = ui.obsBadgeById(page, clone);
      await ui.obsBadgeDelete(cloneBadge).click();
      await ui.confirmDeleteButton(page).click();
      await eventually("the ODB to drop the clone", async () => {
        const ids = await listed();
        return ids.length === 1 && ids[0] === observationId ? ids : undefined;
      }, polling);
      await expect(cloneBadge).toBeHidden();
      await expect(badge).toBeVisible();
    });
  } finally {
    await context.close();
  }
});
