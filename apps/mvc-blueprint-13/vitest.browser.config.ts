import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";
import { SOLID } from "./vite.config.js";

export default defineConfig({
  plugins: [react({ exclude: SOLID }), solid({ include: SOLID })],
  test: {
    name: "browser",
    // vite-plugin-solid would default this to jsdom; the browser provider ignores it anyway.
    environment: "node",
    include: ["tests/**/*.test.tsx"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: { args: ["--no-sandbox"] } }),
      instances: [{ browser: "chromium" }],
    },
  },
});
