import { expect, test } from "@playwright/test";
import { MODE_TARGETS } from "../../lib/observing-modes.js";
import {
  createObservation,
  createProgram,
  createTarget,
  gmosNorthLongSlit,
  observationExecution as observationExecutionQuery,
  observations as observationsQuery,
} from "../../lib/odb-operations.js";
import { executeFirstStep, serviceJwt } from "../support/execution.js";
import { eventually } from "../support/odb.js";
import * as ui from "../support/selectors.js";
import { StandardSession, loadStandardUser } from "../support/standard-users.js";

/**
 * The sequence copy dialog (`SequenceCopyDialog.scala`): duplicating an observation whose
 * sequence is materialized (executed, here) asks what to copy, and each choice is the
 * `sequence` mode of the ODB's `cloneObservation` (`NONE`, `ALL_STEPS`, `PENDING_STEPS`).
 * The clone's execution flags are read back from the ODB for each choice taken.
 *
 * Only the obs badge's Duplicate button goes through the dialog; the `p` paste shortcut
 * always clones with `NONE` (`keyboard-shortcuts.spec.ts`). Staff drive it because an
 * executed observation is read-only for a PI; the execution itself is recorded with the
 * service JWT (`tests/support/execution.ts`).
 */

const staff = loadStandardUser("TEST_STAFF");

interface ExecutionRow {
  observation: {
    execution: {
      executionState: string;
      acquisitionSequenceIsMaterialized: boolean;
      scienceSequenceIsMaterialized: boolean;
    };
  };
}

interface ObservationRows {
  observations: { matches: { id: string }[] };
}

test("duplicating an executed observation asks which steps to copy, and each choice clones accordingly", async ({
  browser,
}) => {
  test.skip(!staff, "no fabricated standard users — run stack/scripts/create-standard-users.sh");
  test.skip(!serviceJwt, "ODB_SERVICE_JWT is not set — source stack/.env.generated");

  const odb = new StandardSession(staff!).client();
  const execution = async (observationId: string) =>
    (await odb.run<ExecutionRow>(observationExecutionQuery({ observationId }))).observation.execution;
  const polling = { timeoutMs: 60_000, intervalMs: 1_000 };

  const { programId, observationId } = await test.step(
    "seed: a GMOS North long slit observation with one executed step",
    async () => {
      const program = await odb.run<{ createProgram: { program: { id: string } } }>(
        createProgram({ name: `gpp-tests sequence copy ${Date.now()}` }),
      );
      const programId = program.createProgram.program.id;
      const target = await odb.run<{ createTarget: { target: { id: string } } }>(
        createTarget({ programId, target: MODE_TARGETS.optical }),
      );
      const created = await odb.run<{ createObservation: { observation: { id: string } } }>(
        createObservation({
          programId,
          targetIds: [target.createTarget.target.id],
          subtitle: "executed",
          observingMode: gmosNorthLongSlit(),
        }),
      );
      const observationId = created.createObservation.observation.id;
      await executeFirstStep(observationId);
      const flags = await execution(observationId);
      expect(flags.acquisitionSequenceIsMaterialized).toBe(true);
      expect(flags.executionState).toBe("ONGOING");
      return { programId, observationId };
    },
  );

  const listed = async () =>
    (await odb.run<ObservationRows>(observationsQuery({ programId }))).observations.matches.map((o) => o.id);
  const newObservationBeyond = (known: string[]) =>
    eventually("the ODB to list the clone", async () => {
      const ids = await listed();
      const added = ids.filter((id) => !known.includes(id));
      return added.length === 1 ? added[0] : undefined;
    }, polling);

  const context = await browser.newContext();
  await new StandardSession(staff!).inject(context);
  const page = await context.newPage();

  try {
    await page.goto(`/${programId}/observations`);
    await expect(ui.obsBadge(page, observationId)).toBeVisible({ timeout: 120_000 });
    const duplicate = () => ui.duplicateObservationButton(ui.obsBadge(page, observationId)).click();

    await test.step("Duplicate opens the dialog with all three choices; Cancel clones nothing", async () => {
      await duplicate();
      await expect(ui.sequenceCopyDialog(page)).toBeVisible();
      for (const choice of ["generate-new", "pending-steps", "all-steps"] as const) {
        await expect(ui.sequenceCopyChoice(page, choice)).toBeVisible();
      }
      await ui.sequenceCopyChoice(page, "cancel").click();
      await expect(ui.sequenceCopyDialog(page)).toBeHidden();
      await page.waitForTimeout(2_000);
      expect(await listed()).toEqual([observationId]);
    });

    const withAllSteps = await test.step("Copy all steps clones with the sequence materialized", async () => {
      const known = await listed();
      await duplicate();
      await ui.sequenceCopyChoice(page, "all-steps").click();
      await expect(ui.sequenceCopyDialog(page)).toBeHidden();
      const clone = await newObservationBeyond(known);
      await expect(ui.obsBadge(page, clone)).toBeVisible();
      const flags = await execution(clone);
      expect(flags.acquisitionSequenceIsMaterialized).toBe(true);
      expect(flags.executionState).toBe("NOT_STARTED");
      return clone;
    });

    await test.step("Generate new clones with a fresh, unmaterialized sequence", async () => {
      const known = await listed();
      await duplicate();
      await ui.sequenceCopyChoice(page, "generate-new").click();
      await expect(ui.sequenceCopyDialog(page)).toBeHidden();
      const clone = await newObservationBeyond(known);
      expect(clone).not.toBe(withAllSteps);
      await expect(ui.obsBadge(page, clone)).toBeVisible();
      const flags = await execution(clone);
      expect(flags.acquisitionSequenceIsMaterialized).toBe(false);
      expect(flags.scienceSequenceIsMaterialized).toBe(false);
    });
  } finally {
    await context.close();
  }
});
