import { describe, expect, it } from "vitest";
import { configureGemini, GEMINI_PROVIDER } from "../../src/lib/configure-gemini.js";

describe("configureGemini", () => {
  it("accepts a non-empty API key without throwing", () => {
    expect(() => configureGemini("AIza-fake-but-shape-valid")).not.toThrow();
  });

  it("rejects empty keys early (don't reach the provider with garbage)", () => {
    expect(() => configureGemini("")).toThrow(/non-empty/i);
  });

  it("exposes the canonical provider name pi-ai expects", () => {
    expect(GEMINI_PROVIDER).toBe("google");
  });
});
