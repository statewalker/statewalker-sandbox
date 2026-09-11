import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { alias, aliasFor, type SignalsImpl } from "./aliases.js";

/**
 * The browser rungs (B5-B6) run against a real Chromium: `useSyncExternalStore`
 * and React's own render/commit loop are the thing under test, and a fake DOM
 * cannot be trusted to reproduce React's getSnapshot-loop guard (spec §4.3).
 */
// A fresh object per project: vitest expands `instances` in place, and a
// shared reference across projects produced duplicate-name collisions.
const chromium = () => ({
  enabled: true,
  headless: true,
  provider: playwright({ launchOptions: { args: ["--no-sandbox"] } }),
  instances: [{ browser: "chromium" as const }],
});

/**
 * B5 runs once per signals implementation, pinned directly with `aliasFor` —
 * that is the point of running it twice: proving the whole React binding
 * behaves the same on both libraries. `signals-binding.test.tsx` (the B5
 * canary) checks `inject("signals")` against what `@todo/signals` resolved
 * to, which is why `provide` is here.
 */
const b5Project = (signals: SignalsImpl) => ({
  plugins: [react()],
  resolve: { alias: aliasFor(signals) },
  test: {
    name: `browser:${signals}`,
    include: ["B5-*/tests/**/*.test.tsx"],
    provide: { signals },
    browser: chromium(),
  },
});

/**
 * B6 boots the real app and its build config, so it resolves `@todo/signals`
 * exactly as the build does — through the swap point (`alias`, i.e.
 * `deps.ts`), never pinned to a library directly. Spec §4.7: "B6 runs once,
 * on the default."
 */
const b6Project = () => ({
  plugins: [react()],
  resolve: { alias },
  test: {
    name: "browser:app",
    include: ["B6-*/tests/**/*.test.tsx"],
    browser: chromium(),
  },
});

export default defineConfig({
  test: {
    projects: [b5Project("alien"), b5Project("preact"), b6Project()],
  },
});
