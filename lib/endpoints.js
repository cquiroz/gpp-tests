/**
 * Endpoint algebra for both test environments (spec §3, §6).
 *
 * Everything a suite talks to is derived from one domain so the ephemeral stack
 * (`*.gpp-test.internal`, fronted by Caddy) and the persistent load target
 * (`*.<your-domain>`) differ by a single environment variable. Individual endpoints can
 * still be overridden outright, which is how a suite is pointed at bare Heroku hostnames.
 *
 * Pure and dependency-free on purpose: k6 imports this module directly.
 *
 * @typedef {Object} Endpoints
 * @property {string} domain
 * @property {string} exploreUrl
 * @property {string} ssoUrl
 * @property {string} ssoGuestUrl
 * @property {string} ssoRefreshUrl
 * @property {string} odbRestUrl      ODB HTTP root (Explore's `odbRestURI`)
 * @property {string} odbGraphqlUrl   ODB GraphQL endpoint (`<root>/odb`)
 * @property {string} odbWsUrl        ODB graphql-ws endpoint (Explore's `odbURI`)
 * @property {string} itcUrl
 * @property {string} prefsWsUrl
 * @property {string|undefined} otelEndpoint
 */

const DEFAULT_DOMAIN = "gpp-test.internal";

/** @param {string} url */
const trimSlash = (url) => url.replace(/\/+$/, "");

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {Endpoints}
 */
export function stackEndpoints(env = {}) {
  const domain = env.GPP_TEST_DOMAIN || DEFAULT_DOMAIN;
  const scheme = env.GPP_TEST_SCHEME || "https";
  const wsScheme = scheme === "https" ? "wss" : "ws";

  /** @param {string} host */
  const http = (host) => `${scheme}://${host}.${domain}`;
  /** @param {string} host */
  const ws = (host) => `${wsScheme}://${host}.${domain}`;

  /**
   * @param {string|undefined} override
   * @param {string} fallback
   */
  const pick = (override, fallback) =>
    override ? trimSlash(override) : fallback;

  const ssoUrl = pick(env.SSO_URL, http("sso"));
  const odbRestUrl = pick(env.ODB_REST_URL, http("odb"));

  return {
    domain,
    exploreUrl: pick(env.EXPLORE_URL, http("explore")),
    ssoUrl,
    ssoGuestUrl: `${ssoUrl}/api/v1/auth-as-guest`,
    ssoRefreshUrl: `${ssoUrl}/api/v1/refresh-token`,
    odbRestUrl,
    odbGraphqlUrl: pick(env.ODB_GRAPHQL_URL, `${odbRestUrl}/odb`),
    odbWsUrl: pick(env.ODB_WS_URL, `${ws("odb")}/ws`),
    itcUrl: pick(env.ITC_URL, `${http("itc")}/itc`),
    prefsWsUrl: pick(env.PREFS_WS_URL, `${ws("prefs")}/v1/graphql`),
    otelEndpoint: env.EXPLORE_OTEL_ENDPOINT || undefined,
  };
}

/**
 * The `environments.conf.json` Explore fetches at runtime: one wildcard entry, because a
 * throwaway stack is reached under whatever host the runner resolves.
 *
 * Used only as the fallback — prefer {@link mergeEnvironmentsConf}, which overlays these
 * endpoints onto the bundle's own conf and so survives schema drift in lucuma-apps.
 *
 * @param {Endpoints} endpoints
 * @returns {Record<string, any>[]}
 */
export function exploreEnvironmentsConf(endpoints) {
  /** @type {Record<string, any>} */
  const entry = {
    hostName: "*",
    environment: "Development",
    ...exploreEndpointFields(endpoints),
  };
  if (endpoints.otelEndpoint) entry.otelEndpoint = endpoints.otelEndpoint;
  return [entry];
}

/**
 * Overlay our endpoints on the conf shipped with the Explore bundle, keeping every field
 * we do not understand (the shipped schema tracks lucuma-apps `main`, and a field the
 * decoder requires but we omit would leave Explore unable to start).
 *
 * @param {unknown} upstreamConf parsed `environments.conf.json` from the bundle
 * @param {Endpoints} endpoints
 * @returns {Record<string, any>[]}
 */
export function mergeEnvironmentsConf(upstreamConf, endpoints) {
  const wildcard = Array.isArray(upstreamConf)
    ? upstreamConf.find(
        (e) => e && typeof e === "object" && e.hostName === "*",
      )
    : undefined;
  if (!wildcard) return exploreEnvironmentsConf(endpoints);

  /** @type {Record<string, any>} */
  const entry = {
    ...wildcard,
    ...exploreEndpointFields(endpoints),
    sso: { ...(wildcard.sso ?? {}), uri: endpoints.ssoUrl },
  };
  // Never inherit an upstream OTel endpoint: test traffic must not land in the dev
  // environment's traces. Ours is set explicitly or not at all (spec §7).
  delete entry.otelEndpoint;
  if (endpoints.otelEndpoint) entry.otelEndpoint = endpoints.otelEndpoint;
  return [entry];
}

/**
 * @param {Endpoints} endpoints
 * @returns {Record<string, any>}
 */
function exploreEndpointFields(endpoints) {
  return {
    odbURI: endpoints.odbWsUrl,
    odbRestURI: endpoints.odbRestUrl,
    preferencesDBURI: endpoints.prefsWsUrl,
    itcURI: endpoints.itcUrl,
    sso: { uri: endpoints.ssoUrl },
  };
}
