/**
 * A hub relays SIGNALLING for its own members, and nothing for anyone else.
 *
 * The design (umbrella note 2026-09-11 §7, and the `proto/hub-relay`
 * prototype that tested it in Chromium): members reserve on their hub over
 * their WebRTC link to it, and reach each other through the hub rather than
 * through the public relay. The circuit through the hub only carries the
 * WebRTC offer and answer; the members end up connected directly.
 *
 * REAL NODES, REAL RELAY, REAL WEBRTC. The hub is the Node hub profile, the
 * members are the browser profile (`createBrowserNode`, which runs under Node
 * because `@libp2p/webrtc` does), and every connection below is negotiated
 * for real. What these tests pin is libp2p's behaviour under our
 * configuration, and a fake would only restate our reading of it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { multiaddr } from "@multiformats/multiaddr";
import type { Libp2p } from "@statewalker/httpeers.core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBrowserNode } from "../../src/browser/node-profile.js";
import { createHubNode } from "../../src/hub/node-profile.js";
import { hubRoute, reachHub, reserveOnHub, superviseHubReservation } from "../../src/hub-link.js";
import { type Relay, startRelay } from "../../src/relay/main.js";
import {
  dialRelay,
  type RelaySupervisor,
  waitForCircuitReservation,
} from "../../src/reservation.js";
import { loadOrGenerateKey } from "../../src/setup/keys.js";

const RELAY_SEED = "httpeers-stack/e2e/hub-relay";

let dir: string;
let relay: Relay;
let relayAddr: string;
let hub: Libp2p;
let hubId: string;
const members = new Set<string>();
const nodes: Libp2p[] = [];
let supervisor: RelaySupervisor | undefined;

const onHub = (node: Libp2p): boolean =>
  node.getMultiaddrs().some((addr) => addr.toString().includes(`/p2p/${hubId}/p2p-circuit`));

async function eventually(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
}

async function member(): Promise<Libp2p> {
  const node = await createBrowserNode({ dev: true, privateKey: await generateKeyPair("Ed25519") });
  nodes.push(node);
  return node;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "httpeers-hub-relay-"));
  const keyPath = join(dir, "relay.key");
  await loadOrGenerateKey({ keyPath, seed: RELAY_SEED });
  relay = await startRelay({ port: 0, keyPath });
  const loopback = relay.node
    .getMultiaddrs()
    .map((addr) => addr.toString())
    .find((addr) => addr.startsWith("/ip4/127.0.0.1/"));
  if (loopback == null) throw new Error("hub-relay: the relay reported no loopback address");
  relayAddr = loopback;

  members.clear();
  hub = await createHubNode({
    privateKey: await generateKeyPair("Ed25519"),
    dev: true,
    isMember: (peerId) => members.has(peerId),
  });
  nodes.push(hub);
  hubId = hub.peerId.toString();
  await dialRelay(hub, relayAddr);
  await waitForCircuitReservation(hub);
});

afterEach(async () => {
  supervisor?.stop();
  supervisor = undefined;
  await Promise.all(nodes.splice(0).map((node) => node.stop()));
  await relay.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("a hub relaying for its members", () => {
  it("lets a member reserve on it over their WebRTC link", async () => {
    const a = await member();
    members.add(a.peerId.toString());
    await reachHub(a, relayAddr, hubId);

    const reserved = await reserveOnHub(a, hubId);

    expect(reserved).toContain(`/p2p/${hubId}/p2p-circuit`);
  }, 30_000);

  it("refuses a reservation from a peer that is not a member", async () => {
    // A non-member must still be able to CONNECT to the hub -- that is how
    // an invitation gets redeemed -- but not use it as a relay.
    const c = await member();
    await reachHub(c, relayAddr, hubId);

    await expect(reserveOnHub(c, hubId)).rejects.toThrow();
  }, 30_000);

  it("connects two members directly, with the hub carrying only the signalling", async () => {
    const a = await member();
    const b = await member();
    members.add(a.peerId.toString());
    members.add(b.peerId.toString());
    for (const node of [a, b]) {
      await reachHub(node, relayAddr, hubId);
      await reserveOnHub(node, hubId);
    }

    const conn = await a.dial(multiaddr(hubRoute(hubId, b.peerId.toString())));

    // Unlimited and WebRTC: the circuit through the hub did its job and the
    // data path is A-B directly. A limited connection here would mean the
    // hub is carrying the traffic -- which its default limits would then cut.
    expect(conn.remotePeer.toString()).toBe(b.peerId.toString());
    expect(conn.limits).toBeUndefined();
    expect(conn.remoteAddr.toString()).toContain("/webrtc");
  }, 30_000);

  it("refuses to relay a non-member to a member", async () => {
    const b = await member();
    const c = await member();
    members.add(b.peerId.toString());
    await reachHub(b, relayAddr, hubId);
    await reserveOnHub(b, hubId);
    await reachHub(c, relayAddr, hubId);

    await expect(c.dial(multiaddr(hubRoute(hubId, b.peerId.toString())))).rejects.toThrow(
      /PERMISSION_DENIED/,
    );
  }, 30_000);
});

describe("superviseHubReservation", () => {
  it("restores a member's reservation on its hub after the link drops", async () => {
    // A reservation on the hub is a CONFIGURED relay, which libp2p never
    // restores on its own -- so a member whose link to the hub dropped (the
    // hub's tab slept, the network changed) would stay unreachable by every
    // other member until reloaded.
    const a = await member();
    members.add(a.peerId.toString());
    await reachHub(a, relayAddr, hubId);
    await reserveOnHub(a, hubId);
    supervisor = superviseHubReservation({
      node: a,
      relayAddr,
      hubPeerId: hubId,
      minRetryDelayMs: 250,
      maxRetryDelayMs: 1_000,
    });

    await hub.hangUp(a.peerId);
    expect(await eventually(() => !onHub(a), 5_000)).toBe(true);

    expect(await eventually(() => onHub(a), 15_000)).toBe(true);
  }, 40_000);
});
