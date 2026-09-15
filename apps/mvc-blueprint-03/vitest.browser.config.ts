import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { alias } from "./aliases.js";

export default defineConfig({
  plugins: [react()],
  resolve: { alias },
  test: {
    name: "browser:react",
    include: ["tests/**/*.test.tsx"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: { args: ["--no-sandbox"] } }),
      instances: [{ browser: "chromium" }],
    },
  },
});
