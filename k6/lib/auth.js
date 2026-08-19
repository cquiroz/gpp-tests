// Guest authentication for k6 VUs (spec §4).
//
// Every load identity is an SSO guest: `POST /api/v1/auth-as-guest` needs no credentials, so
// there is no test-user pool to provision and no test credentials anywhere. SSO issues
// 10-minute JWTs plus a permanent `lucuma-refresh-token` cookie; k6's per-VU cookie jar
// stores it, and `POST /api/v1/refresh-token` mints a fresh JWT with no CSRF or Origin check
// (research/guest-visibility-refresh.md). Guests see only their own programs, which is why
// each VU seeds its own working set.
import http from "k6/http";
import { fail } from "k6";
import { endpoints } from "./config.js";
import { tags } from "./metrics.js";

// Refresh comfortably inside SSO's 10-minute JWT lifetime. Configurable because the spec
// asks lucuma-odb to make `Config.JwtLifetime` an environment variable (spec §10 ask 2):
// once a test environment can issue long-lived JWTs, this can be raised and the refresh
// traffic drops out of the load profile.
const REFRESH_AFTER_MS =
  Number(__ENV.JWT_REFRESH_AFTER_SECONDS || 8 * 60) * 1000;

/**
 * Our own cookie jar, because **k6 resets the default per-VU jar between iterations**
 * (verified against k6 v2.2.0: a refresh in a later iteration gets 403 with the default jar
 * and 200 with this one). A load run lasts 40 minutes and a JWT lasts 10, so without this
 * every VU would quietly turn into a *new* guest — and a new guest sees none of the programs
 * the old one seeded, which would hollow out the read half of the mix while still looking
 * green. Module scope is per-VU, so each VU keeps its own session.
 */
const jar = new http.CookieJar();

/**
 * @typedef {{token: string, issuedAt: number, reauthenticated?: boolean}} GuestSession
 *   `reauthenticated` marks a session belonging to a *different* guest than before, i.e. one
 *   whose working set has to be seeded again.
 * @returns {GuestSession}
 */
export function loginAsGuest() {
  const response = http.post(endpoints.ssoGuestUrl, null, {
    jar,
    tags: tags({ scenario: "login", operation: "AuthAsGuest" }),
  });
  if (response.status !== 201) {
    fail(
      `auth-as-guest returned ${response.status} (expected 201) from ${endpoints.ssoGuestUrl}`,
    );
  }
  return { token: extractToken(response.body), issuedAt: Date.now() };
}

/**
 * Refresh the JWT if it is close to expiring. The cookie travels from the VU's jar.
 * @param {GuestSession} session
 * @returns {GuestSession}
 */
export function refreshed(session) {
  if (Date.now() - session.issuedAt < REFRESH_AFTER_MS) return session;

  const response = http.post(endpoints.ssoRefreshUrl, null, {
    jar,
    tags: tags({ scenario: "login", operation: "RefreshToken" }),
  });
  if (response.status !== 200) {
    // The session is gone. A fresh guest keeps the VU running, but it is a *different*
    // identity that cannot see the programs this VU seeded, so say so loudly rather than
    // letting the read mix quietly degrade to empty result sets.
    console.warn(
      `refresh-token returned ${response.status}; falling back to a new guest — ` +
        `this VU's seeded programs are no longer visible to it`,
    );
    return { ...loginAsGuest(), reauthenticated: true };
  }
  return { token: extractToken(response.body), issuedAt: Date.now() };
}

/** @param {string | ArrayBuffer | null} body */
function extractToken(body) {
  const token = String(body || "").trim().replace(/^"|"$/g, "");
  if (!token.startsWith("ey")) {
    fail(`SSO did not return a JWT: ${String(body).slice(0, 200)}`);
  }
  return token;
}
