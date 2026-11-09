import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const resolve = { conditions: ["source", "import", "module", "default"] };

/**
 * Two projects in one config so `pnpm test <folder>` filters both: Node tests, and the browser
 * rungs (`*.browser.test.ts`) in a real Chromium page and Dedicated Worker.
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve,
        test: {
          name: "node",
          globals: true,
          environment: "node",
          include: ["[0-9][0-9]-*/tests/**/*.test.ts"],
          exclude: ["node_modules", "dist", "coverage", "**/*.browser.test.ts"],
          // --expose-gc: memory tests sample after forced collections.
          execArgv: ["--expose-gc"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        resolve,
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
      },
    ],
  },
});
