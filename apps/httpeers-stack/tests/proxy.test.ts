import { describe, expect, it, vi } from "vitest";
import type { ProxyRoute } from "../src/services/proxy-routes.js";
import { PROXY_POLICIES, PROXY_RULES, createProxyEndpoint } from "../src/services/proxy.js";

const ROUTES: ProxyRoute[] = [
  { prefix: "/openai", upstream: "https://api.openai.com/v1", headers: { authorization: "Bearer sk-cfg" } },
];

function endpoint(fetchImpl: typeof fetch, routes: ProxyRoute[] = ROUTES) {
  return createProxyEndpoint({ routes: () => routes, fetchImpl });
}

describe("createProxyEndpoint", () => {
  it("forwards to the configured upstream with method and path", async () => {
    const seen: Request[] = [];
    const spy = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
      const r = input instanceof Request ? input : new Request(String(input), init);
      seen.push(r);
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const res = await endpoint(spy)(new Request("http://mesh/proxy/openai/models", { method: "GET" }));
    expect(res.status).toBe(200);
    expect(seen[0]?.url).toBe("https://api.openai.com/v1/models");
    expect(seen[0]?.method).toBe("GET");
  });

  // Spec §7: nothing is stripped by this code.
  it("passes a caller's headers through untouched", async () => {
    const seen: Request[] = [];
    const spy = vi.fn(async (i: Request) => { seen.push(i); return new Response("ok"); }) as unknown as typeof fetch;
    await endpoint(spy)(
      new Request("http://mesh/proxy/openai/models", { headers: { "x-trace": "abc", accept: "application/json" } }),
    );
    expect(seen[0]?.headers.get("x-trace")).toBe("abc");
    expect(seen[0]?.headers.get("accept")).toBe("application/json");
  });

  // Spec §7.2: configured headers are applied last.
  it("lets the route's headers win over the caller's", async () => {
    const seen: Request[] = [];
    const spy = vi.fn(async (i: Request) => { seen.push(i); return new Response("ok"); }) as unknown as typeof fetch;
    await endpoint(spy)(
      new Request("http://mesh/proxy/openai/models", { headers: { authorization: "Bearer caller" } }),
    );
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer sk-cfg");
  });

  // REVERSED 2026-09-11, on evidence. This used to assert that a caller's
  // `authorization` reaches the upstream. But on the mesh path that header IS
  // the mesh's own credential -- set by edge-dispatch, verified by peer.ts
  // before this handler runs -- and forwarding it (a) handed a mesh token to
  // third parties, and (b) broke every upstream whose CORS preflight does not
  // name `authorization`: swapi answers such a preflight with no CORS headers
  // at all, and `allow-headers: *` does not cover it under the Fetch spec.
  it("does not forward the mesh's own credential to the upstream", async () => {
    const seen: Request[] = [];
    const spy = vi.fn(async (i: Request) => { seen.push(i); return new Response("ok"); }) as unknown as typeof fetch;
    const open: ProxyRoute[] = [{ prefix: "/open", upstream: "https://o.example", headers: {} }];
    await endpoint(spy, open)(
      new Request("http://mesh/proxy/open/x", { headers: { authorization: "Bearer EpkECq4DmeshToken" } }),
    );
    expect(seen[0]?.headers.has("authorization")).toBe(false);
  });

  // The exception is exactly one header. Everything else still passes through
  // unjudged, or this would quietly become the strip list the spec rejected.
  it("still forwards every other caller header", async () => {
    const seen: Request[] = [];
    const spy = vi.fn(async (i: Request) => { seen.push(i); return new Response("ok"); }) as unknown as typeof fetch;
    const open: ProxyRoute[] = [{ prefix: "/open", upstream: "https://o.example", headers: {} }];
    await endpoint(spy, open)(
      new Request("http://mesh/proxy/open/x", {
        headers: { authorization: "Bearer mesh", "x-trace": "abc", "x-api-version": "2" },
      }),
    );
    expect(seen[0]?.headers.get("x-trace")).toBe("abc");
    expect(seen[0]?.headers.get("x-api-version")).toBe("2");
  });

  it("returns the upstream status and body verbatim", async () => {
    const spy = vi.fn(async () => new Response('{"error":"no key"}', {
      status: 401, headers: { "content-type": "application/json", "x-request-id": "req_1" },
    })) as unknown as typeof fetch;
    const res = await endpoint(spy)(new Request("http://mesh/proxy/openai/models"));
    expect(res.status).toBe(401);
    expect(res.headers.get("x-request-id")).toBe("req_1");
    expect(await res.text()).toBe('{"error":"no key"}');
  });

  // Spec §11.
  it("404s an unmatched prefix, distinguishably", async () => {
    const spy = vi.fn(async () => new Response("never")) as unknown as typeof fetch;
    const res = await endpoint(spy)(new Request("http://mesh/proxy/matrix/sync"));
    expect(res.status).toBe(404);
    expect(res.headers.get("x-httpeers-proxy")).toBe("no-route");
    expect(spy).not.toHaveBeenCalled();
  });

  it("502s an unreachable upstream, distinguishably", async () => {
    const spy = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    const res = await endpoint(spy)(new Request("http://mesh/proxy/openai/models"));
    expect(res.status).toBe(502);
    expect(res.headers.get("x-httpeers-proxy")).toBe("upstream-unreachable");
    expect(await res.text()).toContain("Failed to fetch");
  });

  // THE STREAMING GUARANTEE (spec §8). An upstream body that never closes must
  // still yield a readable first chunk -- if the proxy buffered, this hangs.
  it("does not buffer the response body", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode("first")); /* never closed */ },
    });
    const spy = vi.fn(async () => new Response(upstream)) as unknown as typeof fetch;
    const res = await endpoint(spy)(new Request("http://mesh/proxy/openai/models"));
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe("first");
    await reader.cancel();
  });

  it("forwards a request body as a stream", async () => {
    const seen: Request[] = [];
    const spy = vi.fn(async (i: Request) => { seen.push(i); return new Response("ok"); }) as unknown as typeof fetch;
    await endpoint(spy)(
      new Request("http://mesh/proxy/openai/chat", { method: "POST", body: '{"a":1}',
        headers: { "content-type": "application/json" } }),
    );
    expect(seen[0]?.method).toBe("POST");
    expect(await seen[0]!.text()).toBe('{"a":1}');
  });
});

