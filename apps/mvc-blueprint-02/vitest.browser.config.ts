import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { alias } from "./aliases.js";
import { headless } from "./headless-guard.js";

// A fresh object per project: vitest expands `instances` in place.
const chromium = () => ({
  enabled: true,
  headless: true,
  provider: playwright({ launchOptions: { args: ["--no-sandbox"] } }),
  instances: [{ browser: "chromium" as const }],
});

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [headless("browser:dom")],
        resolve: { alias },
        test: { name: "browser:dom", include: ["tests/**/*.dom.test.ts"], browser: chromium() },
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: { name: "browser:react", include: ["tests/**/*.test.tsx"], browser: chromium() },
      },
    ],
  },
});
