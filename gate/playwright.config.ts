import { defineConfig } from "@playwright/test";

// One long serial test: a brand-new user walking the whole first run. Every
// area is a recorded check (out/results.json); the test fails if any failed.
export default defineConfig({
  testDir: "tests",
  timeout: 75 * 60_000,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "out/playwright-report.json" }]],
  outputDir: "out/test-output",
});
