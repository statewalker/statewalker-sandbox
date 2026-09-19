import { playwright } from "@vitest/browser-playwright";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";
import { alias } from "./aliases.js";

export default defineConfig({
  plugins: [solid()],
  resolve: { alias },
  test: {
    name: "browser",
    // vite-plugin-solid would default this to jsdom; the browser provider ignores it anyway.
    environment: "node",
    include: ["tests/e2e/**/*.test.ts"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: { args: ["--no-sandbox"] } }),
      instances: [{ browser: "chromium" }],
    },
  },
});
