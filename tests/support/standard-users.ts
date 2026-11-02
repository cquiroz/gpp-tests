import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BrowserContext } from "@playwright/test";
import { OdbClient, endpoints } from "./odb.js";

/**
 * Fabricated standard (non-guest) identities — tier 2/3 of
 * research/orcid-auth-testing-strategy.md.
 *
 * `stack/scripts/create-standard-users.sh` inserts the users straight into the SSO database
 * and writes their ids and refresh tokens to `stack/.env.standard-users`; no ORCID account
 * is involved anywhere. The refresh token is the raw session UUID (stored unhashed, see
 * research/sso-standard-user-fabrication.md §2), so injecting it as the
 * `lucuma-refresh-token` cookie gives the browser a ready-made login: Explore's own
 * refresh call finds the session and never shows the login dialog.
 */

export interface StandardUser {
  userId: string;
  roleId: string;
  refreshToken: string;
  cookieDomain: string;
  /**
   * The staff role of the two-role persona (`TEST_DUAL`): the role its session is *not* on,
   * which the role-switch scenario asks SSO to switch to. Absent on single-role personas.
   */
  staffRoleId?: string;
}

export type StandardUserPrefix = "TEST_PI" | "TEST_STAFF" | "TEST_DUAL";

const ENV_FILE = fileURLToPath(
  new URL("../../stack/.env.standard-users", import.meta.url),
);

/** Parses the `export KEY="value"` lines the script writes. */
function fileVars(): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(ENV_FILE, "utf8");
  } catch {
    return {};
  }
  const vars: Record<string, string> = {};
  for (const [, key, value] of text.matchAll(/^export (\w+)="([^"]*)"$/gm)) {
    if (key !== undefined && value !== undefined) vars[key] = value;
  }
  return vars;
}

/**
 * The fabricated user for a prefix (`TEST_PI`, `TEST_STAFF`, `TEST_DUAL`), from the
 * environment if the caller sourced the file, else from the file itself — so `npx playwright
 * test` works in a fresh shell. Undefined (caller should skip) when the script has not been
 * run, or — for `TEST_DUAL` — when it predates the persona.
 */
export function loadStandardUser(prefix: StandardUserPrefix): StandardUser | undefined {
  const vars = { ...fileVars(), ...process.env };
  const userId = vars[`${prefix}_USER_ID`];
  const roleId = vars[`${prefix}_ROLE_ID`];
  const refreshToken = vars[`${prefix}_REFRESH_TOKEN`];
  const staffRoleId = vars[`${prefix}_STAFF_ROLE_ID`];
  const cookieDomain =
    vars.SSO_COOKIE_DOMAIN ?? vars.GPP_TEST_DOMAIN ?? "gpp-test.internal";
  if (!userId || !roleId || !refreshToken) return undefined;
  if (prefix === "TEST_DUAL" && !staffRoleId) return undefined;
  return { userId, roleId, refreshToken, cookieDomain, staffRoleId };
}

/** JWT payload fields the assertions care about. */
export interface StandardClaims {
  "lucuma-user": {
    id: string;
    type: string;
    role: { type: string; id: string };
    otherRoles?: { type: string; id: string }[];
    givenName?: string;
    familyName?: string;
  };
}

/**
 * A browser-and-API session for a fabricated standard user, mirroring GuestSession: the
 * browser side is the injected cookie, and the API side refreshes JWTs through the same
 * SSO endpoint Explore uses, so both halves are provably the same identity.
 */
export class StandardSession {
  private token: string | undefined;
  private issuedAt = 0;
  /** The session cookie in force: the fabricated one until the browser rotates it. */
  private refreshToken: string;

  constructor(readonly user: StandardUser) {
    this.refreshToken = user.refreshToken;
  }

  /** Call before the first navigation; the leading dot sends the cookie to every stack host. */
  async inject(context: BrowserContext): Promise<void> {
    await context.addCookies([
      {
        name: "lucuma-refresh-token",
        value: this.refreshToken,
        domain: `.${this.user.cookieDomain}`,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Strict",
        expires: -1,
      },
    ]);
  }

  /**
   * Re-reads the session cookie from the browser, for after an action that makes SSO replace
   * it — a role switch starts a new session on the other role (`Routes.scala`, `set-role`:
   * `res.addCookie(coo)`). From here on the API side refreshes through the browser's current
   * session, so its read-backs run as whatever the browser has become. Returns the cookie
   * value, so a caller can assert it actually changed.
   */
  async adoptBrowserCookie(context: BrowserContext): Promise<string> {
    const cookie = (await context.cookies()).find((c) => c.name === "lucuma-refresh-token");
    if (!cookie) throw new Error("the browser context holds no lucuma-refresh-token cookie");
    this.refreshToken = cookie.value;
    this.token = undefined;
    this.issuedAt = 0;
    return cookie.value;
  }

  /** A JWT with life left in it, minted through the session's refresh token. */
  async jwt(): Promise<string> {
    const ageSeconds = (Date.now() - this.issuedAt) / 1000;
    if (this.token && ageSeconds < 8 * 60) return this.token;

    const response = await fetch(endpoints.ssoRefreshUrl, {
      method: "POST",
      headers: { cookie: `lucuma-refresh-token=${this.refreshToken}` },
    });
    if (!response.ok) {
      throw new Error(
        `refresh-token returned ${response.status} for the fabricated session — ` +
          "was the stack rebuilt since create-standard-users.sh ran?",
      );
    }
    this.token = (await response.text()).trim().replace(/^"|"$/g, "");
    this.issuedAt = Date.now();
    return this.token;
  }

  async claims(): Promise<StandardClaims> {
    const payload = (await this.jwt()).split(".")[1];
    if (!payload) throw new Error("refresh-token returned something that is not a JWT");
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  }

  client(): OdbClient {
    return new OdbClient(() => this.jwt());
  }
}
