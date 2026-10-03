// Custom metrics, and the only labels they are allowed to carry.
//
// Reads and writes are tracked separately because the spec's thresholds are separate
// (p95 read < 2 s, p95 mutation < 5 s) and because a write regression and a read regression
// mean different things. Label keys are enforced by lib/tags.js — the free Grafana Cloud
// tier's 10k series budget is shared with production metrics (spec §7).
import { Counter, Rate, Trend } from "k6/metrics";
import { metricTags } from "../../lib/tags.js";
import { SUITE, TAG_TESTID, TESTID } from "./config.js";

export const readDuration = new Trend("odb_read_duration", true);
export const writeDuration = new Trend("odb_write_duration", true);
export const graphqlErrors = new Counter("odb_graphql_errors");

// The regression suite's contribution to Grafana: per-scenario pass/fail and duration, a
// dozen series, so pass-rate-over-time exists for both suites (spec §7).
export const scenarioPass = new Rate("gpp_scenario_pass");
export const scenarioDuration = new Trend("gpp_scenario_duration", true);

// The execution VU's stall metrics (ticket 021, CONTEXT.md "Step ODB overhead"). Per-mutation
// latency lives in the read/write trends above, tagged by operation; these capture what the
// telescope actually feels: the time one step spent unable to proceed until the ODB answered.
//
//   odb_step_overhead  — per step, the sum of its blocking points (the surge SLO's subject).
//   odb_step_wait      — one sample per blocking point, tagged `operation` with the point's
//                        name (RecordVisit, StepRecorded, RecordDataset, Flush,
//                        ExecutionConfig), so a breach can be attributed. Five values.
//   gpp_execution_steps — steps completed, the execution VU's throughput.
export const stepOverhead = new Trend("odb_step_overhead", true);
export const stepWait = new Trend("odb_step_wait", true);
export const stepsExecuted = new Counter("gpp_execution_steps");

// The websocket side (ticket 022): what a held graphql-transport-ws socket experiences.
//
//   odb_ws_round_trip        — from a mutation's HTTP acknowledgement to the matching event
//                              on the same VU's subscription; `operation` = the subscription.
//                              Zero when the event beats the acknowledgement.
//   odb_ws_event_latency     — the same event measured from the mutation's send instead, the
//                              fan-out latency a user perceives.
//   odb_ws_ping              — our ping to the server's pong, the socket's responsiveness.
//   odb_ws_connections       — sockets opened; odb_ws_reconnects — of those, reconnections
//                              after a drop (so steady = connections − reconnects).
//   odb_ws_unanswered_pings  — pings with no pong inside the timeout.
//   odb_ws_lost_events       — round trips whose event never arrived.
//   odb_ws_messages          — frames received, `operation` = the protocol message type.
export const wsRoundTrip = new Trend("odb_ws_round_trip", true);
export const wsEventLatency = new Trend("odb_ws_event_latency", true);
export const wsPing = new Trend("odb_ws_ping", true);
export const wsConnections = new Counter("odb_ws_connections");
export const wsReconnects = new Counter("odb_ws_reconnects");
export const wsUnansweredPings = new Counter("odb_ws_unanswered_pings");
export const wsLostEvents = new Counter("odb_ws_lost_events");
export const wsMessages = new Counter("odb_ws_messages");

/**
 * Build the label set for a sample. Always includes the suite; `testid` only when the
 * escape hatch is open.
 *
 * @param {{scenario?: string, operation?: string, status?: string}} extra
 */
export function tags(extra) {
  const candidate = { suite: SUITE, ...extra };
  if (TAG_TESTID) candidate.testid = TESTID;
  return metricTags(candidate, { allowTestid: TAG_TESTID });
}
