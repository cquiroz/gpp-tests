import { type Page, expect, test } from "@playwright/test";
import {
  gmosNorthLongSlit,
  observation as observationQuery,
  observationCalculated,
  observations as observationsQuery,
  programs as programsQuery,
  setObservingMode,
  targets as targetsQuery,
  updateObservationSubtitle,
  updateTargetToTestTarget,
} from "../../lib/odb-operations.js";
import { GuestSession, type OdbClient, eventually } from "./odb.js";
import * as ui from "./selectors.js";
import {
  StandardSession,
  type StandardUser,
  loadStandardUser,
} from "./standard-users.js";

/**
 * The v1 regression journey (spec §5), parameterized by identity so the same four scenarios
 * run as a guest and as fabricated standard users (research/orcid-auth-testing-strategy.md
 * tiers 2-3). One `defineJourney` call per spec file: the file is the serial unit, a retry
 * re-runs the whole chain, and the per-file split is what lets the journeys parallelize
 * later without touching this module.
 *
 * Scenario titles become ledger rows via `lib/summary.js` (`spec.title`, nothing else), so
 * the guest identity keeps the exact historical titles and every other identity must carry
 * a distinguishing suffix.
 */

export interface JourneyIdentity {
  /** Appended to scenario 2-4 titles. Empty for the canonical guest journey. */
  titleSuffix: string;
  /** The full scenario 1 title — the login mechanics differ per identity. */
  loginTitle: string;
  /** Set when the identity cannot run (fabrication script not run); skips the whole file. */
  skipReason?: string;
  /** Guests get a program auto-created at first login; standard users do not. */
  expectAutoCreatedProgram: boolean;
  /** Performs the login and returns the read-back client for the same identity. */
  login(page: Page): Promise<OdbClient>;
  /** Proves the logged-in shell rendered (both websockets up) for this identity. */
  assertLoggedIn(page: Page): Promise<void>;
}

export function guestIdentity(): JourneyIdentity {
  return {
    titleSuffix: "",
    loginTitle: "scenario 1: login as guest",
    expectAutoCreatedProgram: true,
    async login(page) {
      // Attach before the login click: the JWT Explore receives is the one read-backs use.
      const session = GuestSession.watch(page);
      await page.goto("/");
      await ui.guestLoginButton(page).click();
      return session.client();
    },
    async assertLoggedIn(page) {
      // Explore only renders past the spinner once *both* the ODB and the prefs websockets
      // have connected, so this assertion also covers the Hasura service being reachable.
      await expect(ui.obsTreeAddObservationButton(page)).toBeVisible({
        timeout: 120_000,
      });
    },
  };
}

export function standardIdentity(
  prefix: "TEST_PI" | "TEST_STAFF",
  roleName: string,
  toolbarLabel: RegExp,
): JourneyIdentity {
  const user: StandardUser | undefined = loadStandardUser(prefix);
  return {
    titleSuffix: ` [${roleName}]`,
    loginTitle: `scenario 1: login by injected session [${roleName}]`,
    skipReason: user
      ? undefined
      : "no fabricated standard users — run stack/scripts/create-standard-users.sh",
    expectAutoCreatedProgram: false,
    async login(page) {
      const session = new StandardSession(user!);
      await session.inject(page.context());
      await page.goto("/");
      return session.client();
    },
    async assertLoggedIn(page) {
      // No auto-selected program here, so the obs tree may not exist yet — the toolbar
      // identity label is the shell-rendered proof, and the absent login dialog is what
      // separates "the cookie logged us in" from "the dialog is still deciding".
      await expect(ui.toolbarUserLabel(page, toolbarLabel)).toBeVisible({
        timeout: 120_000,
      });
      await expect(ui.guestLoginButton(page)).toBeHidden();
    },
  };
}

