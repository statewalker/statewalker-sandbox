import { defineConfig } from "vitest/config";
import { alias } from "./aliases.js";
import { headless } from "./headless-guard.js";

export default defineConfig({
  plugins: [headless("node")],
  resolve: { alias },
  test: {
    name: "node",
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
