import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { headless } from "../../headless-guard.js";

type Resolve = (source: string, importer?: string) => unknown;

describe("B3 · the headless guard", () => {
  const resolve = headless("node").resolveId as unknown as Resolve;

  it("refuses the React stack by name and by subpath, naming the importer and the project", () => {
    for (const spec of [
      "react",
      "react-dom/client",
      "@statewalker/ui.view.shadcn",
      "@statewalker/ui.view.shadcn/styles",
    ]) {
      expect(() => resolve(spec, "src/lib/todos/list/list.controller.ts"), spec).toThrow(
        /was loaded by src\/lib\/todos\/list\/list\.controller\.ts in the node project/,
      );
    }
  });

  it("leaves everything else to the normal resolver", () => {
    for (const spec of ["@sys/extension-points", "@todos/core", "reactive", "preact"]) {
      expect(resolve(spec, "x.ts"), spec).toBeNull();
    }
  });

  it("is installed on the node project", () => {
    const config = readFileSync(new URL("../../vitest.config.ts", import.meta.url), "utf8");
    expect(config).toMatch(/plugins:\s*\[headless\("node"\)\]/);
  });
});
