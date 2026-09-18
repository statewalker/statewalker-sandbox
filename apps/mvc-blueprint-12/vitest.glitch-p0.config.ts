import { defineConfig } from "vitest/config";
import { aliasP0 } from "./aliases.js";

/** The glitch test against P0's sources (read-only): `pnpm test:glitch-p0`. */
export default defineConfig({
  resolve: { alias: aliasP0 },
  test: {
    name: "glitch-p0",
    environment: "node",
    include: ["tests/glitch/*.test.ts"],
    env: { GLITCH_TARGET: "P0" },
  },
});
