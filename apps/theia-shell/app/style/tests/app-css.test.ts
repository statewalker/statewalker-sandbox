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
    expect(css).toContain("body.shadcn-ui.theia-light {");
    expect(css).toContain("body.shadcn-ui.theia-dark {");
    expect(css).toContain("body.shadcn-ui .lm-Menu {");
    expect(css).toContain("body.shadcn-ui .lm-Widget.dialogOverlay .dialogBlock {");
  });

  it("touches Theia's own widgets only under the shadcn/ui style", () => {
    // Rules on Theia's classes (lm-*, theia-*, dialog*) must start with body.shadcn-ui.
    const selectors = [...css.matchAll(/^([^@\s{}][^{}]*)\{/gm)].map((m) => m[1]);
    const theia = selectors.filter((s) =>
      /\.(lm-|theia-button|theia-input|theia-notification|dialog)/.test(s),
    );
    expect(theia.length).toBeGreaterThan(10);
    for (const selector of theia) {
      for (const part of selector.split(",")) expect(part.trim()).toMatch(/^body\.shadcn-ui\b/);
    }
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
