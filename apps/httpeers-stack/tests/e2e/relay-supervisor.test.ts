/**
 * `superviseRelay`: a reservation lost with the relay link comes back.
 *
 * WHY A REAL RELAY THAT REALLY RESTARTS. The failure this exists for is a
 * property of libp2p, not of our code: when the connection to the relay
 * closes, `@libp2p/circuit-relay-v2` drops the reservation and makes one
 * attempt to find a relay again, and a relay that is down at that moment is
 * never tried again. Observed against the pinned versions (libp2p 3.3.8,
 * circuit-relay-v2 4.2.11): after the relay came back on the same port and
 * key, no reservation reappeared within 45 s -- while one explicit
 * `dialRelay` restored it within a second. A fake node would only encode our
 * reading of that behaviour; restarting a real relay observes it.
 *
 * THE RELAY RESTARTS ON THE SAME PORT AND THE SAME KEY, because that is what
 * a redeploy or a proxy reload looks like from the peer's side: the address
 * the peer was given is unchanged, and so is the peer id Noise verifies.
 *
 * See `notes/2026/2026-09/2026-09-11/httpeers-relay-reconnection.md` for the
 * diagnosis this closes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair } from "@libp2p/crypto/keys";
import type { Libp2p } from "@statewalker/httpeers.core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startHub } from "../../src/hub/main.js";
import { createHubNode } from "../../src/hub/node-profile.js";
import { type Relay, startRelay } from "../../src/relay/main.js";
import {
  dialRelay,
  type RelaySupervisor,
  superviseRelay,
  waitForCircuitReservation,
} from "../../src/reservation.js";
import { loadOrGenerateKey } from "../../src/setup/keys.js";

/** This suite's own seed, distinct from `harness.ts`'s so the two never share an identity. */
const RELAY_SEED = "httpeers-stack/e2e/relay-supervisor";
const HUB_SEED = "httpeers-stack/e2e/relay-supervisor-hub";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address == null || typeof address === "string") {
    throw new Error("relay-supervisor: could not read a port off the probe server");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `predicate` until it holds or `timeoutMs` passes; returns whether it held. */
async function eventually(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(100);
  }
  return predicate();
}

const hasReservation = (node: Libp2p): boolean =>
  node.getMultiaddrs().some((addr) => addr.toString().includes("/p2p-circuit"));

let dir: string;
let port: number;
let keyPath: string;
let relay: Relay | undefined;
let relayAddr: string;
let node: Libp2p | undefined;
let supervisor: RelaySupervisor | undefined;

async function startTheRelay(): Promise<void> {
  relay = await startRelay({ port, keyPath });
}

async function stopTheRelay(): Promise<void> {
  await relay?.stop();
  relay = undefined;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "httpeers-relay-supervisor-"));
  keyPath = join(dir, "relay.key");
  await loadOrGenerateKey({ keyPath, seed: RELAY_SEED });
  port = await freePort();
  await startTheRelay();
  const loopback = relay?.node
    .getMultiaddrs()
    .map((addr) => addr.toString())
    .find((addr) => addr.startsWith("/ip4/127.0.0.1/"));
  if (loopback == null) throw new Error("relay-supervisor: the relay reported no loopback address");
  relayAddr = loopback;

  node = await createHubNode({ privateKey: await generateKeyPair("Ed25519"), dev: true });
  await dialRelay(node, relayAddr);
  await waitForCircuitReservation(node);
});

afterEach(async () => {
  supervisor?.stop();
  supervisor = undefined;
  await node?.stop();
  node = undefined;
  await stopTheRelay();
  rmSync(dir, { recursive: true, force: true });
});

describe("superviseRelay", () => {
  it("restores the reservation once the relay is back, retrying through the outage", async () => {
    const live = node as Libp2p;
    supervisor = superviseRelay({
      node: live,
      relayAddr,
      minRetryDelayMs: 250,
      maxRetryDelayMs: 1_000,
    });

    await stopTheRelay();
    expect(await eventually(() => !hasReservation(live), 5_000)).toBe(true);

    // Down long enough for several attempts to fail against a closed port:
    // a supervisor that tried once and gave up -- libp2p's own behaviour --
    // fails here.
    await sleep(3_000);
    await startTheRelay();

    expect(await eventually(() => hasReservation(live), 10_000)).toBe(true);
  }, 30_000);

  it("stops re-dialling once stopped", async () => {
    // A page that was told to disconnect, or a hub being shut down, must not
    // quietly come back: the stopped supervisor is the only thing that would
    // dial, so a reservation reappearing here means it is still running.
    const live = node as Libp2p;
    supervisor = superviseRelay({
      node: live,
      relayAddr,
      minRetryDelayMs: 250,
      maxRetryDelayMs: 1_000,
    });
    supervisor.stop();

    await stopTheRelay();
    expect(await eventually(() => !hasReservation(live), 5_000)).toBe(true);
    // The outage has to outlast libp2p's own single re-dial, which fires as
    // the connection closes: restart the relay inside that window and libp2p
    // restores the reservation by itself, which this test would misread as
    // the supervisor still running.
    await sleep(3_000);
    await startTheRelay();

    // Several retry intervals' worth.
    expect(await eventually(() => hasReservation(live), 4_000)).toBe(false);
  }, 30_000);

  it("retries at once when poked, instead of waiting out the backoff", async () => {
    // What a page does when the network comes back or the tab becomes
    // visible again: the backoff was sized for a relay that is down, and the
    // wake-up is evidence that it may not be any more.
    const live = node as Libp2p;
    supervisor = superviseRelay({
      node: live,
      relayAddr,
      minRetryDelayMs: 60_000,
      maxRetryDelayMs: 60_000,
    });

    await stopTheRelay();
    expect(await eventually(() => !hasReservation(live), 5_000)).toBe(true);
    // Past libp2p's own single re-dial, and past the supervisor's first
    // attempt -- so the next one is at least 30 s away.
    await sleep(3_000);
    await startTheRelay();

    supervisor.poke();
    expect(await eventually(() => hasReservation(live), 5_000)).toBe(true);
  }, 30_000);
});

describe("startHub", () => {
  it("gets its reservation back after the relay restarts", async () => {
    // The hub's reservation is the one every member depends on: while it is
    // gone, no page can reach the hub, so none can heartbeat or be issued a
    // token. `startHub` must supervise it, not only acquire it once.
    const hubKeyPath = join(dir, "hub.key");
    await loadOrGenerateKey({ keyPath: hubKeyPath, seed: HUB_SEED });
    const hub = await startHub({
      stateFilePath: join(dir, "hub-state.json"),
      keyPath: hubKeyPath,
      relayAddr,
    });
    try {
      await stopTheRelay();
      expect(await eventually(() => !hasReservation(hub.node), 5_000)).toBe(true);
      await sleep(3_000);
      await startTheRelay();

      // The supervisor's default first retry is 0.5-1 s, then 1-2 s, ...:
      // well inside this window once the relay is back.
      expect(await eventually(() => hasReservation(hub.node), 15_000)).toBe(true);
    } finally {
      await hub.stop();
    }
  }, 40_000);
});
