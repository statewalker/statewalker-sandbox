import { defineConfig } from "vitest/config";
import { headless } from "./headless-guard.ts";

export default defineConfig({
  plugins: [headless("node")],
  test: {
    name: "node",
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
