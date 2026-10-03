// The GraphQL-level regression suite (spec §5): one guest, each v1 scenario once, run
// straight after the Playwright journey against the same ephemeral stack.
//
//   SUITE=regression k6 run --summary-export out/k6-summary.json k6/regression.js
//
// Every scenario must pass — `checks: rate==1.0` turns any failed check into a red run — and
// each contributes a pass/fail plus duration series so the regression suite has a
// pass-rate-over-time history in Grafana too (spec §7).
import { fail } from "k6";
import tempo from "./vendor/http-instrumentation-tempo.js";
import { loginAsGuest, loginAsStandardUser } from "./lib/auth.js";
import { INSECURE_TLS, TEMPO_ENABLED, TESTID, endpoints } from "./lib/config.js";
import { ObserveInstance, seedExecutableObservations, serviceSession } from "./lib/execution.js";
import { observeBrowserFixture, observeBrowserSession } from "./lib/subscribers.js";
import {
  calculatedResultsScenario,
  createObservationScenario,
  createProgramScenario,
  editSubtitleScenario,
  observingModesScenario,
  readMixScenario,
  scenario,
  scenarioAsync,
} from "./lib/scenarios.js";

if (TEMPO_ENABLED) {
  // Injects a W3C traceparent into every request, so the ODB's own OpenTelemetry
  // instrumentation records these calls as findable traces (spec §7).
  tempo.instrumentHTTP({ propagator: "w3c" });
}

export const options = {
  vus: 1,
  iterations: 1,
  insecureSkipTLSVerify: INSECURE_TLS,
  thresholds: {
    // Any failed scenario check fails the run; no latency thresholds here, the regression
    // suite is about breakage, not speed.
    checks: ["rate==1.0"],
    odb_graphql_errors: ["count==0"],
  },
};

export default async function () {
  console.log(`regression run ${TESTID} against ${endpoints.odbGraphqlUrl}`);

  // Scenario 1: login is a token fetch at this layer.
  const session = scenario("login", () => loginAsGuest());
  if (!session) fail("guest login failed; the rest of the run would be meaningless");

  const programId = scenario("create-program", () =>
    createProgramScenario(session, { name: `gpp-tests ${TESTID}` }),
  );
  if (!programId) fail("could not create a program");

  const observation = scenario("create-observation", () =>
    createObservationScenario(session, programId, { subtitle: `gpp-tests ${TESTID}` }),
  );
  if (!observation) fail("could not create an observation with a target and mode");

  scenario("edit-observation", () =>
    editSubtitleScenario(session, observation.observationId),
  );

  scenario("read-mix", () =>
    readMixScenario(session, {
      programId,
      observationId: observation.observationId,
    }),
  );

  // Answerability only: the values are computed asynchronously, and the Playwright journey
  // is what waits for them to become READY.
  scenario("calculated-results", () =>
    calculatedResultsScenario(session, observation.observationId),
  );

  // An observation in every observing mode, as a regular PI (ticket 030). A missing PI is a
  // red run, not a skip: CI always fabricates one, and locally the fix is one script.
  const pi = loginAsStandardUser("TEST_PI");
  if (!pi) {
    fail(
      "TEST_PI_REFRESH_TOKEN is not set: run stack/scripts/create-standard-users.sh and " +
        "source the file it writes",
    );
  }
  const piProgramId = createProgramScenario(pi, { name: `gpp-tests modes ${TESTID}` });
  scenario("observing-modes", () =>
    Boolean(piProgramId) && observingModesScenario(pi, piProgramId),
  );

  // One executed step, Observe's way, as the service identity (ticket 021): keeps the
  // execution mutations and the execution-config read understood by the -dev odb, the way
  // the scenarios above keep Explore's documents. Compressed cadence; the stall budget is the
  // surge run's business, not this one's.
  const service = serviceSession();
  const executable = seedExecutableObservations(service, {
    site: "GN",
    count: 1,
    label: `gpp-tests execution ${TESTID}`,
  });
  const observe = new ObserveInstance(service, {
    site: "GN",
    observationIds: executable,
    cadence: { min: 2, max: 3 },
  });
  await scenarioAsync("execution", async () => (await observe.step()) === "ok");
  observe.close();

  // One Observe-browser websocket session as the fabricated staff user (ticket 022): the
  // graphql-transport-ws handshake, three subscriptions, and two measured round trips from
  // an HTTP edit to the event on this socket. Short on purpose; the population is k6/subscribers.js.
  await scenarioAsync("observe-browser", () =>
    observeBrowserSession(observeBrowserFixture(), { holdMs: 20000, cadenceMs: 4000 }),
  );
}
