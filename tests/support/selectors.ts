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

/**
 * The signed-in identity shown in the toolbar — "Guest User" for guests, the ORCID
 * given/family name for standard users (fabricated ones included).
 */
export const toolbarUserLabel = (page: Page, name: RegExp): Locator =>
  page.getByRole("toolbar").getByText(name);

/**
 * The toolbar menu holding "Manage Programs".
 *
 * It is an icon button with no accessible name — no text, no title, no aria-label — so it can
 * only be addressed positionally: the last button in the toolbar, after "Getting Started" and
 * the "Guest User" label. Verified against the running app. This is the single most brittle
 * selector in the journey and the clearest case for the `data-testid` ask in spec §10.
 */
export const mainMenuButton = (page: Page): Locator =>
  page.getByRole("toolbar").getByRole("button").last();

/** Opened by {@link mainMenuButton}; siblings are About Explore, Recent Progs, Login, Logout. */
export const managePrograms = (page: Page): Locator =>
  page.getByRole("menuitem", { name: /manage programs/i });

/** The "Proposals & Programs" dialog — that string is its accessible name. */
export const programsDialog = (page: Page): Locator =>
  page.getByRole("dialog", { name: /proposals\s*&\s*programs/i });

/**
 * Footer button of that dialog. Labelled "Proposal", but it calls `createProgram` with
 * SET = null and attaches no proposal (research §1).
 */
export const createProgramButton = (page: Page): Locator =>
  programsDialog(page).getByRole("button", { name: /^proposal$/i });

/**
 * The dialog row for one program, matched on its id cell — so the assertion is "this exact
 * program is listed", not "some row appeared".
 */
export const programRow = (page: Page, programId: string): Locator =>
  programsDialog(page)
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: programId, exact: true }) });

/**
 * Opens a program and closes the dialog. Creating a program leaves the dialog up — and its
 * modal mask swallows every click behind it — so the journey must come through here before it
 * can touch the observation tree. The current program's own Select is disabled.
 */
export const selectProgramButton = (page: Page, programId: string): Locator =>
  programRow(page, programId).getByRole("button", { name: /^select$/i });

/**
 * Opens the "Add Target" dialog from the target tile. The label is "Add a target" — note the
 * article; `/add target/i` matches nothing.
 */
export const addTargetButton = (page: Page): Locator =>
  page.getByRole("button", { name: /add a target/i }).first();

/**
 * Inside that dialog, alongside a Simbad-backed "Name" search box and "Target of
 * Opportunity". This is the no-catalog path v1 requires: it creates a target immediately with
 * placeholder coordinates, which the journey then overwrites with the fixture (spec §5).
 */
export const emptySiderealTargetItem = (page: Page): Locator =>
  page.getByRole("button", { name: /empty sidereal target/i });

/**
 * The subtitle text on the observation card in the obs tree (ObsBadge).
 *
 * Display only — clicking it does nothing, because the badge as a whole is a navigation link.
 * Editing goes through {@link obsBadgeSubtitleEdit}.
 */
export const obsBadgeSubtitle = (page: Page): Locator =>
  page.locator(".obs-badge-subtitle");

/** Shown in place of the subtitle when an observation has none yet; opens the same editor. */
export const obsBadgeAddDescription = (page: Page): Locator =>
  page.getByRole("button", { name: /add description/i });

/**
 * The pencil button beside an existing subtitle — the only way to reopen the editor. It has
 * no accessible name (icon only) and sits next to a delete button whose class differs by one
 * word, so the class is the handle.
 */
export const obsBadgeSubtitleEdit = (page: Page): Locator =>
  page.locator("button.obs-badge-subtitle-edit");

/**
 * The input the ObsBadge swaps in once its label is clicked.
 *
 * Addressed by class because that is the only stable handle: the element has no accessible
 * name and React gives it a generated id (`_r_9_`). Picking it by role would mean
 * `getByRole("textbox").first()`, and the observation page carries twenty-odd textboxes —
 * constraints, wavelengths, signal-to-noise — so "first" is whichever happens to render
 * earliest. The class comes from Explore's own stylesheet and is as good as a testid until
 * the real ones land (spec §10).
 */
export const obsBadgeSubtitleInput = (page: Page): Locator =>
  page.locator("input.obs-badge-subtitle-input");
