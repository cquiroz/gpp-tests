import type { Locator, Page } from "@playwright/test";

/**
 * Every Explore selector the journey uses, in one file.
 *
 * Explore ships `data-testid` attributes as of lucuma-apps `data-testid-contract`
 * (wayfinder ticket 029): 18 of the 23 ids the ask asked for, written as literals at each
 * element. There is no manifest, no `/testids.json` and no check in lucuma-apps CI — those
 * were declined — so nothing upstream fails when an id is removed; a red run here on a
 * `getByTestId` is the signal.
 *
 * The obs-badge subtitle ids (items 2–6) were not shipped, so those four locators below
 * still read CSS classes; they are used only by the parked scenario 4 of the journey.
 */

/** Login dialog: "Login with ORCID" | "Continue as Guest" (allowGuest = true). */
export const guestLoginButton = (page: Page): Locator =>
  page.getByTestId("ui-login-guest");

/**
 * Proof that the logged-in shell rendered. Both websockets (ODB and prefs) must have
 * connected before Explore renders anything past the spinner, so the obs tree's "Obs"
 * button appearing is also proof the prefs service is reachable.
 */
export const obsTreeAddObservationButton = (page: Page): Locator =>
  page.getByTestId("explore-obs-tree-add-obs");

/**
 * The signed-in identity shown in the toolbar — "Guest User" for guests, the ORCID
 * given/family name for standard users (fabricated ones included). The id locates the
 * element; `name` is still matched, so the assertion remains "this identity is shown",
 * not merely "some name is shown".
 */
export const toolbarUserLabel = (page: Page, name: RegExp): Locator =>
  page.getByTestId("explore-topbar-user").filter({ hasText: name });

/**
 * The toolbar menu holding "Manage Programs". An icon button with no accessible name,
 * addressed positionally until the ids landed; this was the ask's worst case.
 */
export const mainMenuButton = (page: Page): Locator =>
  page.getByTestId("explore-topbar-menu");

/**
 * Opened by {@link mainMenuButton}; siblings are About Explore, Recent Progs, Login, Logout.
 *
 * The one id not read through `getByTestId`: PrimeReact's menu model carries no `data-*`,
 * so lucuma-react added a plain `id` that renders as the `<li id>` (`TopBar.scala`).
 */
export const managePrograms = (page: Page): Locator =>
  page.locator("#explore-menu-manage-programs");

/** The "Proposals & Programs" dialog. */
export const programsDialog = (page: Page): Locator =>
  page.getByTestId("explore-programs-dialog");

/**
 * Either shell Explore can land on after login, as one locator.
 *
 * With no program id in the URL, Explore branches on what the user can see (lucuma-apps
 * `explore/app/.../ExploreLayout.scala`, the `optProgramId.fold` case): a user who can see
 * *no* programs gets one auto-created and is routed to it — the obs tree — while a user who
 * can see some gets the Proposals & Programs popup. Which branch an identity takes is a
 * property of the ODB's contents, not of the kind of user, so any wait for "the shell is
 * up" has to accept both. Both are past the spinner, and Explore renders nothing past it
 * until the ODB *and* prefs websockets connect, so either branch proves the whole stack.
 *
 * The `.first()` disambiguates the union — strict mode fails an `.or()` that resolves to
 * both — rather than picking an element by position.
 */
export const loggedInLanding = (page: Page): Locator =>
  programsDialog(page).or(obsTreeAddObservationButton(page)).first();

/**
 * Footer button of that dialog. Labelled "Proposal", but it calls `createProgram` with
 * SET = null and attaches no proposal (research §1).
 */
export const createProgramButton = (page: Page): Locator =>
  page.getByTestId("explore-programs-create");

/**
 * The dialog row for one program, matched on the entity id the row carries — so the
 * assertion is "this exact program is listed", not "some row appeared". The testid is
 * static and `data-program-id` holds the id, which is how the ask asked for repeated
 * elements so the id list could stay a closed set rather than a pattern.
 */
