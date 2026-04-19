import {
  getHttpServiceConfig,
  newHttpServiceProvider,
  setHttpServiceConfig,
} from "@statewalker/service-http";
import { newRegistry } from "@statewalker/shared-registry";
import { beforeEach, expect, it } from "vitest";
import createHttpService from "../src/index.js";

let context: Record<string, unknown>;

beforeEach(() => {
  // Setup context
  context = {};
});

it("should create and start HTTP server with default context", async () => {
  const port = 6789;
  const httpConfig = getHttpServiceConfig(context);
  const [register, cleanup] = newRegistry();
  try {
    setHttpServiceConfig(context, { ...httpConfig, port });
    const shutdown = createHttpService(context);
    register(shutdown);

    const [provideService, removeService] = newHttpServiceProvider(context);
    register(removeService);
    provideService({
      method: "GET",
      path: "/test",
      fetch: async () => new Response("Hello there"),
    });
    {
      const response = await fetch(`http://localhost:${port}/test1`);
      expect(response.status).toBe(404);
    }
    {
      const response = await fetch(`http://localhost:${port}/test`);
      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toBe("Hello there");
    }
  } finally {
    await cleanup();
  }
});
