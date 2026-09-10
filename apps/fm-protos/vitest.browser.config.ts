import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { alias } from "./vitest.config.js";

/**
 * D2b — the browser rungs run against a real Chromium.
 *
 * Everything up to here was Node-testable by design and stays that way: this
 * config exists only for what a browser is genuinely required to prove — OPFS,
 * the File System Access API, and how a windowed grid behaves at 100k rows.
 */
export default defineConfig({
  plugins: [react()],
  resolve: { alias },
  test: {
    name: "browser",
    /*
     * Two suites deliberately provoke the grid's own guard — D2c strategy B at
     * 100k, and D2d's chain with a missing `min-height: 0`. React reports the
     * refusal as an unhandled error, which would otherwise mask the run.
     * Suppressed by message only: an accidental occurrence still fails, because
     * every windowing assertion bounds the row count from BOTH sides.
     */
    onUnhandledError: (error) => !/attempted to render too many rows/.test(String(error?.message)),
    include: ["D2b-browser-prototypes/tests/**/*.test.ts", "D2b-browser-prototypes/tests/**/*.test.tsx"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: { args: ["--no-sandbox"] } }),
      instances: [{ browser: "chromium" }],
    },
  },
});
