import { type Page, expect, test } from "@playwright/test";
import {
  TEST_CALL,
  createCallForProposals,
  createObservation,
  createProgram,
  createProposal,
  createTarget,
  gmosNorthLongSlit,
  observationWorkflow,
  proposalDetails,
  setProgramDescription,
  setProgramUserPartner,
  setProposalStatus,
  updateTargetToTestTarget,
} from "../../lib/odb-operations.js";
import { GraphQLError, eventually } from "../support/odb.js";
import * as ui from "../support/selectors.js";
import { StandardSession, loadStandardUser } from "../support/standard-users.js";

/**
 * Proposals — the first area spec to need more than a guest (tests/COVERAGE.md).
 *
 * Its blocker was never the UI: a submittable proposal needs a **Call for Proposals**, and
 * `createCallForProposals` requires staff access. Guests cannot make one, so the whole area
 * waited on the fabricated standard users
 * (research/orcid-auth-testing-strategy.md tiers 2-3). Both roles appear here, which is also
 * what makes this the first test where the *distinction* between them matters:
 *
 *   staff  →  creates the call
 *   pi     →  owns the program, writes the proposal, submits it
 *
 * The split between API and UI follows the journey's (README, deviation 6): the fixture is
 * seeded through GraphQL; the behaviour under test is the proposal editor's validation in
 * Explore (scenario 3) and the ODB's own submission rule (scenario 4), each with a GraphQL
 * read-back. Since 2026-09-07 both layers refuse a proposal without its two attachments,
 * and the ephemeral stack has no object store to upload them to — so the submit/retract
 * lifecycle is not exercised here until wayfinder ticket 028 lands.
 */

const staff = loadStandardUser("TEST_STAFF");
const pi = loadStandardUser("TEST_PI");

test.describe.configure({ mode: "serial" });

test.skip(
  !staff || !pi,
  "no fabricated standard users — run stack/scripts/create-standard-users.sh",
);

/** Carried between the chained scenarios. */
const proposal: { callId?: string; programId?: string; programName?: string } = {};

let page: Page;
let piSession: StandardSession;
/** Kept for the error message if the observation never becomes defined. */
let lastWorkflow = "not read";

test.beforeAll(async ({ browser }) => {
  piSession = new StandardSession(pi!);
  const context = await browser.newContext();
  await piSession.inject(context);
  page = await context.newPage();
});

test.afterAll(async () => {
  await page?.context().close();
});

test("scenario 1: staff opens a call for proposals", async () => {
  const staffClient = new StandardSession(staff!).client();

  const data = await staffClient.run<{
    createCallForProposals: {
      callForProposals: { id: string; semester: string; existence: string };
    };
  }>(createCallForProposals());

  const call = data.createCallForProposals.callForProposals;
  expect(call.id).toMatch(/^c-/);
  expect(call.semester).toBe(TEST_CALL.semester);
  expect(call.existence).toBe("PRESENT");
  proposal.callId = call.id;

  // Worth stating plainly, because it is the reason this spec exists: the same mutation as a
  // guest or a PI is refused. Only staff can open a call.
  const piAttempt = await piSession
    .client()
    .run(createCallForProposals())
    .then(() => "allowed")
    .catch(() => "refused");
  expect(piAttempt, "createCallForProposals is staff-only").toBe("refused");
});

test("scenario 2: the PI's proposal is written against that call", async () => {
  expect(proposal.callId, "scenario 1 must have created a call").toBeTruthy();
  const odb = piSession.client();

  proposal.programName = `gpp-tests proposals ${Date.now()}`;
  const created = await odb.run<{
    createProgram: { program: { id: string } };
  }>(createProgram({ name: proposal.programName }));
  proposal.programId = created.createProgram.program.id;

  // Two preconditions that only a running stack reveals, both of them ODB rules rather than
  // UI quirks, and both discovered by watching Explore keep "Submit Proposal" disabled:
  //
  //   "Select PI's partner to show CfP deadline."  → no partner means no deadline, and an
  //                                                  absent deadline reads as one that passed
  //   "contains undefined observations"            → the ODB's own words, refusing the
  //                                                  submission through the API too
  //
  // The second is why this is not a one-line fixture: an *empty* observation is undefined, so
  // the proposal needs a real one — the journey's target and GMOS long-slit configuration,
  // which is the cheapest thing the ODB will call defined.
  await odb.run(setProgramUserPartner({ programId: proposal.programId }));
  await odb.run(
    setProgramDescription({
      programId: proposal.programId,
      description: "Submitted by the gpp-tests proposals spec.",
    }),
  );

  const target = await odb.run<{ createTarget: { target: { id: string } } }>(
    createTarget({ programId: proposal.programId, name: "gpp-tests proposal target" }),
  );
  await odb.run(updateTargetToTestTarget({ targetId: target.createTarget.target.id }));

  const observation = await odb.run<{
    createObservation: { observation: { id: string } };
  }>(
    createObservation({
      programId: proposal.programId,
      targetIds: [target.createTarget.target.id],
      observingMode: gmosNorthLongSlit(),
    }),
  );
  const observationId = observation.createObservation.observation.id;

  // Wait for the ODB to agree it is defined, rather than assuming. On timeout the workflow's
  // own validation messages are the error, so a fixture that stops satisfying the ODB says
  // why instead of failing later as a disabled button.
  await eventually(
    "the observation to leave UNDEFINED",
    async () => {
      const data = await odb.run<{
        observation: {
          workflow: {
            calculationState: string;
            value: { state: string; validationErrors: { messages: string[] }[] };
          };
        };
      }>(observationWorkflow({ observationId }));
      const workflow = data.observation.workflow.value;
      lastWorkflow = `${workflow.state}: ${workflow.validationErrors
        .flatMap((e) => e.messages)
        .join("; ")}`;
      return workflow.state !== "UNDEFINED" ? workflow.state : undefined;
    },
    { timeoutMs: 120_000, intervalMs: 3_000 },
  ).catch((error) => {
    throw new Error(`${error.message}\n  last workflow state — ${lastWorkflow}`);
  });

  const data = await odb.run<{
    createProposal: {
      proposal: {
        category: string;
        call: { id: string };
        gemini: {
          scienceSubtype: string;
          minPercentTime: number;
          considerForBand3: string;
          partnerSplits: { partner: string; percent: number }[];
        };
      };
    };
  }>(
    createProposal({
      programId: proposal.programId,
      callId: proposal.callId!,
    }),
  );

  const written = data.createProposal.proposal;
  expect(written.category).toBe(TEST_CALL.category);
  expect(written.call.id).toBe(proposal.callId);

  // The three things the ODB requires before it will accept a submission, asserted here so a
  // later failure to submit cannot be blamed on the fixture (schema: partner percents must
  // sum to 100, considerForBand3 must not be UNSET, and the call type must match the
  // proposal type — a queue proposal against a REGULAR_SEMESTER call).
  expect(written.gemini.scienceSubtype).toBe("QUEUE");
  expect(written.gemini.considerForBand3).not.toBe("UNSET");
  expect(written.gemini.partnerSplits).toEqual([
    { partner: TEST_CALL.partner, percent: 100 },
  ]);
});

