import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { aliasFor, type SignalsImpl } from "./aliases.js";

/**
 * The browser rungs (B5-B6) run against a real Chromium: `useSyncExternalStore`
 * and React's own render/commit loop are the thing under test, and a fake DOM
 * cannot be trusted to reproduce React's getSnapshot-loop guard (spec §4.3).
 * B5 runs once per signals implementation; B6 boots the real app, once.
 */
const browserProject = (signals: SignalsImpl, include: string[]) => ({
  plugins: [react()],
  resolve: { alias: aliasFor(signals) },
  test: {
    name: `browser:${signals}`,
    include,
    provide: { signals },
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: { args: ["--no-sandbox"] } }),
      instances: [{ browser: "chromium" as const }],
    },
  },
});

export default defineConfig({
  test: {
    projects: [
      browserProject("alien", ["B5-*/tests/**/*.test.tsx", "B6-*/tests/**/*.test.tsx"]),
      browserProject("preact", ["B5-*/tests/**/*.test.tsx"]),
    ],
  },
});
