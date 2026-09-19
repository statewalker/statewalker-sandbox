import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";
import { alias, SOLID_TSX } from "./aliases.js";

export default defineConfig({
  plugins: [solid({ include: SOLID_TSX }), react({ exclude: SOLID_TSX })],
  resolve: { alias },
  // Pre-bundle up front: a mid-run optimisation reloads the page under a running test.
  optimizeDeps: {
    include: [
      "@json-render/core",
      "@json-render/react",
      "@json-render/solid",
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "zod",
    ],
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
