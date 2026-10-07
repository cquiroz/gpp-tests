// Authentication for k6 VUs: SSO guests (spec §4) and fabricated standard users.
//
// A guest VU calls `POST /api/v1/auth-as-guest`, which needs no credentials, so there is no
// test-user pool to provision and no test credentials anywhere. SSO issues 10-minute JWTs
// plus a permanent `lucuma-refresh-token` cookie; k6's per-VU cookie jar stores it, and
// `POST /api/v1/refresh-token` mints a fresh JWT with no CSRF or Origin check
// (research/guest-visibility-refresh.md). Guests see only their own programs, which is why
// each VU seeds its own working set.
//
// A standard user (PI, staff) is fabricated into the SSO database by
// `stack/scripts/create-standard-users.sh`; its refresh token *is* its session, so seeding
// that as the cookie and calling refresh-token yields a JWT for that user — no ORCID, no new
// mechanism (`tests/support/standard-users.ts` does the same for the browser). The two
// browser personas arrive through the environment (`TEST_PI_*`, `TEST_STAFF_*`); the load
// pool arrives as a file (`standard-users.js`).
import http from "k6/http";
import { fail, sleep } from "k6";
import { endpoints } from "./config.js";
import { tags } from "./metrics.js";

/**
 * Pause before giving up on a failed login.
 *
 * `fail()` throws, which aborts the iteration *before* it reaches its `think()` — so when SSO
 * becomes unreachable, every VU drops into a tight retry loop with no pacing at all. Measured
 * on the 2026-08-27 AWS run: once the proxy died, 1500 VUs drove 3,673 iterations/second
 * against a dead endpoint (the healthy rate is ~46/s), producing 8.1M iterations, 15.5M
 * requests and an 866 MB log — and burying the pre-failure metrics under millions of
 * zero-millisecond errors.
 *
 * A failing target should be measured, not hammered: this keeps the failure visible in the
 * metrics while pacing the retries roughly like a real user's.
 */
const FAILURE_BACKOFF_SECONDS = Number(__ENV.AUTH_FAILURE_BACKOFF || 3);

// Refresh comfortably inside SSO's 10-minute JWT lifetime. Configurable because the spec
// asks lucuma-odb to make `Config.JwtLifetime` an environment variable (spec §10 ask 2):
// once a test environment can issue long-lived JWTs, this can be raised and the refresh
// traffic drops out of the load profile.
const REFRESH_AFTER_MS =
  Number(__ENV.JWT_REFRESH_AFTER_SECONDS || 8 * 60) * 1000;

/**
 * The guest's cookie jar, because **k6 resets the default per-VU jar between iterations**
 * (verified against k6 v2.2.0: a refresh in a later iteration gets 403 with the default jar
 * and 200 with this one). A load run lasts 40 minutes and a JWT lasts 10, so without this
 * every VU would quietly turn into a *new* guest — and a new guest sees none of the programs
 * the old one seeded, which would hollow out the read half of the mix while still looking
 * green. Module scope is per-VU, so each VU keeps its own session.
 *
 * Standard-user sessions carry a jar of their own (`Session.jar`), so one VU can hold a
 * guest and a standard identity at once — the regression suite does — without one refresh
 * overwriting the other's cookie.
 */
const guestJar = new http.CookieJar();

/**
 * @typedef {object} Session
 * @property {string} token the JWT
 * @property {number} issuedAt when it was minted (ms since epoch)
 * @property {boolean} [reauthenticated] the session now belongs to a *different* guest than
 *   before, i.e. one whose working set has to be seeded again
 * @property {string} [refreshToken] set on a standard user's session: the SSO session id
 *   the JWT is refreshed from, which also means a refresh failure must not fall back to a
 *   guest
 * @property {string} [label] who this is, for error messages (`TEST_PI`, `pi #12`)
 * @property {import("k6/http").CookieJar} [jar] the standard session's own cookie jar
 */

/** @typedef {Session} GuestSession */

