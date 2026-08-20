/**
 * Task 20, fix round 1: `startHub` releases the node it built when startup
 * fails partway.
 *
 * WHY THIS NEEDS A TEST OF ITS OWN, AND WHY IT ASSERTS A PORT. `startHub`
 * builds its libp2p node and only afterwards dials the relay and calls
 * `createPeer`. The node is STARTED the moment it exists — listening on its
 * TCP address, and (past the relay dial) holding a connection and a
 * reservation. A `startHub` that threw after that point used to leave it
 * running, and the caller has no handle to close because the call never
 * returned. In a vitest run that presents as a HANG rather than a failure:
 * the suite reports nothing wrong and simply never exits, which is the worst
 * shape this bug can take and the reason a passing suite was not evidence
 * against it.
 *
 * So the assertion is not "it threw" — that was always true. It is that the
 * TCP port the hub's node was listening on is FREE afterwards, proven by
 * binding it. A leaked node still holds it; a stopped one does not. That is
 * the same fact a hang would have been caused by, observed directly and
 * without a timeout.
 *
 * SCOPE, STATED PLAINLY. This exercises the relay-dial failure path, which
 * runs the same `startFailed()` unwind as the `createPeer` path added in fix
 * round 1. `StartHubInit` exposes no lever that makes `createPeer` itself
 * throw without mocking `httpeers.core`, so that branch is covered by
 * construction (one shared unwind, one shared stack) rather than by its own
 * case here — see the Task 20 report's fix-round-1 section, which records the
 * manual fault injection used to check it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startHub } from "../../src/hub/main.js";
import { loadOrGenerateKey, peerIdOf } from "../../src/setup/keys.js";

/** This suite's own seed, distinct from `harness.ts`'s so the two never share an identity. */
const HUB_SEED = "httpeers-stack/e2e/hub-startup";

/**
 * A relay peer id that is derived, not invented: `multiaddr()` parses the
 * `/p2p/...` component strictly, so a made-up string would fail at address
 * construction and the test would pass for the wrong reason.
 */
const ABSENT_RELAY_SEED = "httpeers-stack/e2e/relay-that-is-not-running";

/** Ask the OS for a free TCP port by binding port 0 and letting go of it again. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address == null || typeof address === "string") {
    throw new Error("hub-startup: could not read a port off the probe server");
  }
  const { port } = address;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** True if `port` can be bound right now — i.e. nothing is still listening on it. */
async function portIsFree(port: number): Promise<boolean> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch {
    return false;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return true;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "httpeers-hub-startup-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Task 20: startHub's startup unwinds what it built", () => {
  it("releases its libp2p node when the relay cannot be reached, rather than leaking it", async () => {
    const keyPath = join(dir, "hub.key");
    await loadOrGenerateKey({ keyPath, seed: HUB_SEED });
    const relayPeerId = peerIdOf(
      await loadOrGenerateKey({ keyPath: join(dir, "absent-relay.key"), seed: ABSENT_RELAY_SEED }),
    );

    // Two DIFFERENT free ports: one the hub will listen on, one naming a
    // relay that is not there. Nothing is bound to either at this instant.
    const hubPort = await freePort();
    const absentRelayPort = await freePort();
    expect(hubPort).not.toBe(absentRelayPort);
    expect(await portIsFree(hubPort)).toBe(true);

    const relayAddr = `/ip4/127.0.0.1/tcp/${absentRelayPort}/ws/p2p/${relayPeerId}`;

    await expect(
      startHub({
        stateFilePath: join(dir, "hub-state.json"),
        keyPath,
        listen: [`/ip4/127.0.0.1/tcp/${hubPort}`],
        relayAddr,
      }),
    ).rejects.toThrow(/could not reserve a circuit slot through the relay/);

    // THE ASSERTION THIS FILE EXISTS FOR. The node was up and listening on
    // `hubPort` before the relay dial was even attempted; if `startHub` did
    // not stop it on the way out, this port is still held and nothing else
    // in the process can ever reclaim it.
    expect(await portIsFree(hubPort)).toBe(true);
  }, 30_000);

  it("names the relay address and the remedy in the failure, not libp2p's own wording", async () => {
    // The message is the deliverable here. Task 14 lost two investigations to
    // libp2p's "The dial request has no valid addresses for peer", which
    // names neither the relay, nor the reservation, nor anything to do.
    const keyPath = join(dir, "hub.key");
    await loadOrGenerateKey({ keyPath, seed: HUB_SEED });
    const relayPeerId = peerIdOf(
      await loadOrGenerateKey({ keyPath: join(dir, "absent-relay.key"), seed: ABSENT_RELAY_SEED }),
    );
    const relayAddr = `/ip4/127.0.0.1/tcp/${await freePort()}/ws/p2p/${relayPeerId}`;

    const err = await startHub({
      stateFilePath: join(dir, "hub-state.json"),
      keyPath,
      listen: [`/ip4/127.0.0.1/tcp/${await freePort()}`],
      relayAddr,
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err).not.toBeNull();
    expect(err?.message).toContain(relayAddr); // which relay
    expect(err?.message).toContain("no browser can reach this hub"); // why it matters
    expect(err?.message).toContain("httpeers.json"); // where to look
    // And the underlying cause is preserved rather than swallowed.
    expect((err as Error & { cause?: unknown })?.cause).toBeDefined();
  }, 30_000);
});
