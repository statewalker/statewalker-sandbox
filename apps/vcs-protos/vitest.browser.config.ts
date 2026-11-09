import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/** Browser rungs: the same conformance module in a real Chromium page and Dedicated Worker. */
export default defineConfig({
  // Pre-bundle the browser dependencies so Vite never discovers them mid-run and reloads the page.
  optimizeDeps: {
    include: [
      "pako",
      "@noble/hashes/legacy.js",
      "@noble/hashes/sha2.js",
      "@noble/hashes/blake3.js",
    ],
  },
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