/** @returns {Session} */
export function loginAsGuest() {
  const response = http.post(endpoints.ssoGuestUrl, null, {
    jar: guestJar,
    tags: tags({ scenario: "login", operation: "AuthAsGuest" }),
  });
  if (response.status !== 201) {
    sleep(FAILURE_BACKOFF_SECONDS);
    fail(
      `auth-as-guest returned ${response.status} (expected 201) from ${endpoints.ssoGuestUrl}`,
    );
  }
  return { token: extractToken(response.body), issuedAt: Date.now() };
}

/**
 * Refresh the JWT if it is close to expiring. The cookie travels from the session's jar.
 * @param {Session} session
 * @returns {Session}
 */
export function refreshed(session) {
  if (Date.now() - session.issuedAt < REFRESH_AFTER_MS) return session;

  const response = http.post(endpoints.ssoRefreshUrl, null, {
    jar: session.jar || guestJar,
    tags: tags({ scenario: "login", operation: "RefreshToken" }),
  });
  if (response.status === 200) {
    return { ...session, token: extractToken(response.body), issuedAt: Date.now() };
  }

  if (session.refreshToken) {
    // A standard user's session row lives until the stack is torn down, so this means the
    // stack was rebuilt under the run (or SSO is down). Becoming a guest would be a different
    // identity that cannot touch this user's proposals, so stop rather than degrade.
    sleep(FAILURE_BACKOFF_SECONDS);
    fail(
      `refresh-token returned ${response.status} for ${session.label || "a standard user"}; ` +
        `re-run stack/scripts/create-standard-users.sh against this stack`,
    );
  }

  // The guest session is gone. A fresh guest keeps the VU running, but it is a *different*
  // identity that cannot see the programs this VU seeded, so say so loudly rather than
  // letting the read mix quietly degrade to empty result sets.
  console.warn(
    `refresh-token returned ${response.status}; falling back to a new guest — ` +
      `this VU's seeded programs are no longer visible to it`,
  );
  return { ...loginAsGuest(), reauthenticated: true };
}

/**
 * Log in as a fabricated standard user from a refresh token (the SSO session id the user
 * script inserted). Fails the iteration when SSO refuses it — a fabricated session that
 * stopped working is a stack problem, not a measurement.
 *
 * @param {string} refreshToken
 * @param {string} label who this is, for the failure message
 * @returns {Session}
 */
export function loginWithRefreshToken(refreshToken, label) {
  const jar = new http.CookieJar();
  jar.set(endpoints.ssoRefreshUrl, "lucuma-refresh-token", refreshToken, {
    domain: __ENV.SSO_COOKIE_DOMAIN || endpoints.domain,
    path: "/",
    secure: true,
    http_only: true,
  });
  const response = http.post(endpoints.ssoRefreshUrl, null, {
    jar,
    tags: tags({ scenario: "login", operation: "RefreshToken" }),
  });
  if (response.status !== 200) {
    sleep(FAILURE_BACKOFF_SECONDS);
    fail(
      `refresh-token returned ${response.status} for ${label}; ` +
        `re-run stack/scripts/create-standard-users.sh against this stack`,
    );
  }
  return {
    token: extractToken(response.body),
    issuedAt: Date.now(),
    refreshToken,
    label,
    jar,
  };
}

/**
 * Log in as one of the two browser personas (`stack/scripts/create-standard-users.sh`), whose
 * refresh token comes from `<PREFIX>_REFRESH_TOKEN` — the regression workflow sources the
 * file with the rest of the stack's environment.
 *
 * @param {"TEST_PI" | "TEST_STAFF"} prefix
 * @returns {Session | undefined} undefined when the user has not been fabricated
 */
export function loginAsStandardUser(prefix) {
  const refreshToken = __ENV[`${prefix}_REFRESH_TOKEN`];
  if (!refreshToken) return undefined;
  return loginWithRefreshToken(refreshToken, prefix);
}

/** @param {string | ArrayBuffer | null} body */
function extractToken(body) {
  const token = String(body || "").trim().replace(/^"|"$/g, "");
  if (!token.startsWith("ey")) {
    sleep(FAILURE_BACKOFF_SECONDS);
    fail(`SSO did not return a JWT: ${String(body).slice(0, 200)}`);
  }
  return token;
}
