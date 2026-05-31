import { createOpenAI } from "@ai-sdk/openai";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

interface BootstrapEnv {
  OPENAI_PROXY_PORT?: string;
  LLAMACPP_BASE_URL?: string;
}

interface BootstrapConfig {
  port: number;
  llamacppBaseURL: string;
  modelId: string;
}

export const bootstrap = (env: BootstrapEnv): BootstrapConfig => ({
  port: Number.parseInt(env.OPENAI_PROXY_PORT ?? "8787", 10),
  llamacppBaseURL: env.LLAMACPP_BASE_URL ?? "http://127.0.0.1:8080/v1",
  modelId: "gemma-3-1b",
});

export const buildLlamaCppApp = (config: BootstrapConfig) => {
  const provider = createOpenAI({
    apiKey: "not-needed",
    baseURL: config.llamacppBaseURL,
  });
  return createApp({
    languageModels: {
      [config.modelId]: provider.chat(config.modelId),
    },
  });
};

const main = (): void => {
  const config = bootstrap(process.env);
  const app = buildLlamaCppApp(config);
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`openai-proxy listening on http://127.0.0.1:${info.port}/v1`);
    console.log(`  backed by llama.cpp at ${config.llamacppBaseURL}`);
    console.log(`  model: ${config.modelId}`);
  });
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
