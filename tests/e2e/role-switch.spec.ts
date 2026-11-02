import { type Page, expect, test } from "@playwright/test";
import { createProgram, programDetails } from "../../lib/odb-operations.js";
import { openProgramsDialog } from "../support/journey.js";
import { GraphQLError } from "../support/odb.js";
import * as ui from "../support/selectors.js";
import { StandardSession, loadStandardUser } from "../support/standard-users.js";

/**
 * The role switch in the top bar (`RoleSwitch.scala`): a user holding more than one SSO role
 * picks the active one from a dropdown. Explore calls SSO's `set-role`, which starts a *new*
 * session on the chosen role and replaces the browser's session cookie
 * (lucuma-odb `Routes.scala`), then re-reads `whoami` and resets its program cache.
 *
 * What is observable, and what this spec asserts, is the change of what the user can see: as
 * a PI the persona sees only its own programs; as staff it sees every program in the ODB.
 * The fixture is a program created by a *different* PI, so "out of sight, then listed" is
 * the role taking effect — in Explore's Proposals & Programs dialog and in a GraphQL read-back
 * that runs through the browser's own (rotated) cookie, so both halves are provably the
 * same identity after the switch.
 *
 * Needs the two-role persona (`TEST_DUAL`, a pi and a staff role on one user, session on the
 * pi role) that `stack/scripts/create-standard-users.sh` fabricates since 2026-10-26; an
 * older file skips with the fix named.
 */

const dual = loadStandardUser("TEST_DUAL");
const pi = loadStandardUser("TEST_PI");

/**
 * Whether the identity behind `odb` can see the program: `program(programId:)` is null for a
 * program outside the caller's visibility, which is the ODB's predicate at work; a refusal
 * (error) would say the same thing, so both count as "not visible".
 */
async function canSee(session: StandardSession, programId: string): Promise<boolean> {
  try {
    const data = await session
      .client()
      .run<{ program: { id: string } | null }>(programDetails({ programId }));
    return data.program !== null;
  } catch (error) {
    if (error instanceof GraphQLError) return false;
    throw error;
  }
}

/**
 * Gets the modal Proposals & Programs dialog out of the way, so the top bar is clickable: its
 * mask swallows every click behind it. At landing the dialog is not closable
 * (`ProgramsPopup.scala`: `closable = props.onClose.isDefined`, and there is no program to
 * return to), so selecting a program is the one way through; opened from the menu over a
 * current program, Escape closes it — which is also the case where the only row may be the
 * current program, whose Select is disabled.
 */
async function leaveProgramsDialog(page: Page): Promise<void> {
  const dialog = ui.programsDialog(page);
  if (!(await dialog.isVisible())) return;
  const selectable = dialog.getByTestId("explore-programs-select").and(page.locator(":enabled"));
  if ((await selectable.count()) > 0) {
    await selectable.first().click();
  } else {
    await page.keyboard.press("Escape");
  }
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

test("a user holding two roles switches from PI to staff in the top bar", async ({
  browser,
}) => {
  test.skip(
    !dual || !pi,
    "no two-role persona — run stack/scripts/create-standard-users.sh (TEST_DUAL is new in 2026-10)",
  );

  // The fixture: a program the persona does not own, created by the other PI. Visibility of
  // this one program is the whole assertion.
  const programName = `gpp-tests role-switch ${Date.now()}`;
  const created = await new StandardSession(pi!)
    .client()
    .run<{ createProgram: { program: { id: string } } }>(createProgram({ name: programName }));
  const foreignProgramId = created.createProgram.program.id;

  const session = new StandardSession(dual!);
  const context = await browser.newContext();
  await session.inject(context);
  const page = await context.newPage();

  try {
    await test.step("lands as a PI, and is offered the role dropdown", async () => {
      await page.goto("/");
      await expect(ui.toolbarUserLabel(page, /test\s+dual/i)).toBeVisible({
        timeout: 120_000,
      });
      // The dropdown exists only for a user whose JWT lists other roles (RoleSwitch.scala:
      // `case Some(r) if otherRoles.nonEmpty`), so the single-role personas never see it.
      await expect(ui.roleSwitch(page)).toBeVisible();
      await expect(ui.roleSwitchValue(page)).toHaveValue(/^pi$/i);

      const user = (await session.claims())["lucuma-user"];
      expect(user.role.type).toBe("pi");
      expect(user.role.id).toBe(dual!.roleId);
      expect(user.otherRoles?.map((r) => r.id)).toContain(dual!.staffRoleId);
    });

    await test.step("as a PI, another PI's program is out of sight", async () => {
      expect(await canSee(session, foreignProgramId), "a PI sees only their own programs").toBe(
        false,
      );
      await leaveProgramsDialog(page);
      await openProgramsDialog(page);
      await expect(ui.programRow(page, foreignProgramId)).toHaveCount(0);
      await leaveProgramsDialog(page);
    });

    const cookieBefore = (await context.cookies()).find(
      (c) => c.name === "lucuma-refresh-token",
    )?.value;
    expect(cookieBefore, "the injected session cookie is in the browser").toBe(
      dual!.refreshToken,
    );

    await test.step("switch to staff: SSO replaces the session cookie", async () => {
      await ui.roleSwitch(page).click();
      await page.getByRole("option", { name: /^staff$/i }).click();
      await expect(ui.roleSwitchValue(page)).toHaveValue(/^staff$/i);

      // `set-role` answers with a new session cookie (Routes.scala: `res.addCookie(coo)`).
      // The browser's cookie changing is the proof the switch went through SSO, not just
      // through Explore's local state.
      await expect
        .poll(
          async () =>
            (await context.cookies()).find((c) => c.name === "lucuma-refresh-token")?.value,
          { timeout: 30_000 },
        )
        .not.toBe(cookieBefore);

      // From here on the read-back runs as what the browser has become.
      await session.adoptBrowserCookie(context);
      const user = (await session.claims())["lucuma-user"];
      expect(user.id).toBe(dual!.userId);
      expect(user.role.type).toBe("staff");
      expect(user.role.id).toBe(dual!.staffRoleId);
    });

    await test.step("as staff, that same program opens", async () => {
      expect(await canSee(session, foreignProgramId), "staff see every program").toBe(true);
      // Not through the dialog: staff see every program the stack has ever held, and the
      // table is virtualized (`ProgramTable.scala`: PrimeAutoHeightVirtualizedTable), so a row
      // far down the list has no DOM element to assert on. Opening the program by its id is
      // the same visibility check, and a stronger one — Explore loads it and shows its name.
      await page.goto(`/${foreignProgramId}/observations`);
      await expect(page.getByText(programName, { exact: true }).first()).toBeVisible({
        timeout: 120_000,
      });
      await expect(ui.obsTreeAddObservationButton(page)).toBeVisible({ timeout: 60_000 });
    });
  } finally {
    await context.close();
  }
});
