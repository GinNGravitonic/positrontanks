import { defineConfig, devices } from "@playwright/test";

// The web client's smoke test (docs/spec/frontend.md section 9). It starts
// its own server, so `pnpm build` must have built the server and the client.
export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: "list",
  outputDir: "../../../node_modules/.cache/playwright",
  use: { ...devices["Desktop Chrome"], trace: "retain-on-failure" },
});
