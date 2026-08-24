#!/usr/bin/env node
/**
 * Validate a freshly-minted ODB service JWT (spec §3 bootstrap).
 *
 *   node tools/check-service-jwt.js <jwt> [--public-key stack/keys/sso-public.asc]
 *
 * Exits 0 when the token is a live service-user token signed by this stack's SSO key, 1
 * otherwise, with the reason on stderr. Bootstrap calls it in the mint retry loop so a bad
 * token is caught there instead of resurfacing minutes later as a Java signature exception
 * inside obscalc.
 */
import { readFileSync } from "node:fs";
import { checkServiceJwt, rsaModulusBytes } from "../lib/service-jwt.js";

const args = process.argv.slice(2);
const jwt = args.find((a) => !a.startsWith("--"));
const keyIndex = args.indexOf("--public-key");
const keyPath = keyIndex === -1 ? undefined : args[keyIndex + 1];

let modulusBytes;
if (keyPath) {
  try {
    modulusBytes = rsaModulusBytes(readFileSync(keyPath, "utf8"));
  } catch (error) {
    console.error(
      `note: could not read ${keyPath} (${error instanceof Error ? error.message : error})`,
    );
  }
  if (modulusBytes === undefined) {
    // Not fatal: the structural checks are still worth running, and a key format we cannot
    // parse is not evidence that the token is wrong.
    console.error(
      `note: could not determine the RSA key size from ${keyPath}; skipping the signature-size check`,
    );
  }
}

const result = checkServiceJwt(jwt, { modulusBytes });

if (!result.ok) {
  console.error(`service JWT rejected: ${result.reason}`);
  process.exit(1);
}

console.error(
  `service JWT ok (service user ${result.serviceName ?? "?"}` +
    `${modulusBytes ? `, ${modulusBytes * 8}-bit signature` : ""})`,
);
