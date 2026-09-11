import { defineConfig } from "vitest/config";
import { alias } from "./aliases.js";

export default defineConfig({
  resolve: { alias },
  test: {
    name: "node",
    environment: "node",
    include: ["*/tests/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "B5-*/tests/**/*.test.tsx",
      "B6-*/tests/**/*.test.tsx",
    ],
  },
});
