import { svelte } from "@sveltejs/vite-plugin-svelte";
import { playwright } from "@vitest/browser-playwright";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";
import { alias } from "./aliases.js";

export default defineConfig({
  plugins: [svelte(), solid()],
  resolve: { alias },
  // Vue's esm-bundler build expects these compile-time flags.
  define: {
    __VUE_OPTIONS_API__: "true",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
  },
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
