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
import { loginAsGuest } from "./lib/auth.js";
import { INSECURE_TLS, TEMPO_ENABLED, TESTID, endpoints } from "./lib/config.js";
import {
  calculatedResultsScenario,
  createObservationScenario,
  createProgramScenario,
  editSubtitleScenario,
  readMixScenario,
  scenario,
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

export default function () {
  console.log(`regression run ${TESTID} against ${endpoints.odbGraphqlUrl}`);

  // Scenario 1: login is a token fetch at this layer.
  const session = scenario("login", () => loginAsGuest());
  if (!session) fail("guest login failed; the rest of the run would be meaningless");

  const programId = scenario("create-program", () =>
    createProgramScenario(session, { name: `odbattr ${TESTID}` }),
  );
  if (!programId) fail("could not create a program");

  const observation = scenario("create-observation", () =>
    createObservationScenario(session, programId, { subtitle: `odbattr ${TESTID}` }),
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
}
