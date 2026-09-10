import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const root = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The three source roots are resolved by alias, not by pnpm: the ladder is one
// app package, and the boundary between `@fm/core`, `@fm/app` and `@fm/ui` is
// enforced by `test/boundaries.test.ts` instead. The same three entries exist in
// `tsconfig.json` under `paths` — if the two ever disagree, `vitest run` and
// `tsc --noEmit` disagree with them, which is worse than either being wrong.
//
// `fm-adapters` is a FOURTH source root (C0.5) and deliberately has NO alias:
// it is imported by relative path only, from its own tests. An alias would make
// it importable from `fm-core`, and the one thing this root exists to keep out
// of `fm-core` is the browser globals in it. See `test/boundaries-adapters.test.ts`.
const alias = {
  "@fm/core": root("./src/core/index.ts"),
  "@fm/app": root("./src/app/index.ts"),
  "@fm/ui": root("./src/ui/index.ts"),
};

/**
 * TWO PROJECTS, ONE `pnpm test`.
 *
 * C0.5 runs the core suites against real adapters, and two of the three live in
 * a browser. `apps/httpeers-stack` drives Playwright from inside Vitest for the
 * same reason this config does it differently: that app needs two real pages
 * talking over a real relay, so its assertions have to sit outside the browser.
 * Here the subject is a `FilesApi` — nothing but storage — so the suite itself
 * can run INSIDE the page, against the real Origin Private File System, with
 * ordinary `expect`. That matters more than the convention: it is what lets the
 * ported suite be ONE file shared by all three adapters (`fm-adapters/test/
 * support/core-suite.ts`) rather than a browser transcription of a Node suite.
 * A transcription is exactly where a weakened assertion would hide.
 *
 * `apps/httpeers-shell-protos` uses happy-dom; that is the wrong tool here by
 * construction. happy-dom has no OPFS and no File System Access API, so a suite
 * under it would be testing a mock of the thing this unit exists to stop
 * mocking.
 */
export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "node",
          include: ["test/**/*.test.ts", "fm-*/test/**/*.test.ts"],
          // `*.browser.test.ts` is the opfs project's. The boundary greps and
          // the node-adapter suites need `node:fs`, so they stay here.
          exclude: ["**/node_modules/**", "**/dist/**", "**/*.browser.test.ts"],
        },
      },
      {
        resolve: { alias },
        // Pre-bundled explicitly. Discovered lazily, Vite optimises them
        // mid-run and reloads the page — and vitest says outright that a reload
        // "may cause tests to fail, lead to flaky behaviour or duplicated test
        // runs". A suite whose result could be a duplicated run is not evidence.
        optimizeDeps: {
          include: [
            "@statewalker/shared-baseclass",
            "@statewalker/shared-commands",
            "@statewalker/webrun-files",
            "@statewalker/webrun-files-browser",
            "@statewalker/webrun-files-mem",
            "zod",
          ],
        },
        test: {
          name: "opfs",
          include: ["fm-adapters/test/**/*.browser.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
            screenshotFailures: false,
          },
        },
      },
    ],
  },
});
