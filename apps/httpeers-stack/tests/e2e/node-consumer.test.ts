/**
 * Task 14 — leg 1 of the design record's §10 verification: a CONSUMER that
 * joins the real deployment, discovers what it needs, uses it, and is cut off
 * again, with no browser anywhere in the picture.
 *
 * "The real deployment" is meant literally: `tests/e2e/harness.ts` boots the
 * relay and the hub through their own `main.ts` entry points, from seeded
 * on-disk keys, with the hub's TTL sweep timer running — see that file's
 * module comment for the four ways this differs from `tests/support/mesh.ts`,
 * and for the two hops (member-to-member over WebRTC, and any browser-to-hub
 * hop at all) that Node genuinely cannot reach.
 *
 * THE PROVIDER HERE IS A NODE PEER STANDING IN FOR THE BROWSER ONE. It mounts
 * exactly what `src/pages/image-peer/main.ts` mounts —
 * `createImagesEndpoint` behind `IMAGES_ACCESS_TREE` — and advertises the
 * same `{ id, kind, title }` on its heartbeat. What it does NOT reproduce is
 * the page around that mount (the ServiceWorker edge, the browser transport
 * profile); those are Task 15's, and nothing here claims them.
 *
 * TEST ORDER IS LOAD-BEARING, not incidental. The consumer is revoked in
 * "an admin revokes the member" and is refused everything afterwards, and the
 * provider stops heartbeating in the last test and never comes back — both
 * are one-way transitions of shared mesh state, so every test that needs a
 * live member or a live provider runs before them. Each test says which
 * earlier state it depends on.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { peerIdFromString } from "@libp2p/peer-id";
import type { AccessTree } from "@statewalker/httpeers.core";
import { createMounts, PeerCallError, verifyToken } from "@statewalker/httpeers.core";
import type { FilesApi, ListOptions, ReadOptions } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HEARTBEAT_INTERVAL_MS } from "../../src/browser/join.js";
import { SWEEP_INTERVAL_MS } from "../../src/hub/main.js";
import { loadFixtureImages } from "../../src/services/image-fixtures.node.js";
import { createImagesEndpoint, IMAGES_ACCESS_TREE } from "../../src/services/images.js";
import type { SearchResult } from "../../src/services/search.js";
import { SEARCH_ADVERTISEMENT } from "../../src/services/search.js";
import { loadOrGenerateKey, peerIdOf } from "../../src/setup/keys.js";
import type { Stack, StackPeer } from "./harness.js";
import {
  dialAddr,
  dialableAddr,
  HUB_SEED,
  PRESENCE_TTL_MS,
  RELAY_SEED,
  startStack,
} from "./harness.js";

/**
 * The image provider's advertisement — the same three fields
 * `src/pages/image-peer/main.ts` posts, and `kind` is what a consumer
 * filters the mesh view on. Never a peer id.
 */
const IMAGES_ADVERTISEMENT = { id: "images", kind: "images", title: "Images" } as const;

/** Bytes per `files.read` call on the provider. Small enough that a ~370-byte fixture PNG is served in several chunks. */
const PROVIDER_CHUNK_SIZE = 64;

/** How long the provider stalls before yielding each chunk — the send window the streaming assertion measures against. */
const PROVIDER_CHUNK_DELAY_MS = 40;

/** A peer that serves nothing: deny by default and no exception. The consumer, the admin and the outsider all run this. */
const SERVES_NOTHING: AccessTree = { "/": { anyOf: [] } };

/**
 * Wraps a `FilesApi` so every chunk it yields is stalled by `delayMs` and its
 * departure time recorded. `files` is the seam `src/services/images.ts`'s own
 * module comment names ("THE SEAM"), so instrumenting it changes nothing
 * about the handler under test — the provider still drives the same
 * `ReadableStream` over the same windowed reads.
 *
 * The stall is what gives the streaming assertion something to measure: with
 * chunks produced instantaneously, "the first chunk arrived before the last
 * one was sent" is true of a buffering transport too, purely by clock
 * resolution.
 */
