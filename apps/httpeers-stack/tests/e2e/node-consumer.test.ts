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
    const claims = await verifyToken(consumer.token, { issuer: stack.hubPeerId });
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

  it("STREAMS: the image body arrives in more than one chunk, and the first chunk lands before the last is sent", async () => {
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

    // COUNTING CHUNKS IS NOT ENOUGH, which is why this test measures. A
    // transport that buffered the whole body and re-sliced it on the way out
    // would still deliver several chunks; what it could not do is deliver the
    // FIRST one before the provider had finished producing the LAST. The
    // provider stalls `PROVIDER_CHUNK_DELAY_MS` per chunk, so a buffering
    // transport's first arrival necessarily lands after the final send.
    const firstArrival = arrivedAt[0]!;
    const lastSend = providerSentAt[providerSentAt.length - 1]!;
    expect(providerSentAt.length).toBe(chunkSizes.length);
    expect(firstArrival).toBeLessThan(lastSend);

    const marginMs = lastSend - firstArrival;
    // The margin cannot exceed the send window, and a real streaming
    // transport resolves most of it: assert at least one whole chunk delay's
    // worth, so a transport that streamed only the final chunk early would
    // still fail.
    expect(marginMs).toBeGreaterThan(PROVIDER_CHUNK_DELAY_MS);
    console.log(
      `[task-14] streaming: ${chunkSizes.length} chunks, first arrival ${marginMs.toFixed(1)}ms before last send ` +
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
    const stoppedAt = performance.now();

    // The budget is the hub's own two timers, plus slack for the poll itself:
    // an entry may be up to one TTL stale before the next sweep notices it.
    // Not a call timeout -- see `waitForMeshState`.
    const budgetMs = PRESENCE_TTL_MS + SWEEP_INTERVAL_MS + 2_000;
    const elapsedMs = await waitForMeshState("provider leaves the view", budgetMs, async () => {
      const view = await stack.meshView(admin);
      return view?.advertisements.some((ad) => ad.kind === "images") === false;
    });

    const view = await stack.meshView(admin);
    expect(view?.advertisements.some((ad) => ad.kind === "images")).toBe(false);
    // Still a MEMBER -- going quiet is not being removed from the mesh; only
    // its presence and the advertisements that rode on it are gone.
    const member = view?.members.find((m) => m.peerId === provider.peerId);
    expect(member).toBeDefined();
    expect(member?.online).toBe(false);

    expect(elapsedMs).toBeLessThan(budgetMs);
    console.log(
      `[task-14] presence sweep: provider left the view ${elapsedMs.toFixed(0)}ms after its last heartbeat ` +
        `(TTL ${PRESENCE_TTL_MS}ms + sweep ${SWEEP_INTERVAL_MS}ms); measured from ${stoppedAt.toFixed(0)}`,
    );
  }, 20_000);
});
