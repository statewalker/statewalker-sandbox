/**
 * Task 12: `GET /images` / `GET /images/{id}` and the image peer's own
 * policy.
 *
 * WHAT THIS FILE PROVES UNDER NODE, AND WHY THAT IS THE RIGHT BOUNDARY.
 * `createImagesEndpoint`/`IMAGES_ACCESS_TREE` (`src/services/images.ts`)
 * are ordinary `(Request) => Promise<Response>` code plus a plain data
 * structure -- no browser API anywhere in either. Wired through a real
 * `createPeer` (no libp2p networking needed: every request here goes
 * through `peer.dispatch` directly, exactly like `search.test.ts`/
 * `admin.test.ts` already do), this suite exercises the full request path
 * a remote peer's `peer.call` would take -- transport-duplex binding,
 * `withPolicy`, the router, this service's own handler -- with nothing
 * faked. It also proves the one property the brief calls out specifically:
 * a streamed response arrives in MORE THAN ONE CHUNK, not merely that the
 * bytes are correct (a buffering implementation would pass a bytes-only
 * assertion).
 *
 * WHAT IS GENUINELY OUT OF REACH HERE, AND LEFT TO TASK 15's PLAYWRIGHT
 * SUITE: whether a real ServiceWorker actually intercepts a same-origin
 * `fetch()` for this page (`../src/browser/edge.ts`'s `mountEdge`, already
 * covered structurally by `browser-edge-guard.test.ts`, not re-proven
 * here); whether the stream observed here actually survives a real WebRTC
 * hop between two browser tabs (design note 20 proved the MECHANISM once,
 * generically -- this suite proves THIS handler drives a multi-chunk
 * `ReadableStream` correctly, which is a precondition for that proof to
 * mean anything for this specific service, not a repeat of it); and
 * whether `src/pages/image-peer/main.ts`'s fixture loader
 * (`fetch()`-based, browser-only) actually retrieves the right bytes from
 * a built bundle. None of those need a browser to be FALSE -- only to be
 * CONFIRMED true -- so none of them are claimed here.
 */
import {
  createMounts,
  createPeer,
  type MountsFactoryContext,
  registerPeer,
} from "@statewalker/httpeers.core";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { loadFixtureImages } from "../src/services/image-fixtures.node.js";
import {
  createImagesEndpoint,
  DEFAULT_CHUNK_SIZE,
  IMAGES_RULES,
  type ImageInfo,
  imagePath,
} from "../src/services/images.js";

function requestAs(peerId: string, path: string, init: RequestInit = {}): Request {
  const req = new Request(`http://peer${path}`, init);
  registerPeer(req, peerId);
  return req;
}

function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

