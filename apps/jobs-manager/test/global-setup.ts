// Builds dist/ once before the suite (the same tsdown config as `pnpm build`), so `vitest run`
// on its own also checks the bundle; turbo runs `build` before `test` in the pipeline anyway.
import { build } from "tsdown";

export default async function setup() {
  await build({
    config: new URL("../tsdown.config.ts", import.meta.url).pathname,
    logLevel: "warn",
  });
}
