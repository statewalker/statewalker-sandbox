import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  testMatch: "**/*.spec.ts",
  // Two real tabs meeting over a real relay: slower than a unit test and
  // dependent on ICE, so the budget is generous and retries are off — a
  // flake here is a finding, not noise to paper over.
  timeout: 120_000,
  retries: 0,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:4173" },
  webServer: {
    command: "pnpm run build && pnpm run preview",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
