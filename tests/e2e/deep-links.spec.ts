import { expect, test } from "@playwright/test";
import {
  TEST_CALL,
  createObservation,
  createProgram,
  createTarget,
  observationByReference,
  programByReference,
  setProgramReference,
} from "../../lib/odb-operations.js";
import * as ui from "../support/selectors.js";
import { StandardSession, loadStandardUser } from "../support/standard-users.js";

/**
 * Deep links: a reference label in the URL (`/G-2026A-0001-Q`, `/G-2026A-0001-Q-0001`)
 * opens the page it names. Explore's router matches the three reference formats before any
 * id route (`Routing.scala`), resolves the label through the ODB
 * (`ProgramReferenceResolver.scala`, `ObsReferenceResolver.scala`) and replaces the URL with
 * the id route of the Overview or the observation; an unknown label raises a toast and falls
 * back to the landing. The proposal reference, which only a submission mints, is covered at
 * the end of `proposals.spec.ts` scenario 5.
 *
 * References are not something Explore creates: a program reference is a staff mutation
 * (`setProgramReference`), and the observation reference follows from it. So the fixture
 * needs both personas — staff to mint, the PI to own and to browse. The reference minted is
 * an *engineering* one (`G-2026A-ENG-GMOSN-01`): the ODB formats a science reference only
 * for an accepted proposal (see `setProgramReference` in lib/odb-operations.js), and
 * Explore's router resolves every reference type through the same page.
 */

const pi = loadStandardUser("TEST_PI");
const staff = loadStandardUser("TEST_STAFF");

test("program and observation references in the URL open the page they name", async ({
  browser,
}) => {
  test.skip(
    !pi || !staff,
    "no fabricated standard users — run stack/scripts/create-standard-users.sh",
  );

  const piOdb = new StandardSession(pi!).client();
  const staffOdb = new StandardSession(staff!).client();

  const { programId, observationId } = await test.step(
    "seed: the PI's program with one observation",
    async () => {
      const program = await piOdb.run<{ createProgram: { program: { id: string } } }>(
        createProgram({ name: `gpp-tests deep-links ${Date.now()}` }),
      );
      const programId = program.createProgram.program.id;
      const target = await piOdb.run<{ createTarget: { target: { id: string } } }>(
        createTarget({ programId, name: "deep-links target" }),
      );
      const observation = await piOdb.run<{
        createObservation: { observation: { id: string } };
      }>(
        createObservation({
          programId,
          targetIds: [target.createTarget.target.id],
          subtitle: "deep-links",
        }),
      );
      return { programId, observationId: observation.createObservation.observation.id };
    },
  );

  const { programRef, observationRef } = await test.step(
    "staff mint a program reference, and the ODB resolves both labels",
    async () => {
      const minted = await staffOdb.run<{
        setProgramReference: { reference: { label: string } | null };
      }>(setProgramReference({ programId, semester: TEST_CALL.semester }));
      const programRef = minted.setProgramReference.reference?.label;
      expect(programRef, "an engineering program reference").toMatch(/^G-\d{4}[AB]-ENG-/);

      // The first observation of a program is index 1. Resolving the label back to the ids
      // is the same lookup Explore's resolvers perform; it pins the ODB side before the
      // browser is involved.
      const observationRef = `${programRef}-0001`;
      const byProgramRef = await piOdb.run<{ program: { id: string } | null }>(
        programByReference({ programReference: programRef! }),
      );
      expect(byProgramRef.program?.id).toBe(programId);
      const byObsRef = await piOdb.run<{
        observation: { id: string; program: { id: string } } | null;
      }>(observationByReference({ observationReference: observationRef }));
      expect(byObsRef.observation?.id).toBe(observationId);
      expect(byObsRef.observation?.program.id).toBe(programId);
      return { programRef: programRef!, observationRef };
    },
  );

  const session = new StandardSession(pi!);
  const context = await browser.newContext();
  await session.inject(context);
  const page = await context.newPage();

  try {
    await test.step("the program reference opens the program's Overview", async () => {
      await page.goto(`/${programRef}`);
      await expect(page).toHaveURL(new RegExp(`/${programId}$`), { timeout: 120_000 });
      // The top bar shows the reference as the program's title once the program is loaded.
      await expect(page.getByText(programRef, { exact: true }).first()).toBeVisible({
        timeout: 60_000,
      });
    });

    await test.step("the observation reference opens that observation", async () => {
      await page.goto(`/${observationRef}`);
      await expect(page).toHaveURL(
        new RegExp(`/${programId}/observation/${observationId}$`),
        { timeout: 120_000 },
      );
      await expect(ui.obsTreeAddObservationButton(page)).toBeVisible({ timeout: 60_000 });
    });

    await test.step("an unknown reference says so and falls back to the landing", async () => {
      await page.goto("/G-2099A-9999-Q");
      await expect(ui.unknownReferenceToast(page)).toBeVisible({ timeout: 60_000 });
      await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
      await expect(ui.loggedInLanding(page)).toBeVisible({ timeout: 60_000 });
    });
  } finally {
    await context.close();
  }
});
