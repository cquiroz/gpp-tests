import { defineConfig, devices } from "@playwright/test";
import { stackEndpoints } from "./lib/endpoints.js";

const endpoints = stackEndpoints(process.env);

/**
 * Spec §5/§8: one chained guest journey, 1 retry, retried passes reported as "flaky",
 * artifacts on failure only with 30-day retention (retention is set on the CI upload step).
 *
 * TLS: the ephemeral stack fronts everything with Caddy's *internal* CA (spec §3). Chromium
 * on Linux reads its own NSS store rather than the system trust store, so by default we let
 * the browser accept the internal CA via `ignoreHTTPSErrors`. Run `stack/scripts/trust-ca.sh`
 * and set `PW_IGNORE_HTTPS_ERRORS=false` for a strict-TLS run (or when pointing at the
 * real-certs fallback environment).
 */
export default defineConfig({
  testDir: "./tests/e2e",
  // The journey is a single chained test; parallelism would only fight over the one stack.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 1,
  // A cold Explore boot + Flyway-fresh ODB is slow; the journey itself is the long pole.
  timeout: 5 * 60 * 1000,
  expect: { timeout: 30 * 1000 },
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
    ["json", { outputFile: "out/playwright-results.json" }],
  ],
  use: {
    baseURL: endpoints.exploreUrl,
    ignoreHTTPSErrors: process.env.PW_IGNORE_HTTPS_ERRORS !== "false",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 30 * 1000,
    navigationTimeout: 60 * 1000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  outputDir: "test-results",
});
