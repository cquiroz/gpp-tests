// The standard-user pool for k6 (ticket 017, CONTEXT.md "Standard-user pool"): fabricated
// PIs and staff, one identity per VU, so the people submitting proposals, the people holding
// Explore tabs and the people operating Observe's browser are distinct users — and never
// shared between VUs.
//
// `stack/scripts/create-standard-users.sh` writes the pool next to the two browser personas,
// as JSON (`stack/.env.standard-users.json`): `{cookieDomain, pi: [...], staff: [...]}` with
// `{userId, roleId, refreshToken}` per user. The refresh token is the SSO session id, and
// logging in is one refresh-token call (`auth.js`). Reading the file is an init-context
// `open()`, shared across VUs through a SharedArray; the AWS wizard copies the file to the
// generator beside `.env.standard-users`.
import { fail } from "k6";
import { SharedArray } from "k6/data";
import { loginWithRefreshToken } from "./auth.js";

/** Where the pool is; relative to this module (k6 resolves `open()` that way). */
const POOL_FILE = __ENV.STANDARD_USERS_POOL || "../../stack/.env.standard-users.json";

/** @typedef {{userId: string, roleId: string, refreshToken: string}} PoolUser */
/** @typedef {"pi" | "staff"} PoolKind */

/**
 * @param {PoolKind} kind
 * @returns {PoolUser[]}
 */
function readPool(kind) {
  try {
    const parsed = JSON.parse(open(POOL_FILE));
    return Array.isArray(parsed[kind]) ? parsed[kind] : [];
  } catch (_error) {
    // No pool: the file is written by the user script at bootstrap, so this is a stack that
    // never ran it (or a generator the wizard did not copy it to). Callers decide whether
    // that is fatal — the subscriber fixtures fall back to the browser personas.
    return [];
  }
}

const POOL = {
  pi: new SharedArray("standard-user pool: pi", () => readPool("pi")),
  staff: new SharedArray("standard-user pool: staff", () => readPool("staff")),
};

/**
 * How many identities of a kind the pool holds; zero when there is no pool.
 * @param {PoolKind} kind
 */
export function poolSize(kind) {
  return POOL[kind].length;
}

/**
 * The pool user at `index` (0-based). An index past the end wraps around — and says so once
 * per VU, because from then on two VUs share an identity, which the model forbids and a
 * bigger `POOL_PI_COUNT` / `POOL_STAFF_COUNT` fixes.
 *
 * @param {PoolKind} kind
 * @param {number} index
 * @returns {PoolUser | undefined} undefined when there is no pool of that kind
 */
export function poolUser(kind, index) {
  if (!Number.isInteger(index) || index < 0) {
    // A fallback here would quietly hand every VU the same browser persona (it did, before
    // this check: k6 has no `exec.vu.idInScenario`, and NaN indexed nothing).
    fail(`standard-user pool index must be a non-negative integer, got ${index}`);
  }
  const size = poolSize(kind);
  if (size === 0) return undefined;
  if (index >= size && !warnedWrap[kind]) {
    warnedWrap[kind] = true;
    console.warn(
      `standard-user pool has ${size} ${kind} identities but VU index ${index} was asked for; ` +
        `wrapping around, so identities are now shared between VUs — raise POOL_${kind.toUpperCase()}_COUNT`,
    );
  }
  return POOL[kind][index % size];
}

/** @type {Record<string, boolean>} */
const warnedWrap = {};

/**
 * Log in as the pool user at `index`.
 *
 * @param {PoolKind} kind
 * @param {number} index 0-based. A VU passes `exec.vu.idInTest - 1` (unique across the whole
 *   run, so no two VUs share an identity even when several scripts are composed into one
 *   run, ticket 018) plus any offset its script reserves; the pool just has to be at least as
 *   large as the run's VU count, and `POOL_PI_COUNT` makes it so.
 * @returns {import("./auth.js").Session | undefined} undefined when there is no pool
 */
export function loginAsPoolUser(kind, index) {
  const user = poolUser(kind, index);
  if (!user) return undefined;
  return loginWithRefreshToken(user.refreshToken, `${kind} #${index} (${user.userId})`);
}
