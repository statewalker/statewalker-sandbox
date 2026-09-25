import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The compiled stylesheet: run `pnpm build` first.
const css = readFileSync(new URL("../lib/app.css", import.meta.url), "utf8");

describe("the compiled app stylesheet", () => {
  it("has no preflight", () => {
    expect(css).not.toContain("text-size-adjust");
    expect(css).not.toContain("@layer base {\n  *,");
  });

  it("keeps utilities out of cascade layers, so they beat Theia's unlayered CSS", () => {
    expect(css).not.toContain("@layer utilities");
    expect(css).toMatch(/\n\.prose \{/);
  });

  it("carries the shadcn tokens for both theme types and the Theia alignment", () => {
    expect(css).toContain("body.theia-light {");
    expect(css).toContain("body.theia-dark {");
    expect(css).toContain("body .lm-Menu {");
    expect(css).toContain("body .lm-Widget.dialogOverlay .dialogBlock {");
  });

  it("never generates utilities named like Theia's or Monaco's own classes", () => {
    expect(css).not.toMatch(/^\.container\b/m);
    expect(css).not.toMatch(/^\.fixed\b/m);
  });

  it("generates the utilities the shadcn components use", () => {
    expect(css).toContain(".hover\\:bg-accent");
    expect(css).toContain(".bg-primary");
  });
});
