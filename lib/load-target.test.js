import { describe, expect, it } from "vitest";
import { stackEndpoints } from "./endpoints.js";
import {
  assertTargets,
  checkTargets,
  hostOf,
  hostRefusal,
} from "./load-target.js";

/**
 * The traffic-plane counterpart to `loadtest/guard.test.sh`: what the load profile is allowed
 * to point at. Every case is phrased as "would this have sent 200 VUs somewhere it must not".
 */

describe("hostOf", () => {
  it("takes the host out of the URLs the suites actually use", () => {
    expect(hostOf("https://odb.lucuma-loadtest.example.edu/odb")).toBe(
      "odb.lucuma-loadtest.example.edu",
    );
    expect(hostOf("wss://odb.gpp-test.internal/ws")).toBe("odb.gpp-test.internal");
    expect(hostOf("https://odb-loadtest.example.edu:8443/odb")).toBe(
      "odb-loadtest.example.edu",
    );
    expect(hostOf("https://user:pass@odb-loadtest.example.edu/odb")).toBe(
      "odb-loadtest.example.edu",
    );
    expect(hostOf("HTTPS://ODB-LOADTEST.EXAMPLE.EDU/odb")).toBe(
      "odb-loadtest.example.edu",
    );
    expect(hostOf("http://[::1]:8080/odb")).toBe("::1");
  });

  it("gives up rather than guessing, so the caller refuses", () => {
    // A scheme-less override is exactly the kind of typo that must not become an allow.
    expect(hostOf("odb.example.edu/odb")).toBeUndefined();
    expect(hostOf("")).toBeUndefined();
    expect(hostOf(undefined)).toBeUndefined();
    expect(hostOf("https://")).toBeUndefined();
  });
});

describe("hostRefusal", () => {
  it("allows dedicated load-test hosts", () => {
    for (const host of [
      "lucuma-postgres-odb-loadtest.herokuapp.com",
      "odb.loadtest.example.edu",
      "odb.aws-loadtest.internal",
      "loadtest.example.edu",
      "odb-loadtest.example.edu",
    ]) {
      expect(hostRefusal(host), host).toBeUndefined();
    }
  });

  it("allows the ephemeral stack and a developer's own machine", () => {
    for (const host of [
      "odb.gpp-test.internal",
      "sso.gpp-test.internal",
      "localhost",
      "127.0.0.1",
      "::1",
    ]) {
      expect(hostRefusal(host), host).toBeUndefined();
    }
  });

  it("refuses a host that does not identify itself as a load-test host", () => {
    // The case that matters most: real production hostnames need not contain "production",
    // so this rule — not the protected list — is what keeps traffic off production.
    expect(hostRefusal("gpp.gemini.edu")).toMatch(/does not look like a load-test host/);
    expect(hostRefusal("lucuma-postgres-odb.herokuapp.com")).toMatch(
      /does not look like a load-test host/,
    );
  });

  it("refuses protected substrings even when the name also says loadtest", () => {
    for (const host of [
      "lucuma-postgres-odb-production.herokuapp.com",
      "odb-production-loadtest.example.edu",
      "odb.staging.example.edu",
      "lucuma-postgres-odb-dev.herokuapp.com",
      "odb-loadtest-prod.example.edu",
    ]) {
      expect(hostRefusal(host), host).toMatch(/protected environment/);
    }
  });

  it("refuses when no host could be parsed", () => {
    expect(hostRefusal(undefined)).toMatch(/no host/);
    expect(hostRefusal("")).toMatch(/no host/);
  });

  it("lets a genuinely different naming scheme be opted into", () => {
    const env = { LOADTEST_HOST_PATTERN: "^odb\\.perf\\.example\\.edu$" };
    expect(hostRefusal("odb.perf.example.edu", env)).toBeUndefined();
    // The override widens rule 1 only; the protected list still applies.
    expect(hostRefusal("odb.perf.production.example.edu", env)).toMatch(
      /protected environment/,
    );
    // And it does not disable the rule for everything else.
    expect(hostRefusal("gpp.gemini.edu", env)).toMatch(/does not look like/);
  });

  it("treats a malformed override as a refusal, not an allow", () => {
    expect(hostRefusal("odb.example.edu", { LOADTEST_HOST_PATTERN: "([" })).toMatch(
      /not a valid regular expression/,
    );
  });
});