function instrumentedFiles(inner: FilesApi, sentAt: number[], delayMs: number): FilesApi {
  return {
    async *read(path: string, options?: ReadOptions) {
      for await (const part of inner.read(path, options)) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        sentAt.push(performance.now());
        yield part;
      }
    },
    write: (path, content) => inner.write(path, content),
    mkdir: (path: string) => inner.mkdir(path),
    list: (path: string, options?: ListOptions) => inner.list(path, options),
    stats: (path: string) => inner.stats(path),
    exists: (path: string) => inner.exists(path),
    remove: (path: string) => inner.remove(path),
    move: (source: string, target: string) => inner.move(source, target),
    copy: (source: string, target: string) => inner.copy(source, target),
  };
}

/** Reads a response body through its stream reader, recording the size and arrival time of every chunk. `.arrayBuffer()` would hide both. */
async function drainTimed(
  res: Response,
): Promise<{ bytes: Uint8Array; chunkSizes: number[]; arrivedAt: number[] }> {
  const reader = res.body!.getReader();
  const parts: Uint8Array[] = [];
  const chunkSizes: number[] = [];
  const arrivedAt: number[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    arrivedAt.push(performance.now());
    parts.push(value);
    chunkSizes.push(value.length);
  }
  const bytes = new Uint8Array(chunkSizes.reduce((a, b) => a + b, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return { bytes, chunkSizes, arrivedAt };
}

/**
 * Wait until `check` returns true, polling every 50 ms.
 *
 * THIS IS NOT A CALL TIMEOUT, and must not become one. T-2 owns the only
 * bound on a peer call (`DEFAULT_REQUEST_TIMEOUT_MS`, 8 s, set in
 * `transport-duplex.ts`) and nothing in this suite adds a second one. What
 * this bounds is a wait for MESH STATE to change — a sweep to run, a
 * revocation to land — which is a property of the hub's own timers, not of
 * any request. Every call made inside `check` still carries T-2's timeout,
 * unmodified.
 */
async function waitForMeshState(
  label: string,
  budgetMs: number,
  check: () => Promise<boolean>,
): Promise<number> {
  const startedAt = performance.now();
  for (;;) {
    if (await check()) return performance.now() - startedAt;
    const elapsed = performance.now() - startedAt;
    if (elapsed > budgetMs) {
      throw new Error(
        `${label}: still not true after ${elapsed.toFixed(0)}ms (budget ${budgetMs}ms)`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

let stack: Stack;
let provider: StackPeer;
let consumer: StackPeer;
let admin: StackPeer;
/** A member of the mesh holding NO roles, and therefore no capabilities at all — the "peer without `app:images.read`" of the brief's fourth assertion. */
let outsider: StackPeer;

/** Send timestamps recorded by the provider's instrumented `files`, reset by the streaming test before it reads. */
const providerSentAt: number[] = [];

/** Populated in the discovery test, from the mesh view and nowhere else. */
let discoveredImagesPeerId: string | undefined;
let discoveredImagesAddr: string | undefined;
let discoveredSearchPeerId: string | undefined;

beforeAll(async () => {
  stack = await startStack();

  const { initialFiles, images } = loadFixtureImages();
  const files = instrumentedFiles(
    new MemFilesApi({ initialFiles }),
    providerSentAt,
    PROVIDER_CHUNK_DELAY_MS,
  );
  const mounts = createMounts();
  mounts.provide(
    "/images",
    createImagesEndpoint({ files, images, chunkSize: PROVIDER_CHUNK_SIZE }),
  );

  provider = await stack.join({ roles: ["member"], accessTree: IMAGES_ACCESS_TREE, mounts });
  consumer = await stack.join({ roles: ["member"], accessTree: SERVES_NOTHING });
  admin = await stack.join({ roles: ["admin"], accessTree: SERVES_NOTHING });
  outsider = await stack.join({ roles: [], accessTree: SERVES_NOTHING });

  // One explicit beat each before any timer starts, so the mesh view is
  // populated deterministically by the time the first test reads it rather
  // than one interval later.
  await provider.beat([IMAGES_ADVERTISEMENT]);
  await consumer.beat();
  await admin.beat();

  provider.startBeating([IMAGES_ADVERTISEMENT]);
  consumer.startBeating();
  admin.startBeating();
}, 60_000);

afterAll(async () => {
  await stack?.stop();
});

describe("Task 14: a Node consumer over the real relay + hub", () => {
  it("the relay and the hub run at exactly the identities their seeds derive to", async () => {
    // The deployment's own idempotence contract (`setup/keys.ts`): the same
    // seed always derives the same peerId, which is what lets `httpeers.json`
    // name a hub as a constant. Re-derived here into a THROWAWAY directory,
    // so this compares the running processes against the seeds rather than
    // against the key files they happen to have loaded.
    const dir = mkdtempSync(join(tmpdir(), "httpeers-seed-check-"));
    try {
      const relayAgain = await loadOrGenerateKey({
        keyPath: join(dir, "relay.key"),
        seed: RELAY_SEED,
      });
      const hubAgain = await loadOrGenerateKey({ keyPath: join(dir, "hub.key"), seed: HUB_SEED });
      expect(peerIdOf(relayAgain)).toBe(stack.relayPeerId);
      expect(peerIdOf(hubAgain)).toBe(stack.hubPeerId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // And the relay really is the peer everyone dialed: its own address
    // carries that identity, which is what a browser would be handed.
    expect(stack.relayAddr).toContain(stack.relayPeerId);
  });

  it("a fresh peer redeems an invitation, receives a usable token, and appears in the mesh view", async () => {
    const claims = await verifyToken(consumer.token, {
      issuer: stack.hubPeerId,
      connectionPeer: consumer.peerId,
    });
    expect(claims?.sub).toBe(consumer.peerId); // bound to the CONNECTED peer, not to anything the peer claimed
    expect(claims?.mesh).toBe(stack.hubPeerId);
    expect(claims?.roles).toEqual(["member"]);

    const view = await stack.meshView(consumer);
    const me = view?.members.find((m) => m.peerId === consumer.peerId);
    expect(me).toBeDefined();
    expect(me?.online).toBe(true);
    // The addresses this peer reported are its RELAYED ones -- the reservation
    // the relay granted is real, and it is what reaches other peers through
    // the view. A browser peer's entry has exactly this shape.
    expect(me?.addrs.some((addr) => addr.includes("p2p-circuit"))).toBe(true);
    expect(consumer.circuitAddr).toContain(stack.relayPeerId);
  });

  it("discovers BOTH providers by kind, holding no provider peer id of its own", async () => {
    const view = await stack.meshView(consumer);
    expect(view).not.toBeNull();

    const images = view?.advertisements.find((ad) => ad.kind === "images");
    const search = view?.advertisements.find((ad) => ad.kind === SEARCH_ADVERTISEMENT.kind);
    expect(images).toBeDefined();
    expect(search).toBeDefined();
    expect(images?.title).toBe(IMAGES_ADVERTISEMENT.title);
    expect(search?.title).toBe(SEARCH_ADVERTISEMENT.title);

    // The discovery is real: the ids resolved out of the view are the actual
    // providers, and the image one is NOT the hub -- a view that echoed the
    // hub for everything would satisfy a weaker assertion.
    expect(images?.peerId).toBe(provider.peerId);
    expect(search?.peerId).toBe(stack.hubPeerId);
    expect(images?.peerId).not.toBe(stack.hubPeerId);

    // POSITIVE, MECHANICAL FORM OF "no peer id supplied" (acceptance criterion
    // 4): every value this consumer was configured with, serialised, contains
    // the hub's peer id -- legitimately, it is the mesh identity -- and does
    // NOT contain the image provider's anywhere. So the id used below can
    // only have come from the view.
    expect(consumer.configuration).toContain(stack.hubPeerId);
    expect(consumer.configuration).not.toContain(provider.peerId);

    const member = view?.members.find((m) => m.peerId === images?.peerId);
    expect(member?.addrs.length).toBeGreaterThan(0);

    discoveredImagesPeerId = images?.peerId;
    discoveredImagesAddr = dialableAddr(member?.addrs ?? []);
    discoveredSearchPeerId = search?.peerId;
  });

  it("search returns fixture results, with non-latin1 text intact in the BODY", async () => {
    // Depends on: the discovery test, for `discoveredSearchPeerId`.
    expect(discoveredSearchPeerId).toBeDefined();

    const res = await consumer.call(discoveredSearchPeerId!, "/search?q=relay", {
      token: consumer.token,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: SearchResult[] };
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results.map((r) => r.id)).toContain("fx-1");
    expect(body.results[0]?.title).toBe("The relay is not a service");

    // The fixture set deliberately carries an é and an emoji. They arrive
    // intact because results travel in the body; a header value is latin1 by
    // specification and would have thrown or mangled them before the wire.
    const wide = await consumer.call(discoveredSearchPeerId!, "/search?q=body", {
      token: consumer.token,
    });
    const wideBody = (await wide.json()) as { results: SearchResult[] };
    expect(wideBody.results.some((r) => /🔍/u.test(r.title))).toBe(true);
    expect([...wide.headers.keys()].some((k) => /title|result|snippet/i.test(k))).toBe(false);
  });

  it("a peer without app:images.read gets 403, and the tree's own reason arrives in the body", async () => {
    // Depends on: the discovery test, for the provider's address.
    expect(discoveredImagesAddr).toBeDefined();
    await dialAddr(outsider, discoveredImagesAddr!);

    const res = await outsider.call(discoveredImagesPeerId!, "/images", {
      token: outsider.token,
    });
    expect(res.status).toBe(403);

    // Verbatim from `withAccessTree`'s own decision -- `access-tree.ts`
    // composes `requires one of: <capabilities>` and `hub/endpoints.ts`-style
    // handlers put it in `{ error }`. Asserted exactly, not by regex on a
    // fragment: a denial that stopped naming the capability it wants would
    // still pass a looser check.
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("requires one of: app:images.read");

    // And it arrives as a BODY, not as a header -- the rule this stack has
    // broken before. No response header carries the reason.
    for (const [, value] of res.headers) expect(value).not.toContain("app:images.read");

    // The counterfactual, so the 403 is known to be about the capability and
    // not about the transport, the address or the peer: the same call from a
    // peer that HAS the capability succeeds.
    await dialAddr(consumer, discoveredImagesAddr!);
    const allowed = await consumer.call(discoveredImagesPeerId!, "/images", {
      token: consumer.token,
    });
    expect(allowed.status).toBe(200);
  });

  it("TASK 20: the hub advertises a /p2p-circuit address -- it holds a real reservation on the relay", async () => {
    // The acceptance signal Task 20 exists for, in its weakest necessary
    // form. Before it, `startHub` built its node through `httpeers.core`'s
    // `createNode` (transports: `[tcp()]`), so the hub's only address was
    // `/ip4/127.0.0.1/tcp/<ephemeral>` and no browser could reach it at all.
    const addrs = stack.hub.peer.addrs();
    const circuit = addrs.filter((addr) => addr.includes("p2p-circuit"));
    expect(circuit.length).toBeGreaterThan(0);

    // The reservation is on THIS deployment's relay and is FOR the hub --
    // not some other relay, and not some other peer's slot.
    for (const addr of circuit) {
      expect(addr).toContain(stack.relayPeerId);
      expect(addr).toContain(stack.hubPeerId);
    }

    // One of them carries the `/webrtc` suffix: that is the address
    // `src/browser/join.ts`'s `preDialPeer` resolves to, and the next test
    // pins that a bare circuit address without it does not work.
    expect(circuit.some((addr) => addr.includes("/webrtc"))).toBe(true);

    // `startHub` RETURNED it, which is the part that matters for ordering:
    // the address was present before `startHub` resolved, so a page that
    // reads httpeers.json and dials immediately cannot race the bootstrap.
    expect(stack.hubCircuitAddr).toBeDefined();
    expect(circuit).toContain(stack.hubCircuitAddr);

    // The direct TCP address is still there -- Node peers (every other test
    // in this file) still reach the hub that way.
    expect(addrs.some((addr) => addr.startsWith("/ip4/127.0.0.1/tcp/"))).toBe(true);
  });

  it("TASK 20: a peer that reaches the hub the way a BROWSER does -- over the relay, upgraded to WebRTC -- completes a real /httpeers/1.0.0 call", async () => {
    // The strong form, and the one that would have caught the gap: this peer
    // is given the hub's address by no route at all. It dials
    // `<relay>/p2p-circuit/webrtc/p2p/<hub>` through `src/browser/join.ts`'s
    // OWN `preDialPeer` -- the production function, unmodified -- and then
    // redeems an invitation over that connection, which is an
    // `/httpeers/1.0.0` request and nothing weaker.
    const browserShaped = await stack.join({
      roles: ["member"],
      accessTree: SERVES_NOTHING,
      hubDial: "webrtc",
    });

    // `stack.join` already redeemed an invitation over this connection; a
    // token that verifies against the hub is proof the protocol stream
    // opened, was served, and came back.
    const claims = await verifyToken(browserShaped.token, {
      issuer: stack.hubPeerId,
      connectionPeer: browserShaped.peerId,
    });
    expect(claims?.sub).toBe(browserShaped.peerId);

    // AND the connection it rode really is the relayed, WebRTC-upgraded one
    // -- not a TCP fallback libp2p found on its own. Asserted on the live
    // connection rather than inferred from the dial having succeeded.
    const conns = browserShaped.libp2p.getConnections(peerIdFromString(stack.hubPeerId));
    const webrtc = conns.filter((conn) => conn.remoteAddr.toString().includes("/webrtc"));
    expect(webrtc.length).toBeGreaterThan(0);
    for (const conn of webrtc) {
      expect(conn.remoteAddr.toString()).toContain("p2p-circuit");
      // NOT a limited connection -- the whole point of the upgrade. The next
      // test shows what happens without it. Nullish rather than strictly
      // `undefined`: libp2p's own type is `limits?: ConnectionLimits`, and
      // whether an unlimited connection carries `undefined` or `null` is its
      // business, not this assertion's.
      expect(conn.limits ?? null).toBeNull();
    }

    // And a second, ordinary mesh call over the same connection, so this is
    // not a one-shot bootstrap path that happens to work once.
    const res = await browserShaped.call(stack.hubPeerId, "/.well-known/mesh", {
      token: browserShaped.token,
    });
    expect(res.status).toBe(200);
    console.log(
      `[task-20] browser-shaped hub dial: ${webrtc[0]?.remoteAddr.toString()} (limits: ${String(
        webrtc[0]?.limits,
      )})`,
    );
  }, 30_000);

  it("an httpeers call over a bare /p2p-circuit connection is refused by libp2p itself -- why the browser leg needs the WebRTC upgrade", async () => {
    // NOT a wish-list item: this pins the reason `src/browser/join.ts`'s
    // `preDialPeer` dials `/p2p-circuit/webrtc/p2p/<peer>` rather than
    // `/p2p-circuit/p2p/<peer>`. A relayed connection is a LIMITED connection,
    // and libp2p refuses to open a protocol stream on one. Task 15's browsers
    // complete the upgrade; Node here cannot (see `harness.ts`).
    const circuitOnly = await stack.join({ roles: ["member"], accessTree: SERVES_NOTHING });
    await dialAddr(circuitOnly, `${stack.relayAddr}/p2p-circuit/p2p/${provider.peerId}`);

    await expect(
      circuitOnly.call(provider.peerId, "/images", { token: circuitOnly.token }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof PeerCallError && /limited connection/i.test((err as Error).message),
      "a PeerCallError naming the limited connection",
    );
  });

  it("STREAMS: the image body arrives in more than one chunk, and EVERY chunk lands before the next one is sent", async () => {
    // Depends on: the denial test, which dialed the provider from `consumer`.
    providerSentAt.length = 0;

    const res = await consumer.call(discoveredImagesPeerId!, "/images/relay-node", {
      token: consumer.token,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");

    const { bytes, chunkSizes, arrivedAt } = await drainTimed(res);
    expect(bytes.length).toBe(Number(res.headers.get("content-length")));
    expect(chunkSizes.length).toBeGreaterThan(1);

    // The provider really did window its reads rather than hand back the file
    // in one piece. Deliberately NOT `providerSentAt.length === chunkSizes.length`:
    // whether the consumer's reader coalesces two frames into one `read()` is
    // the platform's business, and this test has no opinion about it.
    expect(providerSentAt.length).toBeGreaterThan(1);

    // COUNTING CHUNKS IS NOT ENOUGH, which is why this test measures, and
    // comparing only the FIRST arrival against the LAST send is not enough
    // either: a transport that streamed the opening chunks and then buffered
    // the rest would pass that. This is the pairwise form — every arrival must
    // beat the send of the first chunk it does NOT yet hold.
    //
    // `nextSend` is derived from bytes actually delivered rather than from a
    // chunk index, so it stays correct if the reader coalesces: the provider
    // windows reads at exactly `PROVIDER_CHUNK_SIZE`, so having `delivered`
    // bytes in hand means having exactly the first `ceil(delivered/CHUNK)`
    // sends, and the next one after that is the send this arrival must have
    // beaten. A buffering transport fails at the first arrival whose
    // successor send is still in the future; a half-buffering one fails at the
    // arrival where it started buffering.
    let delivered = 0;
    let comparisons = 0;
    for (let i = 0; i < chunkSizes.length; i++) {
      delivered += chunkSizes[i]!;
      const nextSend = Math.ceil(delivered / PROVIDER_CHUNK_SIZE);
      if (nextSend >= providerSentAt.length) break; // nothing left of the body to have beaten
      expect(arrivedAt[i]!).toBeLessThan(providerSentAt[nextSend]!);
      comparisons += 1;
    }
    // Guards against the loop passing vacuously (e.g. a single-chunk body, or
    // a fixture small enough that the first arrival already holds everything).
    expect(comparisons).toBeGreaterThan(1);

    // The headline number, kept because it is what the report quotes: how much
    // of the provider's whole send window the transport actually resolved.
    const firstArrival = arrivedAt[0]!;
    const lastSend = providerSentAt[providerSentAt.length - 1]!;
    const marginMs = lastSend - firstArrival;
    expect(marginMs).toBeGreaterThan(PROVIDER_CHUNK_DELAY_MS);
    console.log(
      `[task-14] streaming: ${chunkSizes.length} chunks, ${comparisons} pairwise arrival<send checks; ` +
        `first arrival ${marginMs.toFixed(1)}ms before last send ` +
        `(send window ${(lastSend - providerSentAt[0]!).toFixed(1)}ms)`,
    );
  });

  it("an admin revokes the member, and its very next search fails -- well inside one heartbeat", async () => {
    // Depends on: everything above; the consumer is a working member until
    // this line and is refused everything after it.
    //
    // The consumer's own heartbeat timer is stopped FIRST so the measurement
    // below is of the revocation, not of a beat that happened to be in
    // flight: a beat that lands before the revoke would hand the consumer a
    // fresh token, and one that lands after would fail on its own.
    consumer.stopBeating();

    const before = await consumer.call(stack.hubPeerId, "/search?q=relay", {
      token: consumer.token,
    });
    expect(before.status).toBe(200); // the counterfactual: search works right up to the revocation

    const revoke = await admin.call(stack.hubPeerId, `/admin/members/${consumer.peerId}`, {
      method: "DELETE",
      token: admin.token,
    });
    expect(revoke.status).toBe(200);
    const revokedAt = performance.now();

    // THE VERY NEXT SEARCH, not "a search eventually" -- the hub enforces
    // against its own live `RevocationRegistry` (`hub/main.ts` passes it as
    // `revocationCache`), so there is nothing to propagate and no window.
    const after = await consumer.call(stack.hubPeerId, "/search?q=relay", {
      token: consumer.token,
    });
    const latencyMs = performance.now() - revokedAt;
    expect(after.status).toBe(403);

    // "Within one heartbeat" is the bound the design record sets; the real
    // number is orders of magnitude below it, and is recorded rather than
    // merely bounded.
    expect(latencyMs).toBeLessThan(HEARTBEAT_INTERVAL_MS);
    console.log(
      `[task-14] revocation: next search refused ${latencyMs.toFixed(1)}ms after the admin's DELETE ` +
        `(bound: one heartbeat = ${HEARTBEAT_INTERVAL_MS}ms)`,
    );

    // The revocation is the mesh's, not one route's: the same token is
    // refused on the hub's other surfaces too.
    const mesh = await consumer.call(stack.hubPeerId, "/.well-known/mesh", {
      token: consumer.token,
    });
    expect(mesh.status).toBe(403);
  });

  it("a provider that stops heartbeating leaves the mesh view within one TTL", async () => {
    // Depends on: the revocation test only in that the consumer can no longer
    // read the view -- the observer here is the admin, still a member.
    const stillThere = await stack.meshView(admin);
    expect(stillThere?.advertisements.some((ad) => ad.kind === "images")).toBe(true);

    provider.stopBeating();

    // THE BOUND IS THE HUB'S OWN TWO TIMERS, and deliberately little more:
    // an entry can sit up to one TTL stale before the next sweep notices it,
    // so `PRESENCE_TTL_MS + SWEEP_INTERVAL_MS` is the real ceiling and the
    // extra 500 ms is poll granularity plus round trips, not head-room for a
    // regression to hide in. `waitForMeshState` throws when it is exceeded --
    // that IS the upper-bound assertion, which is why none is repeated below.
    // Not a call timeout; see `waitForMeshState`.
    const budgetMs = PRESENCE_TTL_MS + SWEEP_INTERVAL_MS + 500;
    const elapsedMs = await waitForMeshState("provider leaves the view", budgetMs, async () => {
      const view = await stack.meshView(admin);
      return view?.advertisements.some((ad) => ad.kind === "images") === false;
    });
    // Measured from the last heartbeat the hub actually accepted, not from
    // `stopBeating()` -- the two differ by up to one beat interval, and only
    // the former is the instant the TTL last restarted.
    const sinceLastBeatMs = performance.now() - provider.lastBeatAt;

    const view = await stack.meshView(admin);
    expect(view?.advertisements.some((ad) => ad.kind === "images")).toBe(false);
    // Still a MEMBER -- going quiet is not being removed from the mesh; only
    // its presence and the advertisements that rode on it are gone.
    const member = view?.members.find((m) => m.peerId === provider.peerId);
    expect(member).toBeDefined();
    expect(member?.online).toBe(false);

    // THE LOWER BOUND, which the helper does not check: a peer may not be
    // swept BEFORE its TTL has run out. A hub that dropped presence eagerly --
    // or that ignored `presenceTtlMs` entirely -- would evict the provider
    // sooner than this and fail here, while still satisfying every
    // "within one TTL" assertion above.
    expect(sinceLastBeatMs).toBeGreaterThanOrEqual(PRESENCE_TTL_MS);
    console.log(
      `[task-14] presence sweep: provider left the view ${sinceLastBeatMs.toFixed(0)}ms after its last accepted heartbeat ` +
        `(${elapsedMs.toFixed(0)}ms after it stopped beating); TTL ${PRESENCE_TTL_MS}ms + sweep ${SWEEP_INTERVAL_MS}ms, budget ${budgetMs}ms`,
    );
  }, 20_000);
});