test("scenario 3: Explore shows the proposal, and refuses to submit it incomplete", async () => {
  const programId = proposal.programId!;
  expect(programId, "scenario 2 must have created a program").toBeTruthy();

  await test.step("the proposal editor renders for this program", async () => {
    await page.goto(`/${programId}/proposal`);
    // Generous, like the journey's first navigation: a cold Explore boot behind the spinner,
    // which needs both websockets before anything renders.
    await expect(ui.submitProposalButton(page)).toBeVisible({ timeout: 120_000 });

    // Not just "a form appeared": both of these echo what scenario 2 wrote through the API,
    // so the editor is provably showing *this* proposal. The title is the program's own name,
    // and DO_NOT_CONSIDER renders as "No".
    await expect(ui.proposalTitleField(page)).toHaveValue(proposal.programName!);
    await expect(ui.proposalBand3Field(page)).toHaveValue(/no/i);
    await expect(ui.proposalPartnersLabel(page)).toBeVisible();
  });

  await test.step("submit stays disabled, and the errors say exactly why", async () => {
    // This is the behaviour under test, not a workaround for a blocked one. Explore validates
    // more than the ODB does (`explore/model/Proposal.scala`, `errors`): title, abstract,
    // category, every investigator's partner, the PI's email, splits summing to 100, defined
    // observations — and two uploaded attachments. The fixture satisfies all of it except the
    // attachments, so the only errors left name those, and Submit is correctly refused.
    //
    // They cannot be satisfied in the ephemeral stack: the ODB is configured with dummy
    // Cloudcube credentials (`stack/docker-compose.yml`), so there is no object store to
    // upload to. That is the "Attachments" row of tests/COVERAGE.md. Since 2026-09-07 the
    // ODB enforces the same two attachments itself — scenario 4 asserts that refusal.
    await expect(ui.submitProposalButton(page)).toBeDisabled();
    await expect(page.getByText(/science attachment is required/i)).toBeVisible();
    await expect(page.getByText(/team attachment is required/i)).toBeVisible();
    await expect(page.getByText(/abstract is required/i)).toBeHidden();
    await expect(page.getByText(/category is required/i)).toBeHidden();
  });
});

test("scenario 4: the ODB refuses to submit the proposal without its attachments", async () => {
  const programId = proposal.programId!;
  const odb = piSession.client();

  // Until 2026-09-06 the ODB's rules were a subset of Explore's: it did not require
  // attachments, it accepted this proposal, and this scenario submitted and retracted it
  // (SUBMITTED, a minted reference, NOT_SUBMITTED). The nightly of 2026-09-07 went red when
  // the `-dev` ODB adopted Explore's rule, refusing with the wording asserted below. The
  // fixture is complete in every other respect — scenarios 2 and 3 prove it — so the only
  // thing the ODB may name is the two attachments, and it must name both.
  //
  // The lifecycle returns once the stack has an object store to upload into (wayfinder
  // ticket 028). Until then submission cannot be exercised anywhere in this stack, and the
  // refusal is the ODB-level contract under test.
  await test.step("submit is refused, naming exactly the two attachments", async () => {
    let error: unknown;
    try {
      await odb.run(setProposalStatus({ programId, status: "SUBMITTED" }));
    } catch (e) {
      error = e;
    }
    expect(error, "the ODB accepted a proposal with no attachments").toBeInstanceOf(
      GraphQLError,
    );
    const details = (error as GraphQLError).errors.map((e) => JSON.stringify(e)).join("\n");
    expect(details).toMatch(/science attachment is required/i);
    expect(details).toMatch(/team attachment is required/i);
    // Two errors, no more: any third one would mean the fixture stopped satisfying a rule.
    expect((error as GraphQLError).errors).toHaveLength(2);
  });

  await test.step("read back: still not submitted, no reference minted", async () => {
    const data = await odb.run<{
      program: {
        proposalStatus: string;
        proposal: { reference: { label: string } | null } | null;
      };
    }>(proposalDetails({ programId }));
    expect(data.program.proposalStatus).toBe("NOT_SUBMITTED");
    expect(data.program.proposal?.reference ?? null).toBeNull();
  });
});