/** Reads a `Response` body via its stream reader (never `.arrayBuffer()`, which would hide how many chunks it actually arrived in) and returns both the concatenated bytes and the raw per-`read()` chunk sizes observed. */
async function drain(res: Response): Promise<{ bytes: Uint8Array; chunkSizes: number[] }> {
  const reader = res.body!.getReader();
  const parts: Uint8Array[] = [];
  const chunkSizes: number[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    chunkSizes.push(value.length);
  }
  const total = chunkSizes.reduce((a, b) => a + b, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return { bytes, chunkSizes };
}

/** A peer whose ONLY mount is the images service, running its OWN policy (never the hub's) -- see `IMAGES_POLICIES`'s own doc comment for why this is the design's "provider decides who may read" made concrete. `mintToken` is captured off the `mounts` factory context exactly like `hub/main.ts` does for its own endpoints -- this peer trusts tokens it mints itself (`hubPeerId` defaults to its own `peerId`), which is all a self-contained unit test needs; no separate hub process is required to prove the policy. */
async function buildImagesPeer(
  images: ImageInfo[],
  initialFiles: Record<string, Uint8Array>,
  chunkSize?: number,
) {
  let mintToken: MountsFactoryContext["mintToken"] | undefined;
  const files = new MemFilesApi({ initialFiles });
  const peer = await createPeer({
    rules: IMAGES_RULES,
    mounts: (ctx) => {
      mintToken = ctx.mintToken;
      const mounts = createMounts();
      mounts.provide("/images", createImagesEndpoint({ files, images, chunkSize }));
      return mounts;
    },
  });
  return { peer, mintToken: mintToken! };
}

const TINY_IMAGES: ImageInfo[] = [
  { id: "a", title: "First fixture, ascii only", contentType: "image/png", size: 40 },
  { id: "b", title: "Second fixture — café, 🔍", contentType: "image/jpeg", size: 3 },
];

function tinyBytes(n: number, fill: number): Uint8Array {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = (fill + i) % 256;
  return bytes;
}

const TINY_FILES: Record<string, Uint8Array> = {
  [imagePath("a")]: tinyBytes(40, 1),
  [imagePath("b")]: tinyBytes(3, 200),
};

describe("Task 12: GET /images (list)", () => {
  it("lists every fixture's id, title, contentType and size in the body", async () => {
    const { peer, mintToken } = await buildImagesPeer(TINY_IMAGES, TINY_FILES);
    const token = await mintToken("alice", ["member"]);

    const res = await peer.dispatch(requestAs("alice", "/images", { headers: bearer(token) }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await res.json()) as { images: ImageInfo[] };
    expect(body.images).toEqual(TINY_IMAGES);

    await peer.stop();
  });

  it("titles travel in the body, never in a header -- non-latin1 titles do not throw", async () => {
    // If a future change tried to hoist a title into a header instead, the
    // second fixture's em-dash/café/🔍 title would throw constructing the
    // `Headers` object (latin1-only by spec) before this assertion ever ran.
    const { peer, mintToken } = await buildImagesPeer(TINY_IMAGES, TINY_FILES);
    const token = await mintToken("alice", ["member"]);

    const res = await peer.dispatch(requestAs("alice", "/images", { headers: bearer(token) }));
    const body = (await res.json()) as { images: ImageInfo[] };
    expect(body.images.some((i) => /café|🔍/u.test(i.title))).toBe(true);
    expect([...res.headers.keys()].some((k) => k.toLowerCase().includes("title"))).toBe(false);

    await peer.stop();
  });
});

describe("Task 12: GET /images/{id} (streamed bytes)", () => {
  it("serves the exact bytes with the fixture's own content-type", async () => {
    const { peer, mintToken } = await buildImagesPeer(TINY_IMAGES, TINY_FILES);
    const token = await mintToken("alice", ["member"]);

    const res = await peer.dispatch(requestAs("alice", "/images/a", { headers: bearer(token) }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe("40");
    const { bytes } = await drain(res);
    expect(bytes).toEqual(TINY_FILES[imagePath("a")]);

    await peer.stop();
  });

  it("STREAMS -- the body arrives in more than one chunk, not merely with correct bytes", async () => {
    // A buffering implementation (`files.read(path)` with no `length`,
    // handed straight to `new Response`) would pass a bytes-only assertion
    // while still delivering everything in a single chunk. `chunkSize: 6`
    // against a 40-byte fixture forces the handler's own `pull` loop to run
    // multiple times.
    const chunkSize = 6;
    const { peer, mintToken } = await buildImagesPeer(TINY_IMAGES, TINY_FILES, chunkSize);
    const token = await mintToken("alice", ["member"]);

    const res = await peer.dispatch(requestAs("alice", "/images/a", { headers: bearer(token) }));
    const { bytes, chunkSizes } = await drain(res);

    expect(bytes).toEqual(TINY_FILES[imagePath("a")]);
    expect(chunkSizes.length).toBeGreaterThan(1);
    // Every chunk except possibly the last respects the requested bound --
    // proves the handler is actually windowing reads, not just happening to
    // receive multiple chunks from the platform for an unrelated reason.
    for (const size of chunkSizes.slice(0, -1)) expect(size).toBeLessThanOrEqual(chunkSize);
    expect(chunkSizes.reduce((a, b) => a + b, 0)).toBe(40);

    await peer.stop();
  });

  it("a fixture at or under DEFAULT_CHUNK_SIZE still streams correctly (regression guard on the default itself)", async () => {
    const { peer, mintToken } = await buildImagesPeer(TINY_IMAGES, TINY_FILES); // no chunkSize override -> DEFAULT_CHUNK_SIZE
    const token = await mintToken("alice", ["member"]);

    const res = await peer.dispatch(requestAs("alice", "/images/b", { headers: bearer(token) }));
    const { bytes } = await drain(res);
    expect(bytes).toEqual(TINY_FILES[imagePath("b")]);
    expect(DEFAULT_CHUNK_SIZE).toBeGreaterThan(3); // sanity: this fixture really is smaller than one default chunk

    await peer.stop();
  });

  it("an id absent from the catalogue is a 404 at the handler itself, decoupled from policy", async () => {
    // Calls the raw handler directly -- bypasses `createPeer`/`withPolicy`
    // entirely, so this proves the HANDLER's own 404 branch in isolation.
    // (Also reachable through the full peer stack now -- see "an id outside
    // the catalogue" below -- since `IMAGES_POLICIES` grants the whole
    // `/images` subtree, not one leaf per known id; existence-checking is
    // this handler's job, not policy's.)
    const files = new MemFilesApi({ initialFiles: TINY_FILES });
    const handler = createImagesEndpoint({ files, images: TINY_IMAGES });
    const res = await handler(new Request("http://peer/images/does-not-exist"));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/does-not-exist/);
  });
});

describe("Task 12: the provider's own policy -- it decides who may read", () => {
  it("a member (granted app:images.read) reads both the list and an image", async () => {
    const { peer, mintToken } = await buildImagesPeer(TINY_IMAGES, TINY_FILES);
    const token = await mintToken("alice", ["member"]);

    const list = await peer.dispatch(requestAs("alice", "/images", { headers: bearer(token) }));
    const bytes = await peer.dispatch(requestAs("alice", "/images/a", { headers: bearer(token) }));
    expect(list.status).toBe(200);
    expect(bytes.status).toBe(200);

    await peer.stop();
  });

  it("a token with no capability is refused BOTH the list and an image", async () => {
    // `roles: []` -> no capabilities at all under this vocabulary, so this
    // is "denied by policy" (403), never a missing-token 401.
    const { peer, mintToken } = await buildImagesPeer(TINY_IMAGES, TINY_FILES);
    const token = await mintToken("mallory", []);

    const list = await peer.dispatch(requestAs("mallory", "/images", { headers: bearer(token) }));
    const bytes = await peer.dispatch(
      requestAs("mallory", "/images/a", { headers: bearer(token) }),
    );
    expect(list.status).toBe(403);
    expect(((await list.json()) as { error: string }).error).toMatch(/app:images\.read/);
    expect(bytes.status).toBe(403);
    expect(((await bytes.json()) as { error: string }).error).toMatch(/app:images\.read/);

    await peer.stop();
  });

  it("no token at all is a 401, not a 403", async () => {
    const { peer } = await buildImagesPeer(TINY_IMAGES, TINY_FILES);
    const res = await peer.dispatch(requestAs("alice", "/images"));
    expect(res.status).toBe(401);
    await peer.stop();
  });

  it("an id outside the catalogue is a 404 through the full peer stack -- access is granted at the collection level, existence is the handler's job", async () => {
    // Genuinely revised expectation, not carried over from an earlier draft:
    // `IMAGES_POLICIES` grants `/images` and its ENTIRE subtree to any
    // capability holder (the `or` variant in `src/services/images.ts`, which
    // is how Datalog says what the tree's one key said), so a member's
    // request for `/images/does-not-exist` PASSES the access check and
    // reaches this handler, which is the one place that actually knows the
    // catalogue. An earlier version of this app's `.access` tree enumerated
    // one exact leaf per known id specifically to make this case a 403 at the
    // access layer; that workaround is gone (see `src/services/images.ts`'s
    // module comment), and 404 is the more honest answer anyway -- this member IS
    // allowed to ask, the resource just isn't there.
    const { peer, mintToken } = await buildImagesPeer(TINY_IMAGES, TINY_FILES);
    const token = await mintToken("alice", ["member"]);

    const res = await peer.dispatch(
      requestAs("alice", "/images/does-not-exist", { headers: bearer(token) }),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/does-not-exist/);

    await peer.stop();
  });

  it("a path outside /images entirely is denied by the default deny -- this provider serves nothing else", async () => {
    const { peer, mintToken } = await buildImagesPeer(TINY_IMAGES, TINY_FILES);
    const token = await mintToken("alice", ["member"]);

    const res = await peer.dispatch(
      requestAs("alice", "/anything-else", { headers: bearer(token) }),
    );
    expect(res.status).toBe(403);

    await peer.stop();
  });
});

describe("Task 12: the real fixture set (image-fixtures/, loaded off disk)", () => {
  it("loads, lists, and streams every real fixture end to end through the full peer stack", async () => {
    const { initialFiles, images } = loadFixtureImages();
    expect(images.length).toBeGreaterThanOrEqual(3); // brief: "3-4 small images"

    const { peer, mintToken } = await buildImagesPeer(images, initialFiles, 32);
    const token = await mintToken("alice", ["member"]);

    const list = await peer.dispatch(requestAs("alice", "/images", { headers: bearer(token) }));
    expect(list.status).toBe(200);
    const listedIds = ((await list.json()) as { images: ImageInfo[] }).images.map((i) => i.id);
    expect(listedIds).toEqual(images.map((i) => i.id));

    for (const img of images) {
      const res = await peer.dispatch(
        requestAs("alice", `/images/${img.id}`, { headers: bearer(token) }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(img.contentType);
      const { bytes, chunkSizes } = await drain(res);
      expect(bytes).toEqual(initialFiles[imagePath(img.id)]);
      // Every real fixture is well under the 32-byte chunkSize used here, so
      // this also re-confirms multi-chunk delivery against real (not
      // synthetic) image bytes, not just the tiny hand-built fixtures above.
      expect(chunkSizes.length).toBeGreaterThan(1);
    }

    await peer.stop();
  });
});