describe("checkTargets", () => {
  it("passes the nightly load run's own configuration", () => {
    // Exactly what performance.yml sets: the ODB and SSO are overridden to the load target,
    // and the rest fall back to the ephemeral defaults, which the suite does not use.
    const endpoints = stackEndpoints({
      ODB_GRAPHQL_URL: "https://lucuma-postgres-odb-loadtest.herokuapp.com/odb",
      SSO_URL: "https://lucuma-sso-loadtest.herokuapp.com",
    });
    const result = checkTargets(endpoints);
    expect(result.ok).toBe(true);
    expect(result.hosts).toContain("lucuma-postgres-odb-loadtest.herokuapp.com");
  });

  it("passes a local run against the ephemeral stack", () => {
    expect(checkTargets(stackEndpoints({})).ok).toBe(true);
    expect(checkTargets(stackEndpoints({ GPP_TEST_SCHEME: "http" })).ok).toBe(true);
  });

  it("catches a production ODB behind an otherwise correct configuration", () => {
    const endpoints = stackEndpoints({
      ODB_GRAPHQL_URL: "https://gpp.gemini.edu/odb",
      SSO_URL: "https://lucuma-sso-loadtest.herokuapp.com",
    });
    const result = checkTargets(endpoints);
    expect(result.ok).toBe(false);
    expect(result.refusals).toHaveLength(1);
    const [refusal] = result.refusals;
    expect(refusal?.endpoint).toBe("odbGraphqlUrl");
    expect(refusal?.host).toBe("gpp.gemini.edu");
  });

  it("catches a production SSO, which would also mean real accounts", () => {
    const result = checkTargets(
      stackEndpoints({
        ODB_GRAPHQL_URL: "https://lucuma-postgres-odb-loadtest.herokuapp.com/odb",
        SSO_URL: "https://lucuma-sso-production.herokuapp.com",
      }),
    );
    expect(result.ok).toBe(false);
    // ssoUrl is the override; the derived guest/refresh URLs share its host.
    expect(result.refusals.map((r) => r.endpoint)).toContain("ssoUrl");
  });

  it("ignores the OTel endpoint, whose own hostname says prod", () => {
    const endpoints = stackEndpoints({
      EXPLORE_OTEL_ENDPOINT: "https://otlp-gateway-prod-us-east-0.grafana.net/otlp",
    });
    expect(checkTargets(endpoints).ok).toBe(true);
  });

  it("refuses a whole set when any one member is wrong", () => {
    const result = checkTargets({
      odbGraphqlUrl: "https://odb-loadtest.example.edu/odb",
      ssoUrl: "https://sso-loadtest.example.edu",
      itcUrl: "https://itc.gemini.edu/itc",
    });
    expect(result.ok).toBe(false);
    expect(result.refusals.map((r) => r.endpoint)).toEqual(["itcUrl"]);
  });
});

describe("assertTargets", () => {
  it("returns the approved hosts when everything checks out", () => {
    expect(
      assertTargets({ odbGraphqlUrl: "https://odb-loadtest.example.edu/odb" }),
    ).toEqual(["odb-loadtest.example.edu"]);
  });

  it("throws naming the endpoint to fix, not just that something is wrong", () => {
    expect(() =>
      assertTargets({ odbGraphqlUrl: "https://gpp.gemini.edu/odb" }),
    ).toThrow(/odbGraphqlUrl = https:\/\/gpp\.gemini\.edu\/odb/);
  });

  it("refuses an empty target rather than treating it as nothing to check", () => {
    // `stackEndpoints` never yields this, but a hand-assembled object could.
    expect(() => assertTargets({ odbGraphqlUrl: "not-a-url" })).toThrow(
      /no host could be parsed/,
    );
  });
});