export const programRow = (page: Page, programId: string): Locator =>
  page
    .getByTestId("explore-programs-row")
    .and(page.locator(`[data-program-id="${programId}"]`));

/**
 * Opens a program and closes the dialog. Creating a program leaves the dialog up — and its
 * modal mask swallows every click behind it — so the journey must come through here before it
 * can touch the observation tree. The current program's own Select is disabled.
 */
export const selectProgramButton = (page: Page, programId: string): Locator =>
  programRow(page, programId).getByTestId("explore-programs-select");

/**
 * Opens the "Add Target" dialog from the target tile.
 *
 * The id is on the `<div>` wrapping the split button, because PrimeReact puts unknown props
 * on the wrapper rather than the button inside it — so the click needs the inner `<button>`.
 * Note `TargetTable.scala` only renders this branch when the target list is *empty*; a
 * scenario adding a second target will need an id Explore does not ship yet (ticket 029).
 */
export const addTargetButton = (page: Page): Locator =>
  page.getByTestId("explore-target-add").locator("button").first();

/**
 * Inside that dialog, alongside a Simbad-backed "Name" search box and "Target of
 * Opportunity". This is the no-catalog path v1 requires: it creates a target immediately with
 * placeholder coordinates, which the journey then overwrites with the fixture (spec §5).
 */
export const emptySiderealTargetItem = (page: Page): Locator =>
  page.getByTestId("explore-target-add-empty-sidereal");

/* ── Proposals (tests/COVERAGE.md "Proposals") ──────────────────────────────────────── */

/**
 * Submit and retract, from `ProposalSubmissionBar.scala`. Each is rendered only in the state
 * where it applies — Submit while NOT_SUBMITTED, Retract while SUBMITTED — so asserting that
 * one has replaced the other is a cleaner check of the transition than reading a status label.
 *
 * Submit carries `disabled = … || hasProposalErrors || isDueDeadline || !canSubmit`: a
 * disabled button means the ODB has rejected something about the proposal, not that the click
 * failed. {@link proposalErrors} is where that shows up.
 */
export const submitProposalButton = (page: Page): Locator =>
  page.getByTestId("explore-proposal-submit");

export const retractProposalButton = (page: Page): Locator =>
  page.getByTestId("explore-proposal-retract");

/**
 * Two fields of the proposal editor that *echo what the fixture set through the API* — so
 * asserting them proves the editor rendered and that it is showing this proposal, not merely
 * that some form appeared.
 *
 * Band 3 is a dropdown and its id sits on the PrimeReact wrapper (`modifiers = …`), so the
 * value assertion has to reach the input inside it. Title takes a trailing `TagMod`, which
 * lands on the `<input>` itself, so its id is directly the field.
 */
export const proposalBand3Field = (page: Page): Locator =>
  page.getByTestId("explore-proposal-band3").locator("input");

export const proposalTitleField = (page: Page): Locator =>
  page.getByTestId("explore-proposal-title");

/** The partner-splits editor's heading (`ProposalDetailsTile.scala`, a `<label>`). */
export const proposalPartnersLabel = (page: Page): Locator =>
  page.getByTestId("explore-proposal-partners");

/**
 * The tile listing why a proposal cannot be submitted.
 *
 * The ODB's messages stay matched as text, because the text *is* what the scenario checks;
 * the id only scopes the check to this tile, so the same words elsewhere on the page cannot
 * satisfy it.
 */
export const proposalErrors = (page: Page): Locator =>
  page.getByTestId("explore-proposal-errors");

/* ── Observation badge: still on CSS classes ───────────────────────────────────────────
 *
 * Items 2–6 of the ask were not shipped, so these four keep the stylesheet handles they
 * always had. They are used only by the journey's scenario 4, which is skipped for that
 * reason (ticket 029); `obsBadgeAddDescription` is used by nothing at all.
 */

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
 * name and React gives it a generated id (`_r_9_`).
 */
export const obsBadgeSubtitleInput = (page: Page): Locator =>
  page.locator("input.obs-badge-subtitle-input");
