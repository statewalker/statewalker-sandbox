import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";

const mockModel = (): LanguageModelV3 => ({
  specificationVersion: "v3",
  provider: "mock",
  modelId: "mock-model",
  supportedUrls: {},
  async doGenerate(_options: LanguageModelV3CallOptions) {
    return {
      content: [{ type: "text" as const, text: "ok" }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: {
        inputTokens: {
          total: 1,
          noCache: 1,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    };
  },
  async doStream() {
    throw new Error("not used");
  },
});

describe("createApp", () => {
  it("exposes /v1/models listing configured language model ids", async () => {
    const app = createApp({
      languageModels: { "gemma-3-1b": mockModel() },
    });
    const res = await app.request("/v1/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      data: Array<{ id: string }>;
    };
    expect(body.object).toBe("list");
    expect(body.data.map((d) => d.id)).toEqual(["gemma-3-1b"]);
  });

  it("404s on /v1/unknown", async () => {
    const app = createApp({
      languageModels: { "gemma-3-1b": mockModel() },
    });
    const res = await app.request("/v1/unknown");
    expect(res.status).toBe(404);
  });
});
