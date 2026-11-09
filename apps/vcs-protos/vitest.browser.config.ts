import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/** Browser rungs: the same conformance module in a real Chromium page and Dedicated Worker. */
export default defineConfig({
  test: {
    name: "browser",
    include: ["[0-9][0-9]-*/tests/**/*.browser.test.ts"],
    globalSetup: ["05-runtime-matrix/tests/global-setup.browser.ts"],
    testTimeout: 120_000,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: { args: ["--no-sandbox"] } }),
      instances: [{ browser: "chromium" }],
    },
  },
});
