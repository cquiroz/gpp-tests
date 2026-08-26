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
}

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
 * The fabricated user for a prefix (`TEST_PI`, `TEST_STAFF`), from the environment if the
 * caller sourced the file, else from the file itself — so `npx playwright test` works in a
 * fresh shell. Undefined (caller should skip) when the script has not been run.
 */
export function loadStandardUser(
  prefix: "TEST_PI" | "TEST_STAFF",
): StandardUser | undefined {
  const vars = { ...fileVars(), ...process.env };
  const userId = vars[`${prefix}_USER_ID`];
  const roleId = vars[`${prefix}_ROLE_ID`];
  const refreshToken = vars[`${prefix}_REFRESH_TOKEN`];
  const cookieDomain =
    vars.SSO_COOKIE_DOMAIN ?? vars.GPP_TEST_DOMAIN ?? "gpp-test.internal";
  if (!userId || !roleId || !refreshToken) return undefined;
  return { userId, roleId, refreshToken, cookieDomain };
}

/** JWT payload fields the assertions care about. */
export interface StandardClaims {
  "lucuma-user": {
    id: string;
    type: string;
    role: { type: string };
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

  constructor(readonly user: StandardUser) {}

  /** Call before the first navigation; the leading dot sends the cookie to every stack host. */
  async inject(context: BrowserContext): Promise<void> {
    await context.addCookies([
      {
        name: "lucuma-refresh-token",
        value: this.user.refreshToken,
        domain: `.${this.user.cookieDomain}`,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Strict",
        expires: -1,
      },
    ]);
  }

  /** A JWT with life left in it, minted through the session's refresh token. */
  async jwt(): Promise<string> {
    const ageSeconds = (Date.now() - this.issuedAt) / 1000;
    if (this.token && ageSeconds < 8 * 60) return this.token;

    const response = await fetch(endpoints.ssoRefreshUrl, {
      method: "POST",
      headers: { cookie: `lucuma-refresh-token=${this.user.refreshToken}` },
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