import { readFileSync } from "node:fs";

const RUNTIME_FREE = ["src/services/proxy.ts", "src/services/proxy-routes.ts"];

describe("runtime independence (spec §5, acceptance criterion 1)", () => {
  it("imports no node: builtin, by any import form", () => {
    for (const f of RUNTIME_FREE) {
      const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
      // Covers `from "node:x"`, the side-effect form `import "node:x"`, and
      // dynamic `import("node:x")` -- a regex that only understood the first
      // would pass while the module was importing `node:fs` two ways.
      expect(src.match(/["'`]node:[^"'`]+["'`]/g) ?? []).toEqual([]);
    }
  });

  // DOM types are AMBIENT in TypeScript, so no import ever names them and an
  // import scan cannot see a DOM dependency at all. The only thing that can is
  // looking for the globals themselves.
  it("references no DOM global", () => {
    const forbidden =
      /\b(document|window|localStorage|sessionStorage|navigator|OffscreenCanvas|createImageBitmap|HTMLElement)\b/;
    for (const f of RUNTIME_FREE) {
      const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8")
        // Strip comments first: prose about the browser is expected in these
        // files and must not fail the check that their CODE is browser-free.
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(src.match(forbidden)?.[0] ?? null).toBeNull();
    }
  });
});

describe("PROXY_POLICIES (spec §10)", () => {
  // `src/policy.ts`: "A PATH GOVERNS ITSELF AND ITS SUBTREE, AND NOTHING ELSE.
  // ... `$r.starts_with("/test")` alone would also match `/testing`." The
  // first draft of this policy was the single-clause form and would have
  // authorized `/proxying`, so the shape is asserted rather than trusted.
  it("authorizes the mount and its subtree, and nothing that merely starts with it", () => {
    const joined = PROXY_POLICIES.join(" ");
    expect(joined).toContain('resource("/proxy")');
    expect(joined).toContain('$r.starts_with("/proxy/")');
    expect(joined).not.toContain('$r.starts_with("/proxy")');
  });

  it("builds a valid rule set, so every capability it names is derived", () => {
    expect(() => PROXY_RULES).not.toThrow();
    expect(PROXY_RULES).toBeDefined();
  });
});

describe("the route listing at the mount root", () => {
  const LISTED: ProxyRoute[] = [
    { prefix: "/swapi", upstream: "https://swapi.dev/api", headers: {} },
    { prefix: "/openai", upstream: "https://api.openai.com/v1",
      headers: { authorization: "Bearer sk-SECRET", "x-org": "org-SECRET" } },
  ];
  const never = vi.fn(async () => new Response("must not be called")) as unknown as typeof fetch;

  it("lists prefix and upstream for every route", async () => {
    const res = await endpoint(never, LISTED)(new Request("http://mesh/proxy/"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      routes: [
        { prefix: "/swapi", upstream: "https://swapi.dev/api" },
        { prefix: "/openai", upstream: "https://api.openai.com/v1" },
      ],
    });
    expect(never).not.toHaveBeenCalled();
  });

  // THE POINT OF THE SHAPE. A header's VALUE is a credential; its NAME says
  // which credential scheme is in use. Neither belongs in something every
  // member of the mesh can read.
  it("never exposes a header, by value or by name", async () => {
    const text = await (await endpoint(never, LISTED)(new Request("http://mesh/proxy/"))).text();
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("authorization");
    expect(text).not.toContain("x-org");
    expect(text).not.toContain("headers");
  });

  it("answers at the bare mount too", async () => {
    const res = await endpoint(never, LISTED)(new Request("http://mesh/proxy"));
    expect(res.status).toBe(200);
  });

  it("does not shadow a real route beside it", async () => {
    const seen: Request[] = [];
    const spy = vi.fn(async (i: Request) => { seen.push(i); return new Response("ok"); }) as unknown as typeof fetch;
    await endpoint(spy, LISTED)(new Request("http://mesh/proxy/swapi/people/1/"));
    expect(seen[0]?.url).toBe("https://swapi.dev/api/people/1/");
  });

  // Only a read is a listing. Anything else at the root is a request for a
  // route that does not exist, and says so the same way every other miss does.
  it("lists only for GET", async () => {
    const res = await endpoint(never, LISTED)(new Request("http://mesh/proxy/", { method: "POST", body: "x" }));
    expect(res.status).toBe(404);
    expect(res.headers.get("x-httpeers-proxy")).toBe("no-route");
  });
});
