#!/usr/bin/env node
/**
 * Refuse a k6 target that is not a load-test host (the traffic-plane rail, `lib/load-target.js`).
 *
 *   node tools/check-load-target.js
 *
 * Reads the same environment the suites do, so it validates exactly what k6 would resolve.
 * Exits 0 with the approved hosts on stderr, 1 with the offending endpoints named.
 *
 * `k6/lib/config.js` performs the same check at init, which is the rail that cannot be
 * bypassed. This exists so `performance.yml` can fail *before* it resets a database, deploys
 * images and scales dynos up: the nightly run would otherwise do all of that and only then
 * discover, twenty minutes later, that it had been aimed at the wrong host.
 */
import { stackEndpoints } from "../lib/endpoints.js";
import { assertTargets } from "../lib/load-target.js";

const endpoints = stackEndpoints(process.env);

try {
  const hosts = assertTargets(endpoints, process.env);
  console.error(`load target verified: ${hosts.join(", ")}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
