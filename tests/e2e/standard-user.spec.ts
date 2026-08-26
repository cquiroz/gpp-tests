import { expect, test } from "@playwright/test";
import { programs as programsQuery } from "../../lib/odb-operations.js";
import * as ui from "../support/selectors.js";
import { StandardSession, loadStandardUser } from "../support/standard-users.js";

/**
 * Smoke test for tier 3 of research/orcid-auth-testing-strategy.md: a standard (non-guest)
 * user fabricated by stack/scripts/create-standard-users.sh can drive Explore in a browser
 * by cookie injection alone — no ORCID, no login dialog.
 *
 * This is the enabling check for every role-diverse area spec (proposals, program sharing):
 * if it passes, those specs can assume `loadStandardUser(...)` + `inject(...)` gives them a
 * signed-in standard user. Skips, with the fix named, when the fabrication script has not
 * been run against this stack.
 */

const pi = loadStandardUser("TEST_PI");

test("a fabricated standard PI drives Explore via cookie injection", async ({
  browser,
}) => {
  test.skip(
    !pi,
    "no fabricated standard users — run stack/scripts/create-standard-users.sh",
  );

  const session = new StandardSession(pi!);
  const context = await browser.newContext();
  await session.inject(context);
  const page = await context.newPage();

  await test.step("the injected cookie is a login: no dialog, shell renders", async () => {
    await page.goto("/");
    // The toolbar identity label, rather than either landing, is the "logged-in shell
    // rendered" proof here: which landing a standard user gets is a property of what the ODB
    // holds and not of the kind of user (see ui.loggedInLanding) — this PI is routed to a
    // program Explore auto-creates for them, while a staff user, who can see every program,
    // gets the Proposals & Programs picker. The label still requires both websockets:
    // Explore renders nothing past the spinner without them.
    await expect(ui.toolbarUserLabel(page, /test\s+pi/i)).toBeVisible({
      timeout: 120_000,
    });
    await expect(ui.guestLoginButton(page)).toBeHidden();
  });

  await test.step("the identity is the fabricated user, role honored", async () => {
    const user = (await session.claims())["lucuma-user"];
    expect(user.id).toBe(pi!.userId);
    expect(user.type).toBe("standard");
    expect(user.role.type).toBe("pi");
  });

  await test.step("read back: the ODB serves the same identity", async () => {
    const data = await session
      .client()
      .run<{ programs: { matches: unknown[] } }>(programsQuery({}));
    expect(Array.isArray(data.programs.matches)).toBe(true);
  });

  await context.close();
});
