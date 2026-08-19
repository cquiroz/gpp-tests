import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests for the shared pure library only — the Playwright journey and the k6
    // suites need a running stack and are driven by their own runners.
    include: ["lib/**/*.test.js", "tools/**/*.test.js"],
    environment: "node",
  },
});
