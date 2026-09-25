import { defineConfig } from "vitest/config";

// happy-dom is the default because most rungs render into a DOM. The rungs that
// do not (04 manifest generation, 08 biscuit, Z schema derivation) are unaffected
// by a document being present, so one environment for the whole app is simpler
// than a per-rung override.
//
// 08 runs as its own project, with retries. biscuit-wasm spuriously reports
// `RunLimit: Timeout` under CPU load, even for evaluations that take well under
// a millisecond. A retry cannot turn a real deny into an allow, because the
// evaluation is pure. The test file is kept verbatim (see its header), so the
// retry lives here and not in the test.
const exclude = ["**/node_modules/**", "**/dist/**"];

export default defineConfig({
  test: {
    environment: "happy-dom",
    projects: [
      {
        extends: true,
        test: {
          name: "rungs",
          include: ["**/tests/**/*.test.ts"],
          exclude: [...exclude, "08-biscuit-enablement/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "08-biscuit-enablement",
          include: ["08-biscuit-enablement/tests/**/*.test.ts"],
          exclude,
          retry: 2,
        },
      },
    ],
  },
});
