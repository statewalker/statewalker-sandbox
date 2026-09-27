import { describe, expect, it } from "vitest";
import {
  type ChatSetup,
  createChatSetup,
  type MeshLink,
  type SetupStage,
} from "../src/common/chat-setup.js";
import { type ChatConfig, memoryConfigStore } from "../src/common/core/config.js";

const HUB = "12D3KooWHub";
const EDGE = "http://app.test/peers/";
const SERVICE = `${EDGE}${HUB}/llm/`;

const LLM_DOC = {
  openapi: "3.1.0",
  servers: [{ url: "." }],
  components: {
    securitySchemes: { llmKey: { type: "apiKey", in: "header", name: "x-litellm-api-key" } },
  },
  paths: { "/keys": { post: {} }, "/ui/": { get: { "x-httpeers-entry": "./ui/" } } },
};

/** A fake hub + endpoint: the LLM document, key minting, and model lists that need the right key. */
function fakeFetch(opts: { admin?: boolean; key?: string } = {}) {
  const calls: string[] = [];
  const key = opts.key ?? "sk-1";
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === `${SERVICE}openapi.json`) return Response.json(LLM_DOC);
    if (url === `${SERVICE}keys`) {
      return opts.admin ? Response.json({ key }) : new Response("forbidden", { status: 403 });
    }
    if (url === `${SERVICE}v1/models`) {
      return headers.get("x-litellm-api-key") === `Bearer ${key}`
        ? Response.json({ data: [{ id: "beta" }, { id: "alpha" }] })
        : new Response("bad key", { status: 401 });
    }
    if (url === "https://api.example/v1/models") {
      return headers.get("authorization") === "Bearer custom"
        ? Response.json({ data: [{ id: "gpt-x" }] })
        : new Response("bad key", { status: 401 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function live(opts: { advertise?: boolean; admin?: boolean } = {}): MeshLink {
  return {
    edgeBase: EDGE,
    hubPeerId: HUB,
    meshView: () => ({
      self: "12D3KooWMe",
      members: [{ peerId: "12D3KooWMe", roles: [opts.admin ? "admin" : "member"] }],
      advertisements:
        opts.advertise === false ? [] : [{ peerId: HUB, id: "llm", kind: "openapi-service" }],
    }),
  };
}

function setup(
  fetchImpl: typeof fetch,
  init: { mesh?: ChatConfig | null; custom?: ChatConfig | null } = {},
) {
  return createChatSetup({
    fetchImpl,
    stores: {
      mesh: memoryConfigStore(init.mesh ?? null),
      custom: memoryConfigStore(init.custom ?? null),
    },
    source: { get: () => null, set: () => {} },
    advertWaitMs: 0,
  });
}

async function settle(s: ChatSetup, until: (stage: SetupStage) => boolean): Promise<SetupStage> {
  for (let i = 0; i < 200; i++) {
    if (until(s.state().stage)) return s.state().stage;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`stage stayed ${JSON.stringify(s.state().stage)}`);
}

describe("chat setup: the mesh's LLM", () => {
  it("defaults to the mesh, and waits while there is no live member", async () => {
    const s = setup(fakeFetch().fetchImpl);
    expect(s.state().source).toBe("mesh");
    await s.meshChanged(null);
    expect(s.state().stage).toEqual({ kind: "mesh-offline" });
  });

  it("says so when the hub advertises no LLM", async () => {
    const s = setup(fakeFetch().fetchImpl);
    await s.meshChanged(live({ advertise: false }));
    expect(s.state().stage).toMatchObject({
      kind: "unavailable",
      message: expect.stringMatching(/no LLM/),
    });
  });

  it("asks for a key, offering to request one", async () => {
    const s = setup(fakeFetch().fetchImpl);
    await s.meshChanged(live());
    expect(s.state().stage).toMatchObject({ kind: "key", canRequest: true });
  });

  it("goes to chat once a pasted key lists the models", async () => {
    const s = setup(fakeFetch().fetchImpl);
    await s.meshChanged(live());
    await s.submitKey("sk-1");
    const stage = await settle(s, (st) => st.kind === "ready");
    expect(stage).toMatchObject({
      kind: "ready",
      config: {
        baseUrl: `${SERVICE}v1`,
        apiKey: "sk-1",
        apiKeyHeader: "x-litellm-api-key",
        models: ["alpha", "beta"],
        defaultModel: "alpha",
      },
      dashboardUrl: `${SERVICE}ui/`,
    });
  });

  it("stays on the key step with the reason when the key is refused", async () => {
    const s = setup(fakeFetch().fetchImpl);
    await s.meshChanged(live());
    await s.submitKey("sk-wrong");
    expect(s.state().stage).toMatchObject({ kind: "key", error: expect.stringMatching(/401/) });
  });

  it("requests a key as an admin", async () => {
    const s = setup(fakeFetch({ admin: true }).fetchImpl);
    await s.meshChanged(live({ admin: true }));
    await s.requestKey();
    expect(await settle(s, (st) => st.kind === "ready")).toMatchObject({
      config: { apiKey: "sk-1" },
    });
  });

  it("reports a refused key request (not an admin)", async () => {
    const s = setup(fakeFetch({ admin: false }).fetchImpl);
    await s.meshChanged(live());
    await s.requestKey();
    expect(s.state().stage).toMatchObject({ kind: "key", error: expect.stringMatching(/403/) });
  });

  it("resumes with a stored key without asking again", async () => {
    const stored: ChatConfig = {
      baseUrl: `${SERVICE}v1`,
      apiKey: "sk-1",
      apiKeyHeader: "x-litellm-api-key",
      models: [],
    };
    const s = setup(fakeFetch().fetchImpl, { mesh: stored });
    await s.meshChanged(live());
    expect(await settle(s, (st) => st.kind === "ready")).toMatchObject({
      config: { defaultModel: "alpha" },
    });
  });

  it("goes back to waiting when the member stops", async () => {
    const s = setup(fakeFetch().fetchImpl);
    await s.meshChanged(live());
    await s.meshChanged(null);
    expect(s.state().stage).toEqual({ kind: "mesh-offline" });
  });
});

describe("chat setup: a custom endpoint", () => {
  it("asks for the endpoint, then lists its models", async () => {
    const s = setup(fakeFetch().fetchImpl);
    await s.setSource("custom");
    expect(s.state().stage).toMatchObject({ kind: "endpoint" });
    await s.submitEndpoint({ baseUrl: "https://api.example/v1/", apiKey: "custom" });
    expect(await settle(s, (st) => st.kind === "ready")).toMatchObject({
      config: { baseUrl: "https://api.example/v1", models: ["gpt-x"], defaultModel: "gpt-x" },
    });
  });

  it("keeps the endpoint form, with the error, when the models cannot be listed", async () => {
    const s = setup(fakeFetch().fetchImpl);
    await s.setSource("custom");
    await s.submitEndpoint({ baseUrl: "https://api.example/v1", apiKey: "nope" });
    expect(s.state().stage).toMatchObject({
      kind: "endpoint",
      error: expect.stringMatching(/401/),
    });
  });

  it("does not touch the mesh while the custom endpoint is chosen", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const s = setup(fetchImpl);
    await s.setSource("custom");
    await s.meshChanged(live());
    expect(calls.filter((c) => c.includes("/peers/"))).toEqual([]);
  });
});

describe("chat setup: models", () => {
  it("switches the default model and stores it", async () => {
    const s = setup(fakeFetch().fetchImpl);
    await s.setSource("custom");
    await s.submitEndpoint({ baseUrl: "https://api.example/v1", apiKey: "custom" });
    await settle(s, (st) => st.kind === "ready");
    await s.chooseModel("gpt-x");
    expect(s.config()?.defaultModel).toBe("gpt-x");
  });

  it("tells subscribers about every change", async () => {
    const s = setup(fakeFetch().fetchImpl);
    let calls = 0;
    const off = s.subscribe(() => calls++);
    await s.meshChanged(live());
    off();
    expect(calls).toBeGreaterThan(0);
  });
});
