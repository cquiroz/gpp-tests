/**
 * Which hosts the k6 suites are allowed to send traffic at.
 *
 * `loadtest/guard.sh` protects the apps this tooling *manages* — nothing there protects the
 * app it *hammers*. The k6 target comes from `ODB_GRAPHQL_URL` / `SSO_URL` (repository
 * variables on the nightly run), and until this module existed nothing validated them: a
 * wrong string would have pointed the load profile — 200 VUs, a 20-minute hold, 40% writes —
 * at whatever host it named, creating programs, observations and targets there as guest
 * users. Production GPP is on the public internet at a real hostname, so that was the one
 * path from this repository to production that no rail covered.
 *
 * The policy: a suite may target a dedicated load-test host, or the local ephemeral stack,
 * and nothing else. Both halves fail closed — an unparseable URL, a missing host or a
 * protected substring all mean "refuse".
 *
 * Pure and dependency-free, like `lib/endpoints.js`: k6 imports it directly, so there is no
 * `URL`, no `node:` import and one implementation for CI, k6 and the unit tests.
 */

/**
 * Substrings that disqualify a host outright, whatever the allow rules say. Mirrors
 * `PROTECTED_PATTERNS` in `loadtest/guard.sh`; as there, this list is not overridable.
 *
 * Note which check is load-bearing here: production GPP hostnames need not contain any of
 * these words, so it is rule 1 below — the host must positively identify itself as a
 * load-test host — that actually keeps traffic off production. This list is the second line.
 */
export const PROTECTED_HOST_PATTERNS = [
  "production",
  "prod",
  "staging",
  "stage",
  "-dev",
  "master",
];

/**
 * A dedicated load-test host: `loadtest` as a whole label or a `-`-delimited word, so
 * `lucuma-postgres-odb-loadtest.herokuapp.com`, `odb.loadtest.example.edu` and
 * `odb.aws-loadtest.internal` all qualify while `odb.example.edu` does not.
 */
export const DEFAULT_HOST_PATTERN = "(^|[.-])loadtest([.-]|$)";

/**
 * The ephemeral stack and a developer's own machine. `.internal` is reserved for private use
 * and is where `stack/docker-compose.yml` lives (`*.gpp-test.internal`), so a local load run
 * — the documented way to smoke-test the profile — keeps working without an override.
 */
const LOCAL_HOST_PATTERN = /(^|\.)internal$|^localhost$|^127\.0\.0\.1$|^::1$/;

/** Endpoints k6 sends test traffic to. `otelEndpoint` is deliberately absent: it is a
 * telemetry sink, not a target, and Grafana Cloud's own hostnames contain "prod". */
const TRAFFIC_ENDPOINTS = [
  "exploreUrl",
  "ssoUrl",
  "odbRestUrl",
  "odbGraphqlUrl",
  "odbWsUrl",
  "itcUrl",
  "prefsWsUrl",
];

/**
 * The host of a URL, lowercased, or undefined when it cannot be determined — which callers
 * must treat as a refusal rather than as "no host to check".
 *
 * @param {unknown} url
 * @returns {string|undefined}
 */
export function hostOf(url) {
  const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^/:?#]+)/i.exec(
    String(url ?? "").trim(),
  );
  const authority = match ? match[1] : undefined;
  if (!authority) return undefined;
  const host = authority.toLowerCase();
  // Unwrap an IPv6 literal so `::1` is comparable, and reject an empty authority.
  const bare = host.startsWith("[") ? host.slice(1, -1) : host;
  return bare === "" ? undefined : bare;
}

/**
 * Why this host may not be targeted, or undefined when it may.
 *
 * @param {string|undefined} host
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|undefined}
 */
export function hostRefusal(host, env = {}) {
  if (!host) return "no host could be parsed from the URL";

  for (const pattern of PROTECTED_HOST_PATTERNS) {
    if (host.includes(pattern)) {
      return `contains "${pattern}", which marks a protected environment`;
    }
  }

  if (LOCAL_HOST_PATTERN.test(host)) return undefined;

  const source = env.LOADTEST_HOST_PATTERN || DEFAULT_HOST_PATTERN;
  let pattern;
  try {
    pattern = new RegExp(source, "i");
  } catch {
    // A malformed override must not become an accidental allow.
    return `LOADTEST_HOST_PATTERN is not a valid regular expression: ${source}`;
  }
  if (pattern.test(host)) return undefined;

  return `does not look like a load-test host (expected it to match ${source}, i.e. to carry a "loadtest" label)`;
}

/**
 * @typedef {Object} TargetRefusal
 * @property {string} endpoint
 * @property {string} url
 * @property {string|undefined} host
 * @property {string} reason
 */

/**
 * Check every endpoint the suites send traffic to.
 *
 * @param {Record<string, string|undefined>} endpoints from `stackEndpoints`
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ok: boolean, hosts: string[], refusals: TargetRefusal[]}}
 */
export function checkTargets(endpoints, env = {}) {
  /** @type {TargetRefusal[]} */
  const refusals = [];
  /** @type {string[]} */
  const hosts = [];

  for (const endpoint of TRAFFIC_ENDPOINTS) {
    const url = endpoints?.[endpoint];
    // An endpoint the caller never set is not a target; `stackEndpoints` fills all of these,
    // but a hand-built object need not.
    if (url === undefined || url === "") continue;

    const host = hostOf(url);
    const reason = hostRefusal(host, env);
    if (reason) {
      refusals.push({ endpoint, url, host, reason });
    } else if (host && !hosts.includes(host)) {
      hosts.push(host);
    }
  }

  return { ok: refusals.length === 0, hosts, refusals };
}

/**
 * Throw unless every target is allowed. The message names each offending endpoint, because
 * the variable to fix is the thing the reader needs.
 *
 * @param {Record<string, string|undefined>} endpoints
 * @param {Record<string, string|undefined>} [env]
 * @returns {string[]} the approved hosts
 */
export function assertTargets(endpoints, env = {}) {
  const result = checkTargets(endpoints, env);
  if (result.ok) return result.hosts;

  const lines = result.refusals.map(
    (r) => `  ${r.endpoint} = ${r.url}\n      host "${r.host ?? "?"}" ${r.reason}`,
  );
  throw new Error(
    "REFUSING TO SEND LOAD: one or more targets are not load-test hosts.\n" +
      `${lines.join("\n")}\n` +
      "    The load profile writes as well as reads, so pointing it at a shared environment\n" +
      "    would seed data there. Fix the variable — do not loosen this check. A genuinely\n" +
      "    differently-named target needs LOADTEST_HOST_PATTERN set explicitly.",
  );
}
