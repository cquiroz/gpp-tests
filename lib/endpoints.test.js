import { describe, expect, it } from "vitest";
import {
  exploreEnvironmentsConf,
  mergeEnvironmentsConf,
  stackEndpoints,
} from "./endpoints.js";

describe("stackEndpoints", () => {
  it("derives every stack URL from the test domain", () => {
    const e = stackEndpoints({});

    expect(e.exploreUrl).toBe("https://explore.gpp-test.internal");
    expect(e.ssoUrl).toBe("https://sso.gpp-test.internal");
    expect(e.odbRestUrl).toBe("https://odb.gpp-test.internal");
    // GraphQLRoutes mounts the ODB API at path "odb".
    expect(e.odbGraphqlUrl).toBe("https://odb.gpp-test.internal/odb");
    expect(e.odbWsUrl).toBe("wss://odb.gpp-test.internal/ws");
    expect(e.itcUrl).toBe("https://itc.gpp-test.internal/itc");
    expect(e.prefsWsUrl).toBe("wss://prefs.gpp-test.internal/v1/graphql");
  });

  it("honours a different domain and scheme for the load target", () => {
    const e = stackEndpoints({
      GPP_TEST_DOMAIN: "gpp-loadtest.example.org",
      GPP_TEST_SCHEME: "http",
    });

    expect(e.exploreUrl).toBe("http://explore.gpp-loadtest.example.org");
    expect(e.odbWsUrl).toBe("ws://odb.gpp-loadtest.example.org/ws");
    expect(e.prefsWsUrl).toBe("ws://prefs.gpp-loadtest.example.org/v1/graphql");
  });

  it("lets individual endpoints be overridden outright", () => {
    const e = stackEndpoints({
      ODB_GRAPHQL_URL: "https://lucuma-postgres-odb-loadtest.herokuapp.com/odb",
      SSO_URL: "https://sso-loadtest.example.org",
    });

    expect(e.odbGraphqlUrl).toBe(
      "https://lucuma-postgres-odb-loadtest.herokuapp.com/odb",
    );
    expect(e.ssoUrl).toBe("https://sso-loadtest.example.org");
    // Untouched endpoints still follow the domain default.
    expect(e.exploreUrl).toBe("https://explore.gpp-test.internal");
  });

  it("strips a trailing slash from overrides so joined paths stay clean", () => {
    const e = stackEndpoints({ SSO_URL: "https://sso.example.org/" });
    expect(e.ssoUrl).toBe("https://sso.example.org");
  });

  it("exposes the SSO guest and refresh endpoints k6 and Playwright both use", () => {
    const e = stackEndpoints({});
    expect(e.ssoGuestUrl).toBe(
      "https://sso.gpp-test.internal/api/v1/auth-as-guest",
    );
    expect(e.ssoRefreshUrl).toBe(
      "https://sso.gpp-test.internal/api/v1/refresh-token",
    );
  });
});

describe("exploreEnvironmentsConf", () => {
  it("builds a single wildcard entry pointing at the ephemeral stack", () => {
    const conf = exploreEnvironmentsConf(stackEndpoints({}));

    expect(conf).toHaveLength(1);
    const entry = /** @type {Record<string, any>} */ (conf[0]);
    expect(entry.hostName).toBe("*");
    expect(entry.odbURI).toBe("wss://odb.gpp-test.internal/ws");
    expect(entry.odbRestURI).toBe("https://odb.gpp-test.internal");
    expect(entry.preferencesDBURI).toBe(
      "wss://prefs.gpp-test.internal/v1/graphql",
    );
    expect(entry.itcURI).toBe("https://itc.gpp-test.internal/itc");
    expect(entry.sso).toEqual({ uri: "https://sso.gpp-test.internal" });
  });

  it("omits otelEndpoint unless one is configured (the decoder tolerates absence)", () => {
    const conf = exploreEnvironmentsConf(stackEndpoints({}));
    expect(conf[0]).not.toHaveProperty("otelEndpoint");

    const withOtel = exploreEnvironmentsConf(
      stackEndpoints({ EXPLORE_OTEL_ENDPOINT: "https://otlp.example.org" }),
    );
    expect(withOtel[0]?.otelEndpoint).toBe("https://otlp.example.org");
  });
});

describe("mergeEnvironmentsConf", () => {
  // Explore's AppConfig decoder is strict about required fields and the shipped schema
  // moves with main, so we overlay our endpoints onto the bundle's own conf rather than
  // authoring one from scratch.
  const upstream = [
    {
      hostName: "*",
      environment: "Development",
      odbURI: "wss://odb-dev.lucuma.xyz/ws",
      odbRestURI: "https://odb-dev.lucuma.xyz",
      preferencesDBURI: "wss://gpp-prefs-dev.lucuma.xyz/v1/graphql",
      itcURI: "https://itc-dev.lucuma.xyz/itc",
      sso: { uri: "https://sso-dev.gpp.lucuma.xyz", someFutureField: 42 },
      otelEndpoint: "https://otlp-gateway.grafana.net/otlp",
      unknownFutureField: "keep me",
    },
    { hostName: "explore.gemini.edu", environment: "Production" },
  ];

  it("rewrites only the wildcard entry and keeps unknown fields", () => {
    const merged = mergeEnvironmentsConf(upstream, stackEndpoints({}));

    expect(merged).toHaveLength(1);
    const entry = /** @type {Record<string, any>} */ (merged[0]);
    expect(entry.hostName).toBe("*");
    expect(entry.environment).toBe("Development");
    expect(entry.unknownFutureField).toBe("keep me");
    expect(entry.sso).toEqual({
      uri: "https://sso.gpp-test.internal",
      someFutureField: 42,
    });
    expect(entry.odbURI).toBe("wss://odb.gpp-test.internal/ws");
    expect(entry.itcURI).toBe("https://itc.gpp-test.internal/itc");
  });

  it("drops the upstream otelEndpoint so a test stack never ships traces to a prod endpoint", () => {
    const merged = mergeEnvironmentsConf(upstream, stackEndpoints({}));
    expect(merged[0]).not.toHaveProperty("otelEndpoint");
  });

  it("falls back to a generated conf when the bundle has no wildcard entry", () => {
    const merged = mergeEnvironmentsConf(
      [{ hostName: "explore.gemini.edu" }],
      stackEndpoints({}),
    );
    expect(merged).toEqual(exploreEnvironmentsConf(stackEndpoints({})));
  });

  it("tolerates junk in place of a conf array", () => {
    const endpoints = stackEndpoints({});
    expect(mergeEnvironmentsConf(null, endpoints)).toEqual(
      exploreEnvironmentsConf(endpoints),
    );
    expect(mergeEnvironmentsConf({ hostName: "*" }, endpoints)).toEqual(
      exploreEnvironmentsConf(endpoints),
    );
  });
});
