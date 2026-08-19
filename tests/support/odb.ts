import type { BrowserContext, Page } from "@playwright/test";
import { stackEndpoints } from "../../lib/endpoints.js";
import type { Operation } from "../../lib/odb-operations.js";

/**
 * Direct GraphQL access for the journey's read-back assertions (spec §5).
 *
 * Every browser step is followed by a query straight to the ODB, which is what separates
 * "the backend broke" from "the frontend broke" when a run goes red. The read-back must run
 * as the *same* identity as the browser session: a guest sees only its own programs, so a
 * second guest would legitimately see nothing.
 */

export const endpoints = stackEndpoints(process.env);

export class GraphQLError extends Error {
  constructor(
    readonly operationName: string,
    readonly errors: unknown[],
  ) {
    super(
      `${operationName} failed: ${JSON.stringify(errors, null, 2).slice(0, 2000)}`,
    );
    this.name = "GraphQLError";
  }
}

export class OdbClient {
  constructor(
    private readonly token: () => Promise<string>,
    private readonly url: string = endpoints.odbGraphqlUrl,
  ) {}

  /** Runs an operation and returns `data`, throwing on any GraphQL error. */
  async run<T = any>(operation: Operation): Promise<T> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await this.token()}`,
      },
      body: JSON.stringify({
        operationName: operation.operationName,
        query: operation.query,
        variables: operation.variables,
      }),
    });

    if (!response.ok) {
      throw new GraphQLError(operation.operationName, [
        { httpStatus: response.status, body: (await response.text()).slice(0, 1000) },
      ]);
    }

    const payload = (await response.json()) as {
      data?: T;
      errors?: unknown[];
    };
    if (payload.errors?.length) {
      throw new GraphQLError(operation.operationName, payload.errors);
    }
    if (payload.data === undefined) {
      throw new GraphQLError(operation.operationName, [
        { message: "response carried neither data nor errors" },
      ]);
    }
    return payload.data;
  }
}

/**
 * The guest identity shared by the browser and the read-back client.
 *
 * SSO issues 10-minute JWTs and a permanent `lucuma-refresh-token` cookie (spec §4). The
 * journey can outlive one JWT, so the token is refreshed from the browser context's cookie
 * rather than captured once — the same mechanism Explore itself uses.
 */
export class GuestSession {
  private token: string | undefined;
  private issuedAt = 0;

  private constructor(private readonly context: BrowserContext) {}

  /**
   * Starts watching for the guest login Explore performs, so the journey's first token is
   * the browser's own. Attach this *before* clicking "Continue as Guest".
   */
  static watch(page: Page): GuestSession {
    const session = new GuestSession(page.context());
    page.on("response", (response) => {
      if (!response.url().includes("/api/v1/auth-as-guest")) return;
      void response
        .text()
        .then((body) => session.accept(body))
        .catch(() => {
          /* the journey falls back to a cookie refresh */
        });
    });
    return session;
  }

  private accept(body: string) {
    const token = body.trim().replace(/^"|"$/g, "");
    if (token.startsWith("ey")) {
      this.token = token;
      this.issuedAt = Date.now();
    }
  }

  /** A JWT with life left in it, refreshed through the browser's session cookie. */
  async jwt(): Promise<string> {
    const ageSeconds = (Date.now() - this.issuedAt) / 1000;
    if (this.token && ageSeconds < 8 * 60) return this.token;

    const cookies = await this.context.cookies();
    const refresh = cookies.find((c) => c.name === "lucuma-refresh-token");
    if (!refresh) {
      if (this.token) return this.token;
      throw new Error(
        "no guest JWT and no lucuma-refresh-token cookie — did the guest login happen?",
      );
    }

    const response = await fetch(endpoints.ssoRefreshUrl, {
      method: "POST",
      headers: { cookie: `${refresh.name}=${refresh.value}` },
    });
    if (!response.ok) {
      throw new Error(
        `refresh-token returned ${response.status}; the guest session is gone`,
      );
    }
    this.accept(await response.text());
    if (!this.token) throw new Error("refresh-token returned no JWT");
    return this.token;
  }

  client(): OdbClient {
    return new OdbClient(() => this.jwt());
  }
}

/**
 * Poll until `check` returns a value, for assertions on results a background worker
 * produces. `obscalc` computes execution digests asynchronously, so the calculated-results
 * assertion is eventually-consistent by nature (spec §5 scenario 3).
 */
export async function eventually<T>(
  description: string,
  check: () => Promise<T | undefined>,
  { timeoutMs = 120_000, intervalMs = 3_000 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value !== undefined && value !== null) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${description}` +
          (lastError ? `; last error: ${lastError}` : ""),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
