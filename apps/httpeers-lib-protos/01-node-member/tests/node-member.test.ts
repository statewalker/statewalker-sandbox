/**
 * 01 — Does the member lifecycle run headless under Node?
 *
 * The deployment is the REAL one: `tests/e2e/harness.ts`'s `startStack`
 * boots a relay process and a hub process from their own `main.ts` entry
 * points, from seeded on-disk keys, with the hub's TTL sweep timer running.
 * Nothing here re-implements a hub.
 *
 * What is under test is `../src/member.ts`'s `startMember` — the browser
 * runtime's own join sequence with the platform couplings injected. The
 * member peers are built by `startMember` itself, NOT by the harness's
 * `join()`, because "the production path runs under Node" is exactly the
 * claim; using the harness's hand-assembled test peer would prove only that
 * a test peer works, which `node-consumer.test.ts` already established.
 */

import { peerIdFromString } from "@libp2p/peer-id";
import { createMounts } from "@statewalker/httpeers.core";
import { appRules } from "@statewalker/httpeers-stack/src/policy.js";
import type { Stack } from "@statewalker/httpeers-stack/tests/e2e/harness.js";
import { startStack } from "@statewalker/httpeers-stack/tests/e2e/harness.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MemberHandle } from "../src/member.js";
import { startMember } from "../src/member.js";
import { nodePlatform } from "../src/node-platform.js";

/** Above `src/browser/join.ts`'s 5 s heartbeat, so a member is not swept between its own beats. */
const PRESENCE_TTL_MS = 12_000;

/** The mount prefix's first segment — the ServiceWorker key in a page, an ordinary path segment here. */
const KEY = "peers";

/** A capability `src/policy.ts`'s APP_RULES already derives for `member`, so no app vocabulary is invented here. */
const ECHO_POLICY =
  'allow if operation($m), resource($r), $r.starts_with("/echo"), capability("app:search.query");';

function echoMounts() {
  const mounts = createMounts();
  mounts.provide(
    "/echo",
    async (req: Request): Promise<Response> =>
      new Response(`echo:${new URL(req.url).pathname}`, { status: 200 }),
  );
  return mounts;
}

describe("01 — a Node member, on the production join path", () => {
  let stack: Stack;
  let provider: MemberHandle;
  let consumer: MemberHandle;

  beforeAll(async () => {
    stack = await startStack({ presenceTtlMs: PRESENCE_TTL_MS });

    provider = await startMember({
      key: KEY,
      mounts: echoMounts(),
      rules: appRules([ECHO_POLICY]),
      config: { relayAddrs: [stack.relayAddr], hubPeerId: stack.hubPeerId },
      platform: nodePlatform,
      invitationId: stack.invite(["member"]),
      advertisements: () => [{ id: "echo", kind: "echo", title: "Echo" }],
    });

    consumer = await startMember({
      key: KEY,
      mounts: createMounts(),
      rules: appRules([]),
      config: { relayAddrs: [stack.relayAddr], hubPeerId: stack.hubPeerId },
      platform: nodePlatform,
      invitationId: stack.invite(["member"]),
    });
  }, 120_000);

  afterAll(async () => {
    await consumer?.stop();
    await provider?.stop();
    await stack?.stop();
  });

  it("CLAIM 1 — joins by redeeming an invitation, with no browser anywhere", () => {
    expect(provider.joinedBy).toBe("redeemed");
    expect(consumer.joinedBy).toBe("redeemed");
    expect(provider.peerId).not.toBe(consumer.peerId);
  });

  it("CLAIM 2 — the edge exists under Node with no ServiceWorker: `fetch` is present, `baseUrl` is not", () => {
    expect(typeof provider.fetch).toBe("function");
    expect(provider.baseUrl).toBeUndefined();
  });

  it("CLAIM 3 — the heartbeat runs: each member sees the other in the mesh view", async () => {
    const seen = await waitFor(
      () => {
        const view = consumer.meshView();
        return view?.members.some((m) => m.peerId === provider.peerId) === true ? view : null;
      },
      30_000,
      "the consumer never saw the provider in its mesh view",
    );
    expect(seen.members.some((m) => m.peerId === provider.peerId)).toBe(true);
  });

  it("CLAIM 4 — the provider's advertisement reaches the mesh view, so discovery by `kind` works", async () => {
    const ad = await waitFor(
      () =>
        consumer
          .meshView()
          ?.advertisements.find((a) => a.peerId === provider.peerId && a.kind === "echo") ?? null,
      30_000,
      "the provider's advertisement never appeared",
    );
    expect(ad.kind).toBe("echo");
  });

  it("CLAIM 5 — one Node member calls another THROUGH ITS OWN EDGE, exactly as a page would", async () => {
    // A page writes `fetch(`${baseUrl}${peerId}/echo/hi`)`. This is the same
    // string, through the same `createEdgeDispatch` handler, with the origin
    // supplied by the caller because Node has no page origin.
    const res = await consumer.fetch(
      new Request(`http://member.local/${KEY}/${provider.peerId}/echo/hi`),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("echo:/echo/hi");
  }, 60_000);

  it("CLAIM 6 — the token rotates on the heartbeat, and the edge picks it up per call", async () => {
    const first = consumer.token();
    const rotated = await waitFor(
      () => (consumer.token() !== first ? consumer.token() : null),
      30_000,
      "the membership token never rotated",
    );
    expect(rotated).not.toBe(first);
    // The edge reads the token at call time, so the call still works after rotation.
    const res = await consumer.fetch(
      new Request(`http://member.local/${KEY}/${provider.peerId}/echo/again`),
    );
    expect(res.status).toBe(200);
  }, 60_000);

  it("CLAIM 7 — the hub link is dropped, and the member restores it without being restarted", async () => {
    const hubId = peerIdFromString(stack.hubPeerId);
    const before = provider.node.getConnections(hubId).filter((c) => c.status === "open");
    expect(before.length).toBeGreaterThan(0);

    // The drop a sleeping laptop or a dead Wi-Fi link produces: the
    // connection the provider's reservation rides simply goes away.
    await Promise.all(before.map(async (c) => await c.close()));
    expect(provider.node.getConnections(hubId).filter((c) => c.status === "open")).toHaveLength(0);

    // No restart, no poke: a Node process gets no wake events, so this is the
    // supervisor's backstop timer and the keepalive doing it alone.
    await waitFor(
      () =>
        provider.node.getConnections(hubId).filter((c) => c.status === "open").length > 0
          ? true
          : null,
      60_000,
      "the provider never re-established its hub connection",
    );

    // Reachability is the claim, not the socket: another member must be able
    // to call it again, which needs the RESERVATION back, not just a dial.
    const res = await waitFor(
      async () => {
        const r = await consumer.fetch(
          new Request(`http://member.local/${KEY}/${provider.peerId}/echo/after-drop`),
        );
        return r.status === 200 ? r : null;
      },
      60_000,
      "the provider never became reachable again after the drop",
    );
    expect(await res.text()).toBe("echo:/echo/after-drop");
  }, 150_000);
});

async function waitFor<T>(
  probe: () => (T | null) | Promise<T | null>,
  budgetMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = await probe();
    if (value != null) return value;
    if (Date.now() > deadline) throw new Error(`${what}: still not true after ${budgetMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
