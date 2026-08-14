import { type ChildProcess, spawn } from "node:child_process";
import { type ServerType, serve } from "@hono/node-server";
import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrap, buildLlamaCppApp } from "../../src/main.js";

const E2E_ON = process.env.OPENAI_COMPAT_E2E === "1";
const describeIf = E2E_ON ? describe : describe.skip;

const llamaBin = process.env.LLAMACPP_BIN ?? "llama-server";
const llamaModel = process.env.LLAMACPP_MODEL ?? "";
const llamaPort = Number.parseInt(process.env.LLAMACPP_PORT ?? "18080", 10);
const llamaBaseURL = `http://127.0.0.1:${llamaPort}/v1`;

const waitForReady = async (url: string, timeoutMs = 90_000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 401 || res.status === 404) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
};

describeIf("integration: llama.cpp + Gemma via openai-proxy", () => {
  let llama: ChildProcess | undefined;
  let server: ServerType | undefined;
  let proxyPort: number;
  let client: OpenAI;

  beforeAll(async () => {
    if (!llamaModel) {
      throw new Error(
        "Set LLAMACPP_MODEL to the path of a GGUF file (e.g. gemma-3-1b-it-q4_K_M.gguf).",
      );
    }
    llama = spawn(
      llamaBin,
      ["-m", llamaModel, "--port", String(llamaPort), "--host", "127.0.0.1"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    llama.stderr?.on("data", () => {});
    llama.stdout?.on("data", () => {});
    await waitForReady(`${llamaBaseURL}/models`);

    const config = bootstrap({
      OPENAI_PROXY_PORT: "0",
      LLAMACPP_BASE_URL: llamaBaseURL,
    });
    const app = buildLlamaCppApp(config);
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        proxyPort = info.port;
        resolve();
      });
    });

    client = new OpenAI({
      apiKey: "any",
      baseURL: `http://127.0.0.1:${proxyPort}/v1`,
    });
  }, 120_000);

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server?.close(() => r()));
    if (llama) llama.kill();
  });

  it("models list contains gemma-3-1b", async () => {
    const list = await client.models.list();
    expect(list.data.map((m) => m.id)).toContain("gemma-3-1b");
  }, 30_000);

  it("non-streaming chat completion returns non-empty content", async () => {
    const res = await client.chat.completions.create({
      model: "gemma-3-1b",
      messages: [{ role: "user", content: "Say hello in one word." }],
      max_tokens: 32,
    });
    const content = res.choices[0]?.message.content;
    expect(typeof content).toBe("string");
    expect((content ?? "").length).toBeGreaterThan(0);
  }, 60_000);

  it("streaming chat completion accumulates non-empty content", async () => {
    const stream = await client.chat.completions.create({
      model: "gemma-3-1b",
      messages: [{ role: "user", content: "Count: 1 2 3." }],
      stream: true,
      max_tokens: 32,
    });
    let text = "";
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta.content;
      if (typeof delta === "string") text += delta;
    }
    expect(text.length).toBeGreaterThan(0);
  }, 60_000);
});
