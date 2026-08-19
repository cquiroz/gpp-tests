#!/usr/bin/env node
/**
 * Write the `environments.conf.json` that points Explore at a test stack (spec §3).
 *
 * Explore picks its backend at runtime by fetching this file and matching the browser host,
 * so serving our own copy in front of the upstream bundle is all it takes to repoint the
 * app. We fetch the bundle's own conf first and overlay only the endpoints, so fields the
 * decoder requires but we do not know about survive (see lib/endpoints.js).
 *
 * Usage: node tools/write-environments-conf.js [output-path]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { mergeEnvironmentsConf, stackEndpoints } from "../lib/endpoints.js";

const DEFAULT_OUTPUT = "stack/.cache/explore/environments.conf.json";

/** @param {string} origin */
async function fetchUpstreamConf(origin) {
  const url = `https://${origin}/environments.conf.json`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const conf = await response.json();
    console.error(`fetched upstream conf from ${url}`);
    return conf;
  } catch (error) {
    // Not fatal: we can still write a conf from scratch. It is worth a loud warning
    // though, because a schema change upstream is exactly what this fetch absorbs.
    console.error(
      `warning: could not fetch ${url} (${error instanceof Error ? error.message : error}); ` +
        `falling back to a generated conf`,
    );
    return undefined;
  }
}

const output = resolve(process.argv[2] ?? DEFAULT_OUTPUT);
const endpoints = stackEndpoints(process.env);
const origin = process.env.EXPLORE_ORIGIN ?? "explore-gemini-dev.web.app";

const conf = mergeEnvironmentsConf(await fetchUpstreamConf(origin), endpoints);

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(conf, null, 2)}\n`, "utf8");

console.error(`wrote ${output}`);
console.error(`  odb  ${endpoints.odbWsUrl}`);
console.error(`  sso  ${endpoints.ssoUrl}`);
console.error(`  itc  ${endpoints.itcUrl}`);
console.error(`  prefs ${endpoints.prefsWsUrl}`);
