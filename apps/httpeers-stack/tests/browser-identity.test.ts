/**
 * `src/browser/identity.ts`'s key handling -- the half of it that is pure
 * codec and needs no IndexedDB.
 *
 * WHAT THIS SUITE EXISTS TO PIN, and it is not a formality. The hub page's
 * peerId IS the mesh (`claims.mesh === claims.iss`), and the hub page
 * derives it from a key round-tripped through IndexedDB in a format chosen
 * to match the one `pnpm bootstrap` writes to `.httpeers/hub.key`
 * (`src/setup/keys.ts`). "Chosen to match" is a claim, and an unverified
 * one would be worth nothing: if the two encodings diverged, a hub page and
 * a Node hub built from the same key bytes would be DIFFERENT meshes, and
 * the only symptom would be tokens that mysteriously fail to verify. These
 * tests compare the two paths directly rather than trusting the comment.
 *
 * SINCE TASK 28 THE STORE ITSELF IS COVERED TOO, over the injected bytes
 * backend `src/browser/kv.ts` declares. The three facts the consumer pages'
 * whole resume story rests on -- a first run has no key, a second run gets
 * the SAME peerId back, and after a reset the next run is a different peer
 * -- were previously unreachable from Node because `idb-keyval` needs a
 * real IndexedDB. Only `idbBytesBackend()`'s three one-line delegations
 * still do; nothing else in that module does.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToProtobuf } from "@libp2p/crypto/keys";
import { generateMeshKey } from "@statewalker/httpeers.core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearIdentity,
  decodeIdentity,
  encodeIdentity,
  IDENTITY_STORAGE_KEY,
  loadOrCreateIdentity,
  peerIdOf,
  readIdentity,
} from "../src/browser/identity.js";
import type { AsyncBytesBackend } from "../src/browser/kv.js";
import { loadOrGenerateKey, peerIdOf as nodePeerIdOf } from "../src/setup/keys.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "httpeers-identity-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the browser identity codec", () => {
  it("round-trips a key without changing the peerId it derives to", async () => {
    const key = await generateMeshKey();
    const restored = decodeIdentity(encodeIdentity(key));

    expect(peerIdOf(restored)).toBe(peerIdOf(key));
    expect(restored.type).toBe("Ed25519");
  });

  it("produces the same bytes `pnpm bootstrap` writes to a key file", async () => {
    // The Node side, through its own code path: generate + persist.
    const keyPath = join(dir, "hub.key");
    const nodeKey = await loadOrGenerateKey({ keyPath, seed: "task-24-fixture" });
    const onDisk = readFileSync(keyPath);

    // The browser side's encoder, given the very same key.
    expect(Buffer.from(encodeIdentity(nodeKey))).toEqual(onDisk);
  });

  it("derives the same peerId the Node path derives -- so the hub page and the Node hub would be the same mesh", async () => {
    const keyPath = join(dir, "hub.key");
    const nodeKey = await loadOrGenerateKey({ keyPath, seed: "task-24-fixture" });

    // Take the key back out of storage the way the browser would -- from
    // bytes -- and derive its peerId with the browser's own function.
    const fromStorage = decodeIdentity(readFileSync(keyPath));

    expect(peerIdOf(fromStorage)).toBe(nodePeerIdOf(nodeKey));
  });

  it("refuses a key that is not Ed25519, naming the storage key", async () => {
    // An RSA key encoded the same way -- what a stored value from some other
    // application, or a much older one of this, could look like. Only the
    // shape of the failure matters: it must be legible, and it must not be
    // a peerId derived from a key this mesh cannot use.
    const { generateKeyPair } = await import("@libp2p/crypto/keys");
    const rsa = await generateKeyPair("RSA", 512);

    expect(() => decodeIdentity(privateKeyToProtobuf(rsa))).toThrow(/only Ed25519 is supported/);
    expect(() => decodeIdentity(privateKeyToProtobuf(rsa))).toThrow(/httpeers:identity-key/);
  });
});

// --- the store, over an injected backend ---------------------------------

/** IndexedDB's bytes seam over a `Map` -- see `src/browser/kv.ts`. */
function memoryBytes(values = new Map<string, Uint8Array>()): {
  values: Map<string, Uint8Array>;
  backend: AsyncBytesBackend;
} {
  return {
    values,
    backend: {
      get: async (key) => values.get(key),
      set: async (key, value) => {
        values.set(key, value);
      },
      del: async (key) => {
        values.delete(key);
      },
    },
  };
}

describe("the identity store", () => {
  it("a first run holds nothing, and reading does not create anything", async () => {
    const { values, backend } = memoryBytes();

    expect(await readIdentity({ backend })).toBeNull();
    // The distinction requirement 3 rests on: "never joined" must stay
    // "never joined" until the page actually joins, or every later load
    // would report an identity this browser has never used.
    expect(values.size).toBe(0);
  });

  it("the second run gets the same peerId back", async () => {
    const { backend } = memoryBytes();

    const first = await loadOrCreateIdentity({ backend });
    const second = await loadOrCreateIdentity({ backend });

    expect(peerIdOf(second)).toBe(peerIdOf(first));
    // And a plain read agrees -- this is what `startBrowserPeer` is handed.
    expect(peerIdOf((await readIdentity({ backend }))!)).toBe(peerIdOf(first));
  });

  it("stores the key at the documented storage key, in the protobuf format the Node side uses", async () => {
    const { values, backend } = memoryBytes();

    const key = await loadOrCreateIdentity({ backend });

    const stored = values.get(IDENTITY_STORAGE_KEY);
    expect(stored).toBeDefined();
    expect(peerIdOf(decodeIdentity(stored!))).toBe(peerIdOf(key));
  });

  it("after a reset the next run is a DIFFERENT peer -- which is what makes it a reset and not a disconnect", async () => {
    const { backend } = memoryBytes();

    const before = await loadOrCreateIdentity({ backend });
    await clearIdentity({ backend });

    expect(await readIdentity({ backend })).toBeNull();
    expect(peerIdOf(await loadOrCreateIdentity({ backend }))).not.toBe(peerIdOf(before));
  });
});
