import { defineConfig } from "vitest/config";
import { alias } from "./aliases.js";

/**
 * P3: the whole node suite runs on mechanism A (the P0 baseline); every suite that drives the
 * application (commits, dispose, late, standalone, removal) runs again on B and C.
 */
const APP_SUITES = [
  "tests/commits/**/*.test.ts",
  "tests/dispose/**/*.test.ts",
  "tests/late/**/*.test.ts",
  "tests/standalone/**/*.test.ts",
  "tests/removal/**/*.test.ts",
];
const exclude = ["**/node_modules/**", "**/dist/**"];

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "node-A",
          environment: "node",
          include: ["tests/**/*.test.ts"],
          exclude,
          env: { COMMIT_MECHANISM: "A" },
        },
      },
      ...(["B", "C"] as const).map((m) => ({
        resolve: { alias },
        test: {
          name: `node-${m}`,
          environment: "node",
          include: APP_SUITES,
          exclude,
          env: { COMMIT_MECHANISM: m },
        },
      })),
    ],
  },
});
