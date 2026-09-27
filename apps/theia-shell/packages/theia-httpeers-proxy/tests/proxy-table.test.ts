import { MESH_TOKEN_HEADER } from "@statewalker/httpeers-core";
import { MARKER } from "@statewalker/webrun-http-proxy";
import { describe, expect, it } from "vitest";
import { createProxyTable, underMount, validateRoute } from "../src/common/proxy-table";
import type { RouteStore, StoredRoute } from "../src/common/route-store";

function memoryStore(initial?: StoredRoute[]): RouteStore & { saved: StoredRoute[][] } {
  let routes = initial;
  const saved: StoredRoute[][] = [];
  return {
    saved,
    async load() {
      return routes == null ? undefined : structuredClone(routes);
    },
    async save(next) {
      saved.push(structuredClone(next));
      routes = structuredClone(next);
    },
  };
}

function upstreamEcho() {
  const seen: Request[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const request = input as Request;
    seen.push(request);
    return Response.json({ url: request.url, key: request.headers.get("x-api-key") });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

describe("validateRoute", () => {
  it("accepts a slash-prefixed path and an http(s) upstream", () => {
    expect(validateRoute("/api", "https://api.example/v1")).toBeUndefined();
    expect(validateRoute("/a/b-c", "http://127.0.0.1:8080")).toBeUndefined();
  });

  it("refuses anything else, saying why", () => {
    expect(validateRoute("api", "https://x.example")).toMatch(/prefix/);
    expect(validateRoute("/api/", "https://x.example")).toMatch(/prefix/);
    expect(validateRoute("/", "https://x.example")).toMatch(/prefix/);
    expect(validateRoute("/api", "ftp://x.example")).toMatch(/http/);
    expect(validateRoute("/api", "not a url")).toMatch(/URL/);
  });
});

describe("createProxyTable", () => {
  it("starts empty and lists nothing", async () => {
    const table = createProxyTable({ store: memoryStore() });
    await table.load();
    expect(table.routes()).toEqual([]);
    const listing = await table.handle(new Request("http://proxy.local/"));
    expect(await listing.json()).toEqual({ routes: [] });
  });

  it("forwards under a prefix, on segment boundaries only", async () => {
    const { seen, fetchImpl } = upstreamEcho();
    const table = createProxyTable({ store: memoryStore(), fetchImpl });
    await table.add({ prefix: "/open", upstream: "https://up.example/base" });

    const ok = await table.handle(new Request("http://proxy.local/open/v1/models?x=1"));
    expect(ok.status).toBe(200);
    expect(seen.at(-1)?.url).toBe("https://up.example/base/v1/models?x=1");

    const other = await table.handle(new Request("http://proxy.local/openai/v1"));
    expect(other.status).toBe(404);
    expect(other.headers.get(MARKER)).toBe("no-route");
  });

  it("never sends the mesh token to the outside origin", async () => {
    const { seen, fetchImpl } = upstreamEcho();
    const table = createProxyTable({ store: memoryStore(), fetchImpl });
    await table.add({ prefix: "/api", upstream: "https://up.example" });
    await table.handle(
      new Request("http://proxy.local/api/x", { headers: { [MESH_TOKEN_HEADER]: "T" } }),
    );
    expect(seen.at(-1)?.headers.has(MESH_TOKEN_HEADER)).toBe(false);
  });

  it("persists the credential header's name, keeps its value in memory, and applies it", async () => {
    const store = memoryStore();
    const { fetchImpl } = upstreamEcho();
    const table = createProxyTable({ store, fetchImpl });
    await table.add({
      prefix: "/api",
      upstream: "https://up.example",
      secretHeader: "x-api-key",
      secretValue: "s3cret",
    });

    expect(JSON.stringify(store.saved)).not.toContain("s3cret");
    expect(table.routes()).toEqual([
      {
        prefix: "/api",
        upstream: "https://up.example",
        describe: "/api",
        secretHeader: "x-api-key",
      },
    ]);
    expect(table.hasSecret("/api")).toBe(true);
    const res = await table.handle(new Request("http://proxy.local/api/x"));
    expect((await res.json()).key).toBe("s3cret");

    // A new table over the same store: the route is back, the value is not.
    const reloaded = createProxyTable({ store, fetchImpl });
    await reloaded.load();
    expect(reloaded.routes()).toHaveLength(1);
    expect(reloaded.hasSecret("/api")).toBe(false);
  });

  it("replaces a route with the same prefix, and removes one", async () => {
    const table = createProxyTable({ store: memoryStore() });
    await table.add({ prefix: "/api", upstream: "https://a.example" });
    await table.add({ prefix: "/api", upstream: "https://b.example" });
    expect(table.routes().map((r) => r.upstream)).toEqual(["https://b.example"]);
    await table.remove("/api");
    expect(table.routes()).toEqual([]);
  });

  it("refuses an invalid route without saving it", async () => {
    const store = memoryStore();
    const table = createProxyTable({ store });
    await expect(table.add({ prefix: "api", upstream: "https://a.example" })).rejects.toThrow(
      /prefix/,
    );
    expect(store.saved).toEqual([]);
  });

  it("tells listeners when the table changes", async () => {
    const table = createProxyTable({ store: memoryStore() });
    let calls = 0;
    const off = table.onChange(() => calls++);
    await table.add({ prefix: "/api", upstream: "https://a.example" });
    await table.remove("/api");
    off();
    await table.add({ prefix: "/api", upstream: "https://a.example" });
    expect(calls).toBe(2);
  });
});

describe("underMount", () => {
  it("re-roots a mesh request below the mount, keeping the query, method and body", async () => {
    const inbound = new Request("http://peer.local/proxy/out/hello?x=1", {
      method: "POST",
      body: "ping",
    });
    const relative = await underMount("/proxy", inbound);
    expect(relative.url).toBe("http://peer.local/out/hello?x=1");
    expect(relative.method).toBe("POST");
    expect(await relative.text()).toBe("ping");
  });

  it("maps the mount itself to the listing", async () => {
    expect((await underMount("/proxy", new Request("http://peer.local/proxy"))).url).toBe(
      "http://peer.local/",
    );
    expect((await underMount("/proxy", new Request("http://peer.local/proxy/"))).url).toBe(
      "http://peer.local/",
    );
  });

  it("serves a peer's call end to end: the listing and a forwarded route", async () => {
    const { seen, fetchImpl } = upstreamEcho();
    const table = createProxyTable({ store: memoryStore(), fetchImpl });
    await table.add({ prefix: "/out", upstream: "https://up.example" });
    const listing = await table.handle(
      await underMount("/proxy", new Request("http://peer.local/proxy")),
    );
    expect(await listing.json()).toEqual({ routes: [{ prefix: "/out", upstream: "/out" }] });
    const forwarded = await table.handle(
      await underMount("/proxy", new Request("http://peer.local/proxy/out/hi")),
    );
    expect(forwarded.status).toBe(200);
    expect(seen.at(-1)?.url).toBe("https://up.example/hi");
  });
});
