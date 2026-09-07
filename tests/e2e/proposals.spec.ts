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
import { eventually } from "../support/odb.js";
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
 * seeded through GraphQL, and the behaviour under test — submit, then retract — goes through
 * Explore's own buttons with a GraphQL read-back after each.
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
    // upload to. That is the "Attachments" row of tests/COVERAGE.md, and it gates the UI
    // submit leg rather than proposals as a whole — scenario 4 covers the lifecycle instead.
    await expect(ui.submitProposalButton(page)).toBeDisabled();
    await expect(page.getByText(/science attachment is required/i)).toBeVisible();
    await expect(page.getByText(/team attachment is required/i)).toBeVisible();
    await expect(page.getByText(/abstract is required/i)).toBeHidden();
    await expect(page.getByText(/category is required/i)).toBeHidden();
  });
});

test("scenario 4: the proposal submits and retracts through the ODB", async () => {
  const programId = proposal.programId!;
  const odb = piSession.client();

  // The ODB's own rules are a subset of Explore's: it does not require attachments, and it
  // accepts this proposal. So the lifecycle is asserted here at the API level (tier 2 of
  // research/orcid-auth-testing-strategy.md), which is what the coverage map asks proposals
  // for; the browser leg above stops where the stack's object store does.
  await test.step("submit", async () => {
    const data = await odb.run<{
      setProposalStatus: { program: { proposalStatus: string } };
    }>(setProposalStatus({ programId, status: "SUBMITTED" }));
    expect(data.setProposalStatus.program.proposalStatus).toBe("SUBMITTED");
  });

  await test.step("read back: submitted, and a reference was assigned", async () => {
    const program = await eventually(
      "the submitted proposal to carry a reference",
      async () => {
        const data = await odb.run<{
          program: {
            proposalStatus: string;
            proposal: { reference: { label: string } | null };
          };
        }>(proposalDetails({ programId }));
        return data.program.proposal?.reference?.label ? data.program : undefined;
      },
      { timeoutMs: 60_000, intervalMs: 2_000 },
    );

    expect(program.proposalStatus).toBe("SUBMITTED");
    // A reference is only minted on submission, once the call has a semester — the strongest
    // evidence available that this was a real submission and not just a status flag.
    expect(program.proposal!.reference!.label).toContain(TEST_CALL.semester);
  });

  await test.step("retract, and read back", async () => {
    await odb.run(setProposalStatus({ programId, status: "NOT_SUBMITTED" }));
    const data = await odb.run<{ program: { proposalStatus: string } }>(
      proposalDetails({ programId }),
    );
    expect(data.program.proposalStatus).toBe("NOT_SUBMITTED");
  });
});