export function defineJourney(identity: JourneyIdentity): void {
  test.describe.configure({ mode: "serial" });

  if (identity.skipReason) {
    test.skip(() => true, identity.skipReason);
  }

  const t = (title: string) => `${title}${identity.titleSuffix}`;

  const SUBTITLE = "odbattr scenario-3";
  const EDITED_SUBTITLE = "odbattr scenario-4 edited";

  let page: Page;
  let odb: OdbClient;

  /** Carried between the chained scenarios. */
  const journey: {
    programsAtLogin: string[];
    createdProgramId?: string;
    observationId?: string;
    targetId?: string;
  } = { programsAtLogin: [] };

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await page?.context().close();
  });

  test(identity.loginTitle, async () => {
    await test.step("log in", async () => {
      odb = await identity.login(page);
    });

    await test.step("the logged-in shell renders", async () => {
      await identity.assertLoggedIn(page);
    });

    await test.step("read back: the identity can query its programs", async () => {
      const data = await odb.run(programsQuery({}));
      const matches = data.programs.matches as { id: string }[];
      if (identity.expectAutoCreatedProgram) {
        // On first login with no programs Explore creates one for the guest.
        expect(matches.length).toBeGreaterThanOrEqual(1);
      }
      journey.programsAtLogin = matches.map((p) => p.id);
    });
  });

  test(t("scenario 2: create a program"), async () => {
    await test.step("Proposals & Programs → create", async () => {
      // The two identities reach the dialog differently, and the guest's path does not
      // exist for standard users: their toolbar menu has no "Manage Programs" item at all
      // (it is About / Preferences / Redeem invitations / Logout). A standard user landing
      // with no program selected gets the dialog opened for them instead — it may still be
      // rendering when this scenario starts, hence the generous wait.
      if (identity.expectAutoCreatedProgram) {
        await ui.mainMenuButton(page).click();
        await ui.managePrograms(page).click();
      }
      await expect(ui.programsDialog(page)).toBeVisible({ timeout: 15_000 });
      await ui.createProgramButton(page).click();
    });

    await test.step("read back: a new program appears in the programs query", async () => {
      journey.createdProgramId = await eventually(
        "the new program to appear in the ODB",
        async () => {
          const data = await odb.run(programsQuery({}));
          const ids = (data.programs.matches as { id: string }[]).map((p) => p.id);
          return ids.find((id) => !journey.programsAtLogin.includes(id));
        },
        { timeoutMs: 30_000, intervalMs: 1_000 },
      );
    });

    await test.step("the UI lists it too, by id", async () => {
      await expect(ui.programRow(page, journey.createdProgramId!)).toBeVisible();
    });

    await test.step("open it, which closes the dialog", async () => {
      // Not optional housekeeping: creating a program leaves the dialog up, and its modal mask
      // intercepts every click behind it — the observation tree is unreachable until the dialog
      // is gone. Selecting the row is also how a user would get to their new program.
      await ui.selectProgramButton(page, journey.createdProgramId!).click();
      await expect(ui.programsDialog(page)).toBeHidden();
      await expect(page).toHaveURL(new RegExp(journey.createdProgramId!));
      await expect(ui.obsTreeAddObservationButton(page)).toBeVisible();
    });
  });

  test(t("scenario 3: create an observation with a target and configuration"), async () => {
    const programId = journey.createdProgramId!;
    expect(programId, "scenario 2 must have created a program").toBeTruthy();

    await test.step("add an observation from the obs tree", async () => {
      await ui.obsTreeAddObservationButton(page).click();
    });

    await test.step("read back: the observation exists in the new program", async () => {
      journey.observationId = await eventually(
        "the new observation to appear in the ODB",
        async () => {
          const data = await odb.run(observationsQuery({ programId }));
          const matches = data.observations.matches as { id: string }[];
          return matches[0]?.id;
        },
        { timeoutMs: 60_000, intervalMs: 2_000 },
      );
    });

    await test.step("add a manual sidereal target — no catalog lookup", async () => {
      await ui.addTargetButton(page).click();
      await ui.emptySiderealTargetItem(page).click();
    });

    await test.step("read back: the target is in the program and in the asterism", async () => {
      journey.targetId = await eventually(
        "the new target to appear in the ODB",
        async () => {
          const data = await odb.run(targetsQuery({ programId }));
          const matches = data.targets.matches as { id: string }[];
          return matches[0]?.id;
        },
        { timeoutMs: 60_000, intervalMs: 2_000 },
      );

      const observation = await eventually(
        "the target to join the observation's asterism",
        async () => {
          const data = await odb.run(
            observationQuery({ observationId: journey.observationId! }),
          );
          const asterism = data.observation.targetEnvironment.asterism as {
            id: string;
          }[];
          return asterism.some((t) => t.id === journey.targetId)
            ? data.observation
            : undefined;
        },
        { timeoutMs: 60_000, intervalMs: 2_000 },
      );
      expect(observation.targetEnvironment.asterism).toHaveLength(1);
    });

    await test.step("give the target the v1 coordinates and brightness", async () => {
      // Explore's "Empty Sidereal Target" lands with placeholder coordinates and no
      // brightness. The hardcoded v1 fixture is written through the API: typing into the
      // coordinate editor depends on labels that move, and the ITC needs a brightness before
      // it can produce anything for the assertion below.
      const data = await odb.run(
        updateTargetToTestTarget({ targetId: journey.targetId! }),
      );
      expect(data.updateTargets.targets).toHaveLength(1);
      expect(data.updateTargets.targets[0].sidereal.epoch).toBe("J2000.000");
    });

    await test.step("select a minimal GMOS long-slit mode", async () => {
      // Also through the API, for the same reason: Explore's configuration tile has no stable
      // selectors today (spec §10 ask 1). What matters for regression detection is that the
      // ODB accepts the mode and that ITC + obscalc then produce results, asserted next.
      const data = await odb.run(
        setObservingMode({
          observationId: journey.observationId!,
          observingMode: gmosNorthLongSlit(),
        }),
      );
      const updated = data.updateObservations.observations[0];
      expect(updated.instrument).toBe("GMOS_NORTH");
      expect(updated.observingMode.gmosNorthLongSlit.fpu).toBe("LONG_SLIT_0_50");
    });

    await test.step("calculated results appear (ITC and obscalc are alive)", async () => {
      // The end-to-end liveness check of the two background services: obscalc computes the
      // execution digest and the workflow state, and it can only do so once the ITC has
      // answered. Both are asynchronous, hence the poll.
      const digest = await eventually(
        "obscalc to publish an execution digest",
        async () => {
          const data = await odb.run(
            observationCalculated({ observationId: journey.observationId! }),
          );
          const calculated = data.observation.execution.digest;
          return calculated?.calculationState === "READY" && calculated.value
            ? calculated.value
            : undefined;
        },
        { timeoutMs: 300_000, intervalMs: 5_000 },
      );

      expect(Number(digest.estimate.total.total.seconds)).toBeGreaterThan(0);
      expect(digest.science.atomCount).toBeGreaterThan(0);
    });
  });

  test(t("scenario 4: edit the subtitle and read it back after a reload"), async () => {
    const observationId = journey.observationId!;
    expect(observationId, "scenario 3 must have created an observation").toBeTruthy();

    await test.step("set a subtitle to edit", async () => {
      // Seeded through the API so the step under test is an *edit* of an existing subtitle.
      // The badge picking this up is itself worth asserting: it only happens through Explore's
      // `observationEdit` subscription, so it exercises the websocket path the UI relies on.
      await odb.run(updateObservationSubtitle({ observationId, subtitle: SUBTITLE }));
      await expect(ui.obsBadgeSubtitle(page)).toHaveText(SUBTITLE, {
        timeout: 60_000,
      });
    });

    await test.step("edit it inline on the observation card", async () => {
      await ui.obsBadgeSubtitleEdit(page).click();
      const input = ui.obsBadgeSubtitleInput(page);
      await expect(input).toBeEditable();
      await input.fill(EDITED_SUBTITLE);
      await input.press("Enter");
    });

    await test.step("read back: the ODB has the new subtitle", async () => {
      await eventually(
        "the edited subtitle to reach the ODB",
        async () => {
          const data = await odb.run(observationQuery({ observationId }));
          return data.observation.subtitle === EDITED_SUBTITLE ? true : undefined;
        },
        { timeoutMs: 60_000, intervalMs: 2_000 },
      );
    });

    await test.step("it survives a full page reload", async () => {
      await page.reload();
      await expect(ui.obsBadgeSubtitle(page)).toHaveText(EDITED_SUBTITLE, {
        timeout: 120_000,
      });

      const data = await odb.run(observationQuery({ observationId }));
      expect(data.observation.subtitle).toBe(EDITED_SUBTITLE);
    });
  });
}
