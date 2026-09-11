import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { alias } from "./aliases.js";

/**
 * The browser rungs (B5-B6) run against a real Chromium: `useSyncExternalStore`
 * and React's own render/commit loop are the thing under test, and a fake DOM
 * cannot be trusted to reproduce React's getSnapshot-loop guard (spec §4.3).
 */
export default defineConfig({
  plugins: [react()],
  resolve: { alias },
  test: {
    name: "browser",
    include: ["B5-*/tests/**/*.test.tsx", "B6-*/tests/**/*.test.tsx"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: { args: ["--no-sandbox"] } }),
      instances: [{ browser: "chromium" }],
    },
  },
});
