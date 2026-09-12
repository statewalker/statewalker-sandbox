/**
 * 08 — Can an ordinary HTTP client reach the whole mesh, knowing nothing?
 *
 * The client in every test below is `globalThis.fetch` against
 * `http://127.0.0.1:<port>` — no libp2p, no peer object, no token, no
 * knowledge that a mesh exists. Everything behind the port is real: the
 * relay and hub processes from `tests/e2e/harness.ts`, real Noise handshakes,
 * real member peers from rung 01's production join path.
 *
 * The server is `@hono/node-server`, given the gateway handler and nothing
 * else — the claim being that a fetch handler really is all it takes.
 */

import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createMounts } from "@statewalker/httpeers.core";
import { appRules } from "@statewalker/httpeers-stack/src/policy.js";
import type { Stack } from "@statewalker/httpeers-stack/tests/e2e/harness.js";
import { startStack } from "@statewalker/httpeers-stack/tests/e2e/harness.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MemberHandle } from "../../01-node-member/src/member.js";
import { startMember } from "../../01-node-member/src/member.js";
import { nodePlatform } from "../../01-node-member/src/node-platform.js";
import { createGateway, GATEWAY_MARKER } from "../src/gateway.js";

const PRESENCE_TTL_MS = 12_000;
const KEY = "peers";
const POLICY =
  'allow if operation($m), resource($r), $r.starts_with("/echo"), capability("app:search.query");';

function echoMounts(label: string) {
  const mounts = createMounts();
  mounts.provide("/echo", async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/slow")) {
      // Long enough that a client hang-up lands mid-flight.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    return new Response(`${label}:${url.pathname}${url.search}`);
  });
  return mounts;
}

describe("08 — the mesh, served as ordinary HTTP", () => {
  let stack: Stack;
  let gatewayMember: MemberHandle;
  let provider: MemberHandle;
  let late: MemberHandle | undefined;
  let server: ReturnType<typeof serve>;
  let origin: string;

  beforeAll(async () => {
    stack = await startStack({ presenceTtlMs: PRESENCE_TTL_MS });

    const mesh = { relayAddrs: [stack.relayAddr], hubPeerId: stack.hubPeerId };

    // The peer the gateway speaks for. It serves nothing itself.
    gatewayMember = await startMember({
      key: KEY,
      mounts: createMounts(),
      rules: appRules([]),
      config: mesh,
      platform: nodePlatform,
      invitationId: stack.invite(["member"]),
    });

    provider = await startMember({
      key: KEY,
      mounts: echoMounts("provider"),
      rules: appRules([POLICY]),
      config: mesh,
      platform: nodePlatform,
      invitationId: stack.invite(["member"]),
      advertisements: () => [{ id: "echo", kind: "echo", title: "Echo" }],
    });

    // Mounted at the ROOT, which a ServiceWorker could not do and a Node
    // server can — one of the two reasons `basePath` is a parameter.
    const handler = createGateway({
      source: gatewayMember,
      basePath: "",
      edgeKey: KEY,
    });

    // The listening callback, not `address()` straight after: `serve` binds
    // asynchronously, so the address is null until it fires.
    origin = await new Promise<string>((resolve) => {
      server = serve({ fetch: handler, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
        resolve(`http://127.0.0.1:${info.port}`);
      });
    });

    // Let the first heartbeat land so the view is populated.
    await waitFor(
      () => (gatewayMember.meshView()?.members.length ?? 0) >= 2,
      30_000,
      "the gateway's peer never saw the provider",
    );
  }, 180_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await late?.stop();
    await provider?.stop();
    await gatewayMember?.stop();
    await stack?.stop();
  });

  it("CLAIM 1 — a plain fetch to a plain port reaches a peer across the mesh", async () => {
    const res = await fetch(`${origin}/${provider.peerId}/echo/hi?q=1`);
    expect(res.status).toBe(200);
    // The provider saw its own mount path, not the gateway's URL.
    expect(await res.text()).toBe("provider:/echo/hi?q=1");
  }, 60_000);

  it("CLAIM 2 — the client holds no token, no peer object and no libp2p", async () => {
    // The only thing this test knows is a URL string. The membership token is
    // attached inside the edge, per call, and never reaches the HTTP client.
    const res = await fetch(`${origin}/${provider.peerId}/echo/anonymous-client`);
    expect(res.status).toBe(200);
    expect(res.headers.get("authorization")).toBeNull();
  }, 60_000);

  it("CLAIM 3 — the listing enumerates peers and KINDS, and never invents URLs", async () => {
    const res = await fetch(`${origin}/`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ready: boolean;
      version: number;
      peers: { peerId: string }[];
      offers: { peerId: string; kind: string }[];
    };
    expect(body.ready).toBe(true);
    expect(body.peers.map((p) => p.peerId)).toContain(provider.peerId);
    expect(body.offers.some((o) => o.peerId === provider.peerId && o.kind === "echo")).toBe(true);
    // The honesty claim: the mesh view carries no service paths, so nothing
    // in the listing may look like a URL.
    expect(JSON.stringify(body)).not.toContain("http");
  }, 60_000);

  it("CLAIM 4 — a peer that joins AFTER the server started is dispatchable, with no rebuild", async () => {
    late = await startMember({
      key: KEY,
      mounts: echoMounts("late"),
      rules: appRules([POLICY]),
      config: { relayAddrs: [stack.relayAddr], hubPeerId: stack.hubPeerId },
      platform: nodePlatform,
      invitationId: stack.invite(["member"]),
      advertisements: () => [{ id: "echo", kind: "echo", title: "Late echo" }],
    });

    const res = await waitFor(
      async () => {
        const r = await fetch(`${origin}/${late!.peerId}/echo/late`);
        return r.status === 200 ? r : null;
      },
      60_000,
      "the late peer never became reachable through the gateway",
    );
    expect(await res.text()).toBe("late:/echo/late");
  }, 120_000);

  it("CLAIM 5 — an unknown peer fails as a mesh error, not as a gateway crash", async () => {
    const stranger = "12D3KooWEHUcCvsmTLLoQG28Y2PDkUfddP1WmdSKwY1sSxfANcxR";
    const res = await fetch(`${origin}/${stranger}/echo/nope`);
    // 502/504 from the edge's own taxonomy — the point is that it is a
    // structured refusal, and that the server is still serving afterwards.
    expect([502, 504]).toContain(res.status);
    const after = await fetch(`${origin}/${provider.peerId}/echo/still-here`);
    expect(after.status).toBe(200);
  }, 60_000);

  it("CLAIM 6 — a path with no peer is refused by the gateway itself", async () => {
    const res = await fetch(`${origin}/`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(res.headers.get(GATEWAY_MARKER)).toBe("no-peer");
  }, 60_000);

  it("CLAIM 7 — a client hang-up aborts the call instead of orphaning it", async () => {
    const controller = new AbortController();
    const pending = fetch(`${origin}/${provider.peerId}/echo/slow`, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    await expect(pending).rejects.toThrow();
    // The server survives an aborted request and keeps serving.
    const after = await fetch(`${origin}/${provider.peerId}/echo/after-abort`);
    expect(after.status).toBe(200);
  }, 60_000);
});

async function waitFor<T>(
  probe: () => (T | null) | Promise<T | null>,
  budgetMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = await probe();
    if (value != null && value !== false) return value as T;
    if (Date.now() > deadline) throw new Error(`${what}: still not true after ${budgetMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
