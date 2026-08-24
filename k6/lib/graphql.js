// One place where a k6 VU issues an ODB GraphQL operation.
//
// Operations themselves come from lib/odb-operations.js — the same documents the Playwright
// journey asserts against, so the load suite cannot drift from the browser suite.
import http from "k6/http";
import { check } from "k6";
import { OPERATION_KIND } from "../../lib/odb-operations.js";
import { endpoints } from "./config.js";
import { graphqlErrors, readDuration, tags, writeDuration } from "./metrics.js";

/**
 * @param {{token: string}} session
 * @param {import('../../lib/odb-operations.js').Operation} operation
 * @param {{scenario: string, measure?: boolean, tolerate?: string[]}} opts
 *   `measure: false` keeps a sample out of the read/write trends — used for the per-VU
 *   seeding phase, which happens during the ramp and is not part of the measured mix.
 *   `tolerate` lists `odb_error` tags that are a normal state rather than a failure; the
 *   request is still timed, but it does not count as an error.
 * @returns {any | undefined} the `data` payload, or undefined if the call failed
 */
export function gql(session, operation, { scenario, measure = true, tolerate }) {
  const kind = OPERATION_KIND[operation.operationName] || "read";
  const requestTags = tags({ scenario, operation: operation.operationName });

  const response = http.post(
    endpoints.odbGraphqlUrl,
    JSON.stringify({
      operationName: operation.operationName,
      query: operation.query,
      variables: operation.variables,
    }),
    {
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.token}`,
      },
      tags: requestTags,
    },
  );

  // A GraphQL server answers 200 with an `errors` array, so HTTP status alone is not enough.
  let data;
  let errors;
  if (response.status === 200) {
    try {
      const payload = response.json();
      data = payload && payload.data;
      errors = payload && payload.errors;
    } catch (_error) {
      errors = [{ message: "response was not JSON" }];
    }
  }

  // An error every one of whose entries is an expected transient state is not a failure.
  // Every entry must match: a real problem (an itc_error, say) arriving alongside a tolerated
  // one must still fail.
  const tolerated =
    !!errors &&
    errors.length > 0 &&
    !!tolerate &&
    errors.every((e) => tolerate.some((tag) => JSON.stringify(e).includes(tag)));

  // A tolerated response carries an `errors` array and usually no `data` at all, so the
  // data check only applies to genuine successes.
  const ok =
    response.status === 200 && (tolerated || (!errors && data !== undefined));
  check(response, {
    [`${operation.operationName} succeeded`]: () => ok,
  });

  if (!ok) {
    graphqlErrors.add(1, tags({ scenario, operation: operation.operationName }));
    if (errors) {
      console.warn(
        `${operation.operationName}: ${JSON.stringify(errors).slice(0, 300)}`,
      );
    }
  }

  if (measure) {
    const sampleTags = tags({
      scenario,
      operation: operation.operationName,
      status: ok ? "ok" : "error",
    });
    const trend = kind === "write" ? writeDuration : readDuration;
    trend.add(response.timings.duration, sampleTags);
  }

  if (!ok) return undefined;
  // Callers treat the return value as both the payload and a success flag, so a tolerated
  // response — valid query, value not computed yet — needs a truthy marker rather than the
  // `data` it does not have.
  return tolerated ? PENDING : data;
}

/** Returned by {@link gql} when the query succeeded but the value is still being calculated. */
export const PENDING = { pending: true };
