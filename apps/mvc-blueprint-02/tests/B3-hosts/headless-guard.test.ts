import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { headless } from "../../headless-guard.js";

type Resolve = (source: string, importer?: string) => unknown;

describe("B3 · the headless guard", () => {
  const resolve = headless("browser:dom").resolveId as unknown as Resolve;

  it("refuses the React stack by name and by subpath, naming the importer and the project", () => {
    for (const spec of [
      "react",
      "react-dom/client",
      "@statewalker/ui.view.shadcn",
      "@statewalker/ui.view.shadcn/styles",
    ]) {
      expect(() => resolve(spec, "src/lib/stats/ui/stats-view.ts"), spec).toThrow(
        /was loaded by src\/lib\/stats\/ui\/stats-view\.ts in the browser:dom project/,
      );
    }
  });

  it("leaves everything else to the normal resolver", () => {
    for (const spec of ["@ui/dom", "@sys/ui", "reactive", "preact"])
      expect(resolve(spec, "x.ts"), spec).toBeNull();
  });

  it("is installed on the browser:dom project", () => {
    const config = readFileSync(new URL("../../vitest.browser.config.ts", import.meta.url), "utf8");
    expect(config).toMatch(
      /plugins:\s*\[headless\("browser:dom"\)\][\s\S]{0,120}name:\s*"browser:dom"/,
    );
  });
});
