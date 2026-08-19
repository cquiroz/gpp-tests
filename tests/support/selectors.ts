import type { Locator, Page } from "@playwright/test";

/**
 * Every Explore selector the journey uses, in one file.
 *
 * v1 uses role and text selectors because Explore (Scala.js + PrimeReact) sets almost no
 * stable ids today; spec §10 asks lucuma-apps for `data-testid` on exactly these elements,
 * and this file is where the migration happens when they land. Labels below were read from
 * lucuma-apps `main` (see research/v1-scenario-graphql-ui-map.md §3) — when a run goes red
 * on a selector rather than on an assertion, this is the file to look at first.
 */

/** Login dialog: "Login with ORCID" | "Continue as Guest" (allowGuest = true). */
export const guestLoginButton = (page: Page): Locator =>
  page.getByRole("button", { name: /continue as guest/i });

/**
 * Proof that the logged-in shell rendered. Both websockets (ODB and prefs) must have
 * connected before Explore renders anything past the spinner, so the obs tree's "Obs"
 * button appearing is also proof the prefs service is reachable.
 */
export const obsTreeAddObservationButton = (page: Page): Locator =>
  page.getByRole("button", { name: /^obs$/i });

/** Side-bar menu that holds "Manage Programs". */
export const mainMenuButton = (page: Page): Locator =>
  page.getByRole("button", { name: /menu/i }).first();

export const managePrograms = (page: Page): Locator =>
  page.getByText(/manage programs/i).first();

/** The "Proposals & Programs" dialog. */
export const programsDialog = (page: Page): Locator =>
  page.getByRole("dialog").filter({ hasText: /proposals\s*&\s*programs/i });

/**
 * Footer button of that dialog. Labelled "Proposal", but it calls `createProgram` with
 * SET = null and attaches no proposal (research §1).
 */
export const createProgramButton = (page: Page): Locator =>
  programsDialog(page).getByRole("button", { name: /^proposal$/i });

/** Split button in the target tile; its menu holds the manual-coordinates action. */
export const addTargetButton = (page: Page): Locator =>
  page.getByRole("button", { name: /add target/i }).first();

/** No catalog lookups in v1 — this action creates a target with default coordinates. */
export const emptySiderealTargetItem = (page: Page): Locator =>
  page.getByText(/empty sidereal target/i).first();

/** Inline editable label on the observation card in the obs tree (ObsBadge). */
export const obsBadgeSubtitle = (page: Page, subtitle: string): Locator =>
  page.getByText(subtitle, { exact: false });
