import { describe, expect, it } from "vitest";
import {
  configureGemini,
  createGeminiProvider,
  GEMINI_PROVIDER,
} from "../../src/lib/configure-gemini.js";

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

describe("createGeminiProvider", () => {
  it("registers under the built-in google id and keeps the catalog's default model", () => {
    const provider = createGeminiProvider("AIza-fake");
    expect(provider.id).toBe("google");
    expect(provider.getModels().map((m) => m.id)).toContain("gemini-2.5-flash");
  });

  it("resolves the supplied key instead of reading process.env", async () => {
    const provider = createGeminiProvider("AIza-from-secrets");
    const resolved = await provider.auth.apiKey?.resolve({
      ctx: { env: async () => undefined, fileExists: async () => false },
      signal: new AbortController().signal,
    });
    expect(resolved?.auth.apiKey).toBe("AIza-from-secrets");
  });
});
