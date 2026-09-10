import { defineConfig } from "vitest/config";

// The unit suites MESH-2 added. They are deliberately separate from
// `tests/node-verify.mjs`, which is the adopted integration harness and runs as
// a plain Node script (`pnpm run verify:node`) exactly as it was exported —
// vitest never collects it, so it cannot be quietly reshaped into a vitest test.
//
// `environment: "node"` even though the code under test is isomorphic: every
// browser-only path here goes through a transport the caller supplies, so there
// is nothing a DOM would add except a second way for a mock to be wrong.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist-node/**", "**/dist-web/**"],
  },
});
