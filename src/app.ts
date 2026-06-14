import { createOpenAICompat, type Init } from "@statewalker/ai-openai-compat";
import { Hono } from "hono";

export const createApp = (init: Init): Hono => {
  const handler = createOpenAICompat(init);
  const app = new Hono();
  app.all("/v1/*", async (c) => handler(c.req.raw));
  return app;
};
